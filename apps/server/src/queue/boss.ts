import { PgBoss } from "pg-boss";
import type pg from "pg";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";

export const QUEUES = {
  ingest: "project.ingest",
  transcribe: "project.transcribe",
  refineEntities: "refine.entities",
  refineDisfluency: "refine.disfluency",
  refineScenes: "refine.scenes",
  analyze: "project.analyze",
  render: "clip.render",
  prepare: "clip.prepare",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface ProjectJob {
  projectId: string;
}
export interface RenderJob {
  projectId: string;
  clipId: string;
}
export interface PrepareJob extends RenderJob {
  mode: "exact" | "ai";
}

// Jobs lose their heartbeat within seconds of a worker crash, which lets pg-boss
// hand them to another worker long before the hard expiry hits.
const HEARTBEAT_SECONDS = 15;

export const queueDefs: Array<{ name: QueueName; expireInSeconds: number; retryLimit: number }> = [
  { name: QUEUES.ingest, expireInSeconds: 3 * 3600, retryLimit: 3 },
  { name: QUEUES.transcribe, expireInSeconds: 3 * 3600, retryLimit: 3 },
  { name: QUEUES.refineEntities, expireInSeconds: 1800, retryLimit: 3 },
  { name: QUEUES.refineDisfluency, expireInSeconds: 1800, retryLimit: 3 },
  { name: QUEUES.refineScenes, expireInSeconds: 1800, retryLimit: 2 },
  { name: QUEUES.analyze, expireInSeconds: 1800, retryLimit: 3 },
  { name: QUEUES.render, expireInSeconds: 3600, retryLimit: 4 }, // deploy restarts also consume retries
  { name: QUEUES.prepare, expireInSeconds: 900, retryLimit: 3 },
];

export interface Queue {
  boss: PgBoss;
  retryLimitOf(queue: QueueName): number;
  /** Enqueue a stage job. Deduped per project/clip via singletonKey + exclusive policy. */
  enqueue(queue: QueueName, data: ProjectJob | RenderJob | PrepareJob): Promise<string | null>;
  /** True if a job for this key is created, retrying, or active. */
  hasLiveJob(queue: QueueName, key: string): Promise<boolean>;
  /** Cancel every live job for a key so it can be re-enqueued cleanly. */
  cancelLiveJobs(queue: QueueName, key: string): Promise<void>;
  /** Start pg-boss (runs its own migrations) and create the queues. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createQueue(config: Config, pool: pg.Pool, otelEnabled: boolean, log: Logger): Queue {
  const boss = new PgBoss({
    db: { executeSql: (text, values) => pool.query(text, values) },
    schema: "pgboss",
    useListenNotify: false,
    instanceName: config.RUN_WORKERS ? "reelsaw-worker" : "reelsaw-api",
    openTelemetry: { enabled: otelEnabled, propagateContext: true },
  });
  boss.on("error", (err) => log.error({ err }, "pg-boss error"));
  boss.on("warning", (w) => log.warn({ warning: w }, "pg-boss warning"));
  let started = false;

  return {
    boss,
    retryLimitOf: (queue) => queueDefs.find((q) => q.name === queue)?.retryLimit ?? 0,
    async start() {
      if (started) return;
      try {
        await boss.start();
      } catch (err) {
        throw new Error(`pg-boss failed to start: ${(err as Error).message}`);
      }
      for (const q of queueDefs) {
        await boss.createQueue(q.name, {
          policy: "exclusive",
          expireInSeconds: q.expireInSeconds,
          retryLimit: q.retryLimit,
          retryDelay: 15,
          retryBackoff: true,
          heartbeatSeconds: HEARTBEAT_SECONDS,
          deleteAfterSeconds: 3 * 24 * 3600,
        });
        // createQueue is a no-op for existing queues; keep retry/expiry in sync with the code
        await boss.updateQueue(q.name, { expireInSeconds: q.expireInSeconds, retryLimit: q.retryLimit }).catch((err) => log.warn({ err, queue: q.name }, "updateQueue failed"));
      }
      started = true;
    },
    async stop() {
      if (!started) return;
      // graceful: stop fetching, let running jobs finish (deploys shouldn't kill a 5-minute render)
      await boss.stop({ graceful: true, timeout: config.SHUTDOWN_GRACE_SECONDS * 1000, close: false });
      started = false;
    },
    enqueue(queue, data) {
      const singletonKey = "clipId" in data ? data.clipId : data.projectId;
      return boss.send(queue, data, { singletonKey });
    },
    async hasLiveJob(queue, key) {
      const res = await pool.query<{ n: string }>(
        `select count(*)::text as n from pgboss.job where name = $1 and singleton_key = $2 and state in ('created','retry','active')`,
        [queue, key],
      );
      return Number(res.rows[0]?.n ?? 0) > 0;
    },
    async cancelLiveJobs(queue, key) {
      const res = await pool.query<{ id: string }>(
        `select id from pgboss.job where name = $1 and singleton_key = $2 and state in ('created','retry','active')`,
        [queue, key],
      );
      const ids = res.rows.map((r) => r.id);
      if (ids.length) await boss.cancel(queue, ids);
    },
  };
}
