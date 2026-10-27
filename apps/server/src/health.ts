/**
 * What `GET /api/health` reports: not "the process answered" but whether it can do its job. Each check has a short
 * timeout so a hung dependency turns into a 503 the orchestrator acts on (Docker HEALTHCHECK, a load balancer),
 * instead of a health request that hangs with it. The detail goes to the log; the response carries a short reason.
 */
import { eq } from "drizzle-orm";
import { schema } from "./db/index.js";
import type { Services } from "./services.js";
import { WORKER_STALE_MS, workerIdOf } from "./ops/workers.js";

export const HEALTH_CHECK_TIMEOUT_MS = 2000;

export interface HealthChecks {
  /** Postgres answers `select 1` */
  db: string;
  /** the LISTEN connection that streams events to the browser is up */
  events: string;
  /** pg-boss is started (jobs can be enqueued) */
  queue: string;
  /** this process's worker heartbeat is fresh; present only when this process runs workers */
  workers?: string;
}

class CheckTimeout extends Error {}

/** "ok", or a short plain reason. A rejection or a timeout becomes a reason (the rejection goes to `onError` for the log); nothing here throws. */
export async function settle(run: () => Promise<string | null>, onError: (err: unknown) => void, timeoutMs = HEALTH_CHECK_TIMEOUT_MS): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CheckTimeout()), timeoutMs);
    });
    const reason = await Promise.race([run(), timeout]);
    return reason ?? "ok";
  } catch (err) {
    if (err instanceof CheckTimeout) return `timed out after ${timeoutMs / 1000} s`;
    onError(err);
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

/** Pure: healthy when every check says "ok". */
export const healthy = (checks: HealthChecks): boolean => Object.values(checks).every((v) => v === "ok");

/** Is a heartbeat row seen at `lastSeenAt` fresh enough to call this process a live worker? */
export const heartbeatFresh = (lastSeenAt: Date | undefined, now = new Date()): boolean => !!lastSeenAt && now.getTime() - lastSeenAt.getTime() <= WORKER_STALE_MS;

export async function runHealthChecks(svc: Services): Promise<{ ok: boolean; checks: HealthChecks }> {
  const log = svc.log.child({ module: "health" });
  const failed = (check: string) => (err: unknown) => log.warn({ err, check }, "health check failed");
  const [db, events, queue, workers] = await Promise.all([
    settle(async () => {
      await svc.database.pool.query("select 1");
      return null;
    }, failed("db")),
    settle(async () => (svc.events.connected() ? null : "event listener is not connected"), failed("events")),
    settle(async () => (svc.queue.started() ? null : "job queue is not started"), failed("queue")),
    svc.config.RUN_WORKERS
      ? settle(async () => {
          const [row] = await svc.database.db.select({ lastSeenAt: schema.workerInstances.lastSeenAt }).from(schema.workerInstances).where(eq(schema.workerInstances.id, workerIdOf(svc.config)));
          return heartbeatFresh(row?.lastSeenAt) ? null : "worker heartbeat is stale";
        }, failed("workers"))
      : Promise.resolve(undefined),
  ]);
  const checks: HealthChecks = { db, events, queue, ...(workers !== undefined ? { workers } : {}) };
  return { ok: healthy(checks), checks };
}
