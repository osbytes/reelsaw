/**
 * Disk leases: the scratch a job is about to write, claimed against the volume before the first byte lands.
 *
 * `statfs` only sees bytes already written, so two ingests of large videos that both passed the free-space
 * check on the same box could both run out mid-download and both fail. A lease is the claim: the governor
 * (resources.ts `acquire`) checks a job's need against the volume's live leases and records its own in the
 * same transaction, under one advisory lock per volume, so the second job sees the first job's claim and
 * waits for it instead. The stage releases the lease when it ends (StageContext.release; ingest as soon as
 * the source is on disk, where statfs counts it; a render or transcribe that has to pull the source from the
 * store leases that pull the same way). A lease counts while its worker has heartbeated within LEASE_STALE_MS
 * and until it expires after the longest a stage job may run, so a crash or a lost process leaks nothing for
 * long; a process drops its own at boot (a restart under the same id) and once its jobs have stopped at
 * shutdown; the hourly sweep drops the dead rows.
 *
 * A volume is the filesystem DATA_DIR is on. Every process that mounts it (the app and the worker replicas
 * of one host sharing the compose `data` volume) reads the same id from the `.volume-id` marker written
 * once at first boot; a worker on another host has its own and never contends.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, gt, lt, or, sql } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { schema } from "./db/index.js";
import { takeTxLock, txLock } from "./locks.js";
import { MAX_JOB_EXPIRE_SECONDS } from "./queue/boss.js";
import { leaseFits, type DiskLeaser } from "./resources.js";
import type { Services } from "./services.js";

export const VOLUME_MARKER = ".volume-id";

/** A lease outlives no job: the longest any job may be given before pg-boss expires it (queue/boss.ts MAX_JOB_EXPIRE_SECONDS, 24 h). */
export const DISK_LEASE_TTL_MS = MAX_JOB_EXPIRE_SECONDS * 1000;

/**
 * How long a worker may go without a heartbeat before its leases stop counting. Much longer than the 45 s
 * that marks a worker stale for hand-off: a lease is a safety bound on the disk, and a database hiccup or a
 * blocked event loop in one process must not let the others over-commit it while its download goes on. A
 * worker that is really gone holds its claims this long at most (a restart under the same id drops them at boot).
 */
export const LEASE_STALE_MS = 10 * 60_000;

/**
 * The id of the filesystem `dataDir` is on: the marker's content, written once so two processes booting
 * together on the same volume agree on it. The marker appears atomically with its content (written to a temp
 * file, then `link`ed into place, which fails for every process but one), so a reader never sees it empty.
 */
export async function volumeId(dataDir: string): Promise<string> {
  const file = path.join(dataDir, VOLUME_MARKER);
  const read = async () => (await fs.readFile(file, "utf8")).trim();
  const existing = await read().catch(() => "");
  if (existing) return existing;
  const id = randomUUID();
  const tmp = `${file}.${id}`;
  await fs.writeFile(tmp, `${id}\n`);
  try {
    await fs.link(tmp, file);
    return id;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return read();
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/**
 * MB leased on `volume` right now and the jobs holding them: unexpired rows of workers that have heartbeated
 * within `staleMs` (LEASE_STALE_MS), plus this process's own whatever its heartbeat says. `db` may be a transaction.
 */
export async function volumeLeases(db: Pick<Db, "select">, p: { volume: string; selfId: string; staleMs: number; now?: Date }): Promise<{ mb: number; jobs: number }> {
  const now = p.now ?? new Date();
  const [r] = await db
    .select({ mb: sql<number>`coalesce(sum(${schema.diskLeases.mb}), 0)::int`, jobs: sql<number>`count(*)::int` })
    .from(schema.diskLeases)
    .leftJoin(schema.workerInstances, eq(schema.workerInstances.id, schema.diskLeases.workerId))
    .where(and(eq(schema.diskLeases.volume, p.volume), gt(schema.diskLeases.expiresAt, now), or(eq(schema.diskLeases.workerId, p.selfId), gt(schema.workerInstances.lastSeenAt, new Date(now.getTime() - p.staleMs)))));
  return { mb: r?.mb ?? 0, jobs: r?.jobs ?? 0 };
}

/** The shared ledger for the governor: check against the live total and record the claim, as one locked transaction. */
export function createDiskLeaser(svc: Pick<Services, "database" | "log">, p: { volume: string; selfId: string; staleMs: number }): DiskLeaser {
  const log = svc.log.child({ module: "resources" });
  return async (req) =>
    svc.database.db.transaction(async (tx) => {
      await takeTxLock(tx, txLock.diskVolume(p.volume));
      const live = await volumeLeases(tx, p);
      if (!leaseFits({ freeMB: req.freeMB, leasedMB: live.mb, requiredMB: req.requiredMB })) return { ok: false, leasedMB: live.mb, jobs: live.jobs };
      const [row] = await tx
        .insert(schema.diskLeases)
        .values({ volume: p.volume, workerId: p.selfId, jobId: req.jobId ?? null, projectId: req.projectId ?? null, kind: req.kind, mb: req.mb, expiresAt: new Date(Date.now() + DISK_LEASE_TTL_MS) })
        .returning({ id: schema.diskLeases.id });
      log.debug({ kind: req.kind, mb: req.mb, freeMB: req.freeMB, leasedMB: live.mb, jobId: req.jobId, projectId: req.projectId }, "leased disk");
      return {
        ok: true,
        release: async () => {
          await svc.database.db.delete(schema.diskLeases).where(eq(schema.diskLeases.id, row!.id));
        },
      };
    });
}

/** Rows no job can still hold: expired, or of a worker whose heartbeat row is gone. Hourly hygiene; the sum query already ignores them. */
export async function pruneDiskLeases(svc: Pick<Services, "database" | "log">): Promise<number> {
  const gone = svc.database.db.select({ id: schema.workerInstances.id }).from(schema.workerInstances).where(eq(schema.workerInstances.id, schema.diskLeases.workerId));
  const rows = await svc.database.db
    .delete(schema.diskLeases)
    .where(or(lt(schema.diskLeases.expiresAt, new Date()), sql`not exists (${gone})`))
    .returning({ id: schema.diskLeases.id });
  if (rows.length) svc.log.info({ module: "resources", removed: rows.length }, "dropped dead disk leases");
  return rows.length;
}

/** Everything this process leased: on shutdown, with its heartbeat row. */
export async function releaseWorkerLeases(svc: Pick<Services, "database">, selfId: string): Promise<void> {
  await svc.database.db.delete(schema.diskLeases).where(eq(schema.diskLeases.workerId, selfId));
}
