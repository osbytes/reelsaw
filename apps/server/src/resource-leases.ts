/**
 * Resource leases: the scratch disk, cores and memory a job in flight has claimed on its host, checked and
 * recorded in one step so no two jobs pass on the same free capacity (docs/specs/resource-leases.md).
 *
 * `statfs` only sees bytes already written, a CPU or memory reading only shows work that has already started:
 * two jobs that both passed on the same reading could both over-commit the box. A lease is the claim. The
 * governor (resources.ts) hands its request to `createLeaser`, which reads the host's live totals and records
 * the claim in the same transaction, under one advisory lock per volume, so the second job sees the first job's
 * claim. The job releases its lease when it ends (StageContext.release for a stage's disk, `withCpu` for an
 * ffmpeg pass, the render slot when a render job ends). A lease counts while its worker has heartbeated within
 * LEASE_STALE_MS and until it expires after the longest a job may run, so a crash or a lost process leaks
 * nothing for long; a process drops its own at boot (a restart under the same id) and once its jobs have stopped
 * at shutdown; the hourly sweep drops the dead rows.
 *
 * Disk is shared per volume: the filesystem DATA_DIR is on. Every process that mounts it (the app and the worker
 * replicas sharing the compose `data` volume, or pods sharing a network volume) reads the same id from the
 * `.volume-id` marker written once at first boot. Cores and memory are shared per machine (`machineId`, the
 * kernel's boot id): a network volume can span machines, and their cores must not be pooled.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, gt, lt, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { schema } from "./db/index.js";
import { takeTxLock, txLock } from "./locks.js";
import { MAX_JOB_EXPIRE_SECONDS } from "./queue/boss.js";
import { type Entitlements, resourceCeilingOf } from "./quota.js";
import { type AccountLimits, claimOnLive, type HostLeases, type LeaseIds, type Leaser } from "./resources.js";
import type { Services } from "./services.js";

export const VOLUME_MARKER = ".volume-id";

/** A lease outlives no job: the longest any job may be given before pg-boss expires it (queue/boss.ts MAX_JOB_EXPIRE_SECONDS, 24 h). */
export const LEASE_TTL_MS = MAX_JOB_EXPIRE_SECONDS * 1000;

/**
 * How long a worker may go without a heartbeat before its leases stop counting. Much longer than the 45 s
 * that marks a worker stale for hand-off: a lease is a safety bound on the host, and a database hiccup or a
 * blocked event loop in one process must not let the others over-commit it while its work goes on. A
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
 * The machine this process runs on, for the cores and memory it shares. The kernel's boot id is the same in every
 * container of one machine (it is not namespaced) and differs between machines, even when they mount the same
 * network volume: so a k8s or NFS deployment whose workers share DATA_DIR still pools cores per machine, not
 * across them. Without /proc (macOS or Windows outside a container) the hostname stands in.
 */
export async function machineId(read: (file: string) => Promise<string> = (f) => fs.readFile(f, "utf8")): Promise<string> {
  const boot = await read("/proc/sys/kernel/random/boot_id").then(
    (s) => s.trim(),
    () => "",
  );
  return boot ? `boot:${boot}` : `host:${os.hostname()}`;
}

/** Where a process leases: the volume its scratch disk is on, and the machine whose cores and memory it uses. */
interface LeaseScope {
  volume: string;
  machine: string;
}

/**
 * What is leased right now around this process: disk on `volume` (every process mounting it), cores, memory and
 * the kinds that count them (render slots) on `machine` (every process on it). Unexpired rows of workers that have
 * heartbeated within `staleMs` (LEASE_STALE_MS), plus this process's own whatever its heartbeat says.
 * `db` may be a transaction.
 */
export async function hostLeases(db: Pick<Db, "select">, p: LeaseScope & { selfId: string; staleMs: number; now?: Date }): Promise<HostLeases> {
  const now = p.now ?? new Date();
  const t = schema.resourceLeases;
  const rows = await db
    .select({
      kind: t.kind,
      mb: sql<number>`(coalesce(sum(${t.mb}) filter (where ${t.volume} = ${p.volume}), 0))::int`,
      cores: sql<number>`(coalesce(sum(${t.cores}) filter (where ${t.machine} = ${p.machine}), 0))::int`,
      memMB: sql<number>`(coalesce(sum(${t.memMB}) filter (where ${t.machine} = ${p.machine}), 0))::int`,
      jobs: sql<number>`count(*)::int`,
      diskJobs: sql<number>`(count(*) filter (where ${t.volume} = ${p.volume} and ${t.mb} > 0))::int`,
      onMachine: sql<number>`(count(*) filter (where ${t.machine} = ${p.machine}))::int`,
    })
    .from(t)
    .leftJoin(schema.workerInstances, eq(schema.workerInstances.id, t.workerId))
    .where(
      and(
        or(eq(t.volume, p.volume), eq(t.machine, p.machine)),
        gt(t.expiresAt, now),
        or(eq(t.workerId, p.selfId), gt(schema.workerInstances.lastSeenAt, new Date(now.getTime() - p.staleMs))),
      ),
    )
    .groupBy(t.kind);
  const live: HostLeases = { mb: 0, cores: 0, memMB: 0, jobs: 0, diskJobs: 0, kinds: {} };
  for (const r of rows) {
    live.mb += r.mb;
    live.cores += r.cores;
    live.memMB += r.memMB;
    live.jobs += r.jobs;
    live.diskJobs += r.diskJobs;
    if (r.onMachine) live.kinds[r.kind] = r.onMachine;
  }
  return live;
}

/**
 * What one account's live leases hold, summed over every machine: its plan ceiling is the most it may hold at once
 * (docs/specs/resource-leases.md slice 3). The same liveness as `hostLeases`. `db` may be a transaction.
 */
async function accountLeases(
  db: Pick<Db, "select">,
  p: { userId: string; selfId: string; staleMs: number; now?: Date },
): Promise<{ cores: number; memMB: number }> {
  const now = p.now ?? new Date();
  const t = schema.resourceLeases;
  const [row] = await db
    .select({
      cores: sql<number>`(coalesce(sum(${t.cores}), 0))::int`,
      memMB: sql<number>`(coalesce(sum(${t.memMB}), 0))::int`,
    })
    .from(t)
    .leftJoin(schema.workerInstances, eq(schema.workerInstances.id, t.workerId))
    .where(
      and(
        eq(t.userId, p.userId),
        gt(t.expiresAt, now),
        or(eq(t.workerId, p.selfId), gt(schema.workerInstances.lastSeenAt, new Date(now.getTime() - p.staleMs))),
      ),
    );
  return { cores: row?.cores ?? 0, memMB: row?.memMB ?? 0 };
}

/**
 * Whose work a lease is and what bounds that account (EE only): the caller's `userId`, else the project's owner. Null
 * for work that is no one account's, and for admins (like the source-height cap, plans do not bound them).
 */
async function leaseAccount(tx: Db, ent: Entitlements, ids: LeaseIds | undefined): Promise<{ userId: string; limits: AccountLimits | null } | null> {
  let userId = ids?.userId;
  let role: string | undefined;
  if (userId) {
    role = (await tx.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, userId)))[0]?.role;
  } else if (ids?.projectId) {
    const [owner] = await tx
      .select({ userId: schema.projects.userId, role: schema.user.role })
      .from(schema.projects)
      .innerJoin(schema.user, eq(schema.user.id, schema.projects.userId))
      .where(eq(schema.projects.id, ids.projectId));
    userId = owner?.userId;
    role = owner?.role;
  }
  if (!userId) return null;
  if (role === "admin") return { userId, limits: null };
  const [row, grants] = await Promise.all([
    tx.query.userSettings.findFirst({ where: eq(schema.userSettings.userId, userId), columns: { resources: true } }),
    ent.grantsFor(tx, userId),
  ]);
  const r = resourceCeilingOf(row?.resources ?? null, grants);
  if (!r.value && !r.reserveCores) return { userId, limits: null };
  return { userId, limits: { ceiling: r.value, reserveCores: r.reserveCores, live: { cores: 0, memMB: 0 } } };
}

/**
 * The shared ledger for the governor: check against the host's live totals and record the claim, as one locked
 * transaction. On a hosted instance (`entitlements`, EE) the claim is also bounded by its account's plan ceiling and
 * the paid reserve (`claimOnLive` with `AccountLimits`), checked against that account's live rows under a lock per
 * account, in the same step; self-hosted the host's capacity is the only limit.
 */
export function createLeaser(svc: Pick<Services, "database" | "log" | "entitlements">, p: LeaseScope & { selfId: string; staleMs: number }): Leaser {
  const log = svc.log.child({ module: "resources" });
  return async (req) =>
    svc.database.db.transaction(async (tx) => {
      // both scopes, always in this order: disk is checked per volume, cores and memory per machine, then the account
      await takeTxLock(tx, txLock.leaseVolume(p.volume));
      await takeTxLock(tx, txLock.leaseMachine(p.machine));
      const ent = svc.entitlements;
      const acct = ent ? await leaseAccount(tx as unknown as Db, ent, req.ids) : null;
      if (acct?.limits) {
        await takeTxLock(tx, txLock.leaseAccount(acct.userId));
        acct.limits.live = await accountLeases(tx, { userId: acct.userId, selfId: p.selfId, staleMs: p.staleMs });
      }
      const live = await hostLeases(tx, p);
      const claim = claimOnLive(req, live, acct?.limits);
      if (!claim.ok) return claim;
      const [row] = await tx
        .insert(schema.resourceLeases)
        .values({
          volume: p.volume,
          machine: p.machine,
          workerId: p.selfId,
          jobId: req.ids?.jobId ?? null,
          projectId: req.ids?.projectId ?? null,
          userId: acct?.userId ?? req.ids?.userId ?? null,
          kind: req.kind,
          mb: claim.mb,
          cores: claim.cores,
          memMB: claim.memMB,
          expiresAt: new Date(Date.now() + LEASE_TTL_MS),
        })
        .returning({ id: schema.resourceLeases.id });
      if (!row) throw new Error("lease insert returned no row");
      const id = row.id;
      log.debug({ kind: req.kind, mb: claim.mb, cores: claim.cores, memMB: claim.memMB, live, account: acct?.limits ?? undefined, ...req.ids }, "leased");
      return {
        ...claim,
        id,
        release: async () => {
          await svc.database.db.delete(schema.resourceLeases).where(eq(schema.resourceLeases.id, id));
        },
      };
    });
}

/** Rows no job can still hold: expired, or of a worker whose heartbeat row is gone. Hourly hygiene; the sum query already ignores them. */
export async function pruneLeases(svc: Pick<Services, "database" | "log">): Promise<number> {
  const t = schema.resourceLeases;
  const gone = svc.database.db.select({ id: schema.workerInstances.id }).from(schema.workerInstances).where(eq(schema.workerInstances.id, t.workerId));
  const rows = await svc.database.db
    .delete(t)
    .where(or(lt(t.expiresAt, new Date()), sql`not exists (${gone})`))
    .returning({ id: t.id });
  if (rows.length) svc.log.info({ module: "resources", removed: rows.length }, "dropped dead resource leases");
  return rows.length;
}

/** How old an own row must be before the heartbeat may call it leaked: a claim commits before its handle is registered. */
const LEAKED_LEASE_GRACE_MS = 60_000;

/**
 * This worker's rows that no lease it holds points at (`keep`, ResourceGovernor.ownLeaseIds): releases whose
 * delete failed. Dropped on the heartbeat, so a database blip at a release costs one beat instead of a day of
 * phantom cores or a phantom render. Rows younger than LEAKED_LEASE_GRACE_MS are left alone.
 */
export async function dropLeakedLeases(svc: Pick<Services, "database" | "log">, selfId: string, keep: number[], now = new Date()): Promise<number> {
  const t = schema.resourceLeases;
  const rows = await svc.database.db
    .delete(t)
    .where(and(eq(t.workerId, selfId), lt(t.createdAt, new Date(now.getTime() - LEAKED_LEASE_GRACE_MS)), keep.length ? notInArray(t.id, keep) : undefined))
    .returning({ id: t.id, kind: t.kind });
  if (rows.length) svc.log.warn({ module: "resources", leaked: rows }, "dropped leases whose release never reached the ledger");
  return rows.length;
}

/** Everything this process leased: on shutdown, with its heartbeat row. */
export async function releaseWorkerLeases(svc: Pick<Services, "database">, selfId: string): Promise<void> {
  await svc.database.db.delete(schema.resourceLeases).where(eq(schema.resourceLeases.workerId, selfId));
}
