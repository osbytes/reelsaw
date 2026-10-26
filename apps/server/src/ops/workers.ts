/**
 * Fleet membership: every HTTP or worker process heartbeats its specs and in-flight jobs into
 * `worker_instances` so Settings → System → Workers (and MCP / CLI) can show the boxes that
 * actually run work, not only the process that served the page.
 */
import os from "node:os";
import { eq, gt, lt, and, ne, inArray } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { WorkerGpu, WorkerJob, WorkerRenders, WorkerRole } from "../db/schema.js";
import type { QueueName } from "../queue/boss.js";
import { inflightJobs, listeningQueues } from "../queue/inflight.js";
import type { Services } from "../services.js";
import type { Config } from "../config.js";

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
  gpu: WorkerGpu | null;
  renders: WorkerRenders;
  queues: string[];
  processing: Array<WorkerJob & { title?: string }>;
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
    gpu: WorkerGpu | null;
    renders: WorkerRenders;
    queues: string[] | null;
    processing: WorkerJob[] | null;
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
      gpu: r.gpu,
      renders: r.renders,
      queues: r.queues ?? [],
      processing: r.processing ?? [],
      live: now.getTime() - r.lastSeenAt.getTime() <= staleMs,
      lastSeenAgoSec: ago,
      thisProcess: r.id === selfId,
    };
  });
  views.sort((a, b) => Number(b.live) - Number(a.live) || ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.hostname.localeCompare(b.hostname) || a.id.localeCompare(b.id));
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
 * Pure: another live process that listens on `queue` and reported at least `requiredMB` free (an
 * unmeasurable disk, -1, counts as room: it never refuses work). Null when nobody does.
 */
export function pickWorkerWithRoom(rows: Array<{ id: string; lastSeenAt: Date; queues: string[] | null; diskFreeMB: number }>, now: Date, selfId: string, queue: QueueName, requiredMB: number, staleMs = WORKER_STALE_MS): { workerId: string } | null {
  for (const r of rows) {
    if (r.id === selfId || now.getTime() - r.lastSeenAt.getTime() > staleMs) continue;
    if (!r.queues?.includes(queue)) continue;
    if (r.diskFreeMB >= 0 && r.diskFreeMB < requiredMB) continue;
    return { workerId: r.id };
  }
  return null;
}

/** Is there another worker this job could run on with `requiredMB` free? Read from the last heartbeats. */
export async function workerWithRoom(svc: Services, queue: QueueName, requiredMB: number): Promise<{ workerId: string } | null> {
  const rows = await svc.database.db
    .select({ id: schema.workerInstances.id, lastSeenAt: schema.workerInstances.lastSeenAt, queues: schema.workerInstances.queues, diskFreeMB: schema.workerInstances.diskFreeMB })
    .from(schema.workerInstances)
    .where(gt(schema.workerInstances.lastSeenAt, new Date(Date.now() - WORKER_STALE_MS)));
  return pickWorkerWithRoom(rows, new Date(), workerIdOf(svc.config), queue, requiredMB);
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
  await svc.database.db
    .insert(schema.workerInstances)
    .values({
      id,
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
      gpu: gpuJson,
      renders,
      queues,
      processing: inflightJobs(),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.workerInstances.id,
      set: {
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
        gpu: gpuJson,
        renders,
        queues,
        processing: inflightJobs(),
        updatedAt: now,
      },
    });
  const cutoff = new Date(now.getTime() - WORKER_PRUNE_MS);
  await svc.database.db.delete(schema.workerInstances).where(and(lt(schema.workerInstances.lastSeenAt, cutoff), ne(schema.workerInstances.id, id)));
}

export async function forget(svc: Services): Promise<void> {
  await svc.database.db.delete(schema.workerInstances).where(eq(schema.workerInstances.id, workerIdOf(svc.config)));
}

/** Repeat the beat every 15 s. The stop function deletes this process's row. Callers await `beat` once at boot so the first HTTP request already sees this process. */
export function startHeartbeat(svc: Services): () => void {
  const log = svc.log.child({ module: "ops" });
  const tick = () =>
    beat(svc).catch((err) => log.warn({ err }, "worker heartbeat failed"));
  const t = setInterval(tick, WORKER_HEARTBEAT_MS);
  t.unref();
  return () => {
    clearInterval(t);
    void forget(svc).catch((err) => log.warn({ err }, "worker heartbeat forget failed"));
  };
}
