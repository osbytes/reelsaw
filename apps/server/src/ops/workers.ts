/**
 * Fleet membership: every HTTP or worker process heartbeats its specs and in-flight jobs into
 * `worker_instances` so Settings → System → Workers (and MCP / CLI) can show the boxes that
 * actually run work, not only the process that served the page.
 */
import os from "node:os";
import { randomBytes } from "node:crypto";
import { eq, gt, lt, and, ne, inArray } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import type { Logger } from "../log.js";
import type { WorkerGpu, WorkerJob, WorkerRenders, WorkerRole } from "../db/schema.js";
import type { QueueName } from "../queue/boss.js";
import { inflightJobs, listeningQueues } from "../queue/inflight.js";
import { LEASE_STALE_MS, releaseWorkerLeases, volumeLeases } from "../disk-leases.js";
import type { Services } from "../services.js";
import type { Config } from "../config.js";
import { pausedReason, type PausedReason } from "../resources.js";

export const WORKER_HEARTBEAT_MS = 15_000;
/** last_seen older than this → not live (three missed beats) */
export const WORKER_STALE_MS = 45_000;
/** drop rows that have not checked in for this long so a crash cannot grow the table forever */
export const WORKER_PRUNE_MS = 60 * 60_000;

const ROLE_ORDER: Record<WorkerRole, number> = { worker: 0, app: 1, api: 2 };

export function processRole(c: Pick<Config, "RUN_HTTP" | "RUN_WORKERS">): WorkerRole {
  if (!c.RUN_HTTP) return "worker";
  if (!c.RUN_WORKERS) return "api";
  return "app";
}

export function workerIdOf(c: Pick<Config, "WORKER_ID">, hostname = os.hostname(), pid = process.pid): string {
  const pinned = c.WORKER_ID?.trim();
  return pinned && pinned.length ? pinned : `${hostname}:${pid}`;
}

/** A heartbeat row for the same id this recent means another live process is using the pinned WORKER_ID. */
export const WORKER_ID_IN_USE_MS = 30_000;

/** Pure: the pinned id, or the pinned id plus `-<4 hex>` when a live process already beats under it. */
export function disambiguateWorkerId(pinned: string, lastBeatAt: Date | null, now: Date, suffix: string): string {
  const inUse = lastBeatAt !== null && now.getTime() - lastBeatAt.getTime() <= WORKER_ID_IN_USE_MS;
  return inUse ? `${pinned}-${suffix}` : pinned;
}

/**
 * Boot: two replicas started with the same pinned WORKER_ID (`docker compose --scale worker=N`) would overwrite each
 * other's heartbeat row and release each other's disk leases. When a row under the pinned id was updated in the last
 * 30 s, this process takes `<id>-<4 hex>` instead (config.WORKER_ID is rewritten, so every `workerIdOf` caller agrees).
 * Unpinned ids (`hostname:pid`) are already unique. Two replicas that start within the same moment can still both pass.
 */
export async function claimWorkerId(config: Config, db: Db, log: Logger): Promise<string> {
  const pinned = config.WORKER_ID?.trim();
  if (!pinned) return workerIdOf(config);
  const [row] = await db.select({ updatedAt: schema.workerInstances.updatedAt }).from(schema.workerInstances).where(eq(schema.workerInstances.id, pinned));
  const id = disambiguateWorkerId(pinned, row?.updatedAt ?? null, new Date(), randomBytes(2).toString("hex"));
  if (id !== pinned) {
    config.WORKER_ID = id;
    log.warn({ pinned, workerId: id }, "WORKER_ID is already in use by a live process; using the suffixed id");
  }
  return id;
}

export interface WorkerView {
  id: string;
  role: WorkerRole;
  hostname: string;
  startedAt: string;
  lastSeenAt: string;
  version: string;
  commit: string;
  pid: number;
  cpus: number;
  memTotalMB: number;
  diskFreeMB: number;
  diskTotalMB: number;
  /** the filesystem its DATA_DIR is on; processes with the same volume share one disk (and its leases) */
  volume: string | null;
  /** MB of that free space already leased to jobs in flight on the volume (disk-leases.ts) */
  diskLeasedMB: number;
  gpu: WorkerGpu | null;
  renders: WorkerRenders;
  queues: string[];
  processing: Array<WorkerJob & { title?: string }>;
  /** what it was short of at its last beat (heavy jobs wait on it); null = room, or it takes no jobs */
  paused: PausedReason | null;
  live: boolean;
  lastSeenAgoSec: number;
  thisProcess: boolean;
}

export function classifyWorkers(
  rows: Array<{
    id: string;
    role: WorkerRole;
    hostname: string;
    startedAt: Date;
    lastSeenAt: Date;
    version: string;
    commit: string;
    pid: number;
    cpus: number;
    memTotalMB: number;
    diskFreeMB: number;
    diskTotalMB: number;
    volume?: string | null;
    diskLeasedMB?: number;
    gpu: WorkerGpu | null;
    renders: WorkerRenders;
    queues: string[] | null;
    processing: WorkerJob[] | null;
    paused?: PausedReason | null;
  }>,
  now: Date,
  selfId: string,
  staleMs = WORKER_STALE_MS,
): WorkerView[] {
  const views: WorkerView[] = rows.map((r) => {
    const ago = Math.max(0, Math.round((now.getTime() - r.lastSeenAt.getTime()) / 1000));
    return {
      id: r.id,
      role: r.role,
      hostname: r.hostname,
      startedAt: r.startedAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      version: r.version,
      commit: r.commit,
      pid: r.pid,
      cpus: r.cpus,
      memTotalMB: r.memTotalMB,
      diskFreeMB: r.diskFreeMB,
      diskTotalMB: r.diskTotalMB,
      volume: r.volume ?? null,
      diskLeasedMB: r.diskLeasedMB ?? 0,
      gpu: r.gpu,
      renders: r.renders,
      queues: r.queues ?? [],
      processing: r.processing ?? [],
      paused: r.paused ?? null,
      live: now.getTime() - r.lastSeenAt.getTime() <= staleMs,
      lastSeenAgoSec: ago,
      thisProcess: r.id === selfId,
    };
  });
  views.sort(
    (a, b) => Number(b.live) - Number(a.live) || ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.hostname.localeCompare(b.hostname) || a.id.localeCompare(b.id),
  );
  return views;
}

export async function listWorkers(svc: Services): Promise<{ items: WorkerView[]; live: number; stale: number }> {
  const rows = await svc.database.db.select().from(schema.workerInstances);
  const items = classifyWorkers(rows, new Date(), workerIdOf(svc.config));
  const ids = [...new Set(items.flatMap((w) => w.processing.map((p) => p.projectId)))];
  if (ids.length) {
    const titles = await svc.database.db
      .select({ id: schema.projects.id, title: schema.projects.title })
      .from(schema.projects)
      .where(inArray(schema.projects.id, ids));
    const byId = new Map(titles.map((t) => [t.id, t.title]));
    for (const w of items) {
      w.processing = w.processing.map((p) => {
        const title = byId.get(p.projectId);
        return title ? { ...p, title } : p;
      });
    }
  }
  return { items, live: items.filter((w) => w.live).length, stale: items.filter((w) => !w.live).length };
}

/**
 * Pure: another live process that listens on `queue` and reported at least `requiredMB` free net of
 * what jobs in flight have leased on its volume (an unmeasurable disk, -1, counts as room: it never
 * refuses work). Null when nobody does.
 */
export function pickWorkerWithRoom(
  rows: Array<{ id: string; lastSeenAt: Date; queues: string[] | null; diskFreeMB: number; diskLeasedMB?: number }>,
  now: Date,
  selfId: string,
  queue: QueueName,
  requiredMB: number,
  staleMs = WORKER_STALE_MS,
): { workerId: string } | null {
  for (const r of rows) {
    if (r.id === selfId || now.getTime() - r.lastSeenAt.getTime() > staleMs) continue;
    if (!r.queues?.includes(queue)) continue;
    if (r.diskFreeMB >= 0 && r.diskFreeMB - (r.diskLeasedMB ?? 0) < requiredMB) continue;
    return { workerId: r.id };
  }
  return null;
}

/** Is there another worker this job could run on with `requiredMB` free? Read from the last heartbeats. */
export async function workerWithRoom(svc: Services, queue: QueueName, requiredMB: number): Promise<{ workerId: string } | null> {
  const rows = await svc.database.db
    .select({
      id: schema.workerInstances.id,
      lastSeenAt: schema.workerInstances.lastSeenAt,
      queues: schema.workerInstances.queues,
      diskFreeMB: schema.workerInstances.diskFreeMB,
      diskLeasedMB: schema.workerInstances.diskLeasedMB,
    })
    .from(schema.workerInstances)
    .where(gt(schema.workerInstances.lastSeenAt, new Date(Date.now() - WORKER_STALE_MS)));
  return pickWorkerWithRoom(rows, new Date(), workerIdOf(svc.config), queue, requiredMB);
}

/**
 * Pure: why heavy jobs are waiting across the fleet, from the last heartbeats. Work waits only when every live
 * process that takes jobs is short (one with room picks the job up), so this is null unless all of them are; the
 * reason is the first one's. Null too when no process takes jobs: that is a missing worker, not a paused one.
 */
export function fleetPausedReason(
  rows: Array<{ lastSeenAt: Date; queues: string[] | null; paused: PausedReason | null }>,
  now: Date,
  staleMs = WORKER_STALE_MS,
): PausedReason | null {
  const takers = rows.filter((r) => now.getTime() - r.lastSeenAt.getTime() <= staleMs && (r.queues?.length ?? 0) > 0);
  if (!takers.length || takers.some((r) => !r.paused)) return null;
  return takers[0]?.paused ?? null;
}

/** How long `fleetPaused` reuses its answer: `system.status` is public and polled, so it must not be one query per call. */
const FLEET_PAUSED_TTL_MS = 5_000;
let fleetPausedCache: { at: number; value: PausedReason | null } | null = null;

/**
 * The jobs-paused reason the app shows (`system.status`). Read from the heartbeats rather than this process's own
 * machine, because an HTTP-only process (RUN_WORKERS=false) runs no jobs and its CPU or disk says nothing about them.
 */
export async function fleetPaused(svc: Services): Promise<PausedReason | null> {
  const now = Date.now();
  if (fleetPausedCache && now - fleetPausedCache.at < FLEET_PAUSED_TTL_MS) return fleetPausedCache.value;
  const rows = await svc.database.db
    .select({ lastSeenAt: schema.workerInstances.lastSeenAt, queues: schema.workerInstances.queues, paused: schema.workerInstances.paused })
    .from(schema.workerInstances)
    .where(gt(schema.workerInstances.lastSeenAt, new Date(now - WORKER_STALE_MS)));
  const value = fleetPausedReason(rows, new Date(now));
  fleetPausedCache = { at: now, value };
  return value;
}

export async function beat(svc: Services): Promise<void> {
  const id = workerIdOf(svc.config);
  const hostname = os.hostname();
  const snap = await svc.resources.snapshot();
  const gpu = svc.resources.gpu();
  const r = svc.resources.renders();
  const now = new Date();
  const startedAt = new Date(now.getTime() - process.uptime() * 1000);
  const gpuJson: WorkerGpu | null = gpu ? { vendor: gpu.vendor, devices: gpu.devices, note: gpu.note } : null;
  const renders: WorkerRenders = { running: r.running, limit: r.limit, max: svc.resources.maxRenders(), mode: r.mode };
  // what this process takes right now: everything, or without the disk queues while the gate holds them (queue/disk-gate.ts)
  const queues = svc.config.RUN_WORKERS ? listeningQueues() : [];
  // disk promised to jobs in flight on this volume, by every process on it: what a hand-off subtracts from "free"
  const lease = svc.resources.leases();
  const diskLeasedMB = lease.volume
    ? (await volumeLeases(svc.database.db, { volume: lease.volume, selfId: id, staleMs: LEASE_STALE_MS, now })).mb
    : lease.ownMB;
  const row = {
    role: processRole(svc.config),
    hostname,
    startedAt,
    lastSeenAt: now,
    version: svc.config.REELSAW_VERSION,
    commit: svc.config.REELSAW_COMMIT,
    pid: process.pid,
    cpus: snap.cpus,
    memTotalMB: snap.memTotalMB,
    diskFreeMB: snap.diskFreeMB,
    diskTotalMB: snap.diskTotalMB,
    volume: lease.volume,
    diskLeasedMB,
    gpu: gpuJson,
    renders,
    queues,
    processing: inflightJobs(),
    paused: pausedReason(snap),
    updatedAt: now,
  };
  await svc.database.db
    .insert(schema.workerInstances)
    .values({ id, ...row })
    .onConflictDoUpdate({ target: schema.workerInstances.id, set: row });
  const cutoff = new Date(now.getTime() - WORKER_PRUNE_MS);
  await svc.database.db.delete(schema.workerInstances).where(and(lt(schema.workerInstances.lastSeenAt, cutoff), ne(schema.workerInstances.id, id)));
}

export async function forget(svc: Services): Promise<void> {
  const id = workerIdOf(svc.config);
  await releaseWorkerLeases(svc, id); // its jobs have stopped (main.ts calls this after the queue stop): nothing of theirs is still writing
  await svc.database.db.delete(schema.workerInstances).where(eq(schema.workerInstances.id, id));
}

/**
 * Repeat the beat every 15 s. The stop function deletes this process's row and its disk leases: call it only
 * once the queue has stopped (running jobs finished or the grace ran out), so a job still writing during the
 * shutdown grace keeps its claim and other processes on the volume do not take its bytes. Callers await `beat`
 * once at boot so the first HTTP request already sees this process.
 */
/**
 * The Sentry cron monitor a process checks into: `heartbeat-<WORKER_ID>` when the id is pinned (one monitor per
 * worker service, so one dead worker alerts), else `heartbeat-<role>` (api, worker, app).
 */
export function heartbeatMonitor(c: Pick<Config, "WORKER_ID" | "RUN_HTTP" | "RUN_WORKERS">): string {
  return `heartbeat-${c.WORKER_ID?.trim() || processRole(c)}`;
}

export function startHeartbeat(svc: Services): () => Promise<void> {
  const log = svc.log.child({ module: "ops" });
  const monitor = heartbeatMonitor(svc.config);
  let lastCheckIn = 0;
  const tick = () =>
    beat(svc)
      .then(() => {
        // the monitor is per minute; the database beat stays every 15 s
        if (Date.now() - lastCheckIn < 60_000) return;
        lastCheckIn = Date.now();
        svc.telemetry.checkIn(monitor, "ok", { type: "interval", minutes: 1 });
      })
      .catch((err) => log.warn({ err }, "worker heartbeat failed"));
  const t = setInterval(tick, WORKER_HEARTBEAT_MS);
  t.unref();
  return async () => {
    clearInterval(t);
    await forget(svc).catch((err) => log.warn({ err }, "worker heartbeat forget failed"));
  };
}
