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
  /** the project's owner, written by `enqueue` (fairness: live jobs are counted per user) */
  userId?: string;
  /** "user" when a person asked for this job (create, retry, re-render, new clip); absent for pipeline hand-offs */
  by?: "user";
  /**
   * Stage jobs only: projects.stage_seq when queued, filled in by `enqueue`. The job commits only while it is still
   * current (a retry or re-analyze bumped it: stale, exits quietly). Absent on jobs queued before it existed: current.
   */
  seq?: number;
}
export interface RenderJob extends ProjectJob {
  clipId: string;
  /** clips.render_gen this job renders; a stale job (gen moved on) exits without writing */
  gen?: number;
}
export interface PrepareJob extends RenderJob {
  mode: "exact" | "ai";
}
export type JobData = ProjectJob | RenderJob | PrepareJob;
/** run the queue operation on a transaction's connection (see uow.ts) */
export interface TxOpts {
  db?: { executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
}

/**
 * What the queue knows about a job's owner at enqueue time, from one statement: the owner, how many of
 * their jobs are queued or running (any queue), and how many renders / new clips they asked for in the
 * last hour. Jobs enqueued before `userId` was carried in job data are not counted.
 */
export interface Admission {
  userId: string | null;
  live: number;
  userRendersLastHour: number;
}

/**
 * pg-boss fetches `priority desc, created_on`, so a job's priority is minus its owner's live jobs when it was
 * queued: the first job of someone with nothing in flight goes ahead of the 20th of someone with a backlog,
 * and within one user (and between users with equal backlogs) the order stays first-come first-served.
 * Bounded so a huge backlog can't overflow and so ties form among heavy users.
 */
export const fairPriority = (live: number) => -Math.min(Math.max(0, live), 1000);

/** queues whose user-requested jobs count toward MAX_RERENDERS_PER_HOUR */
export const USER_RENDER_QUEUES: QueueName[] = [QUEUES.render, QUEUES.prepare];

// Jobs lose their heartbeat within seconds of a worker crash, which lets pg-boss
// hand them to another worker long before the hard expiry hits.
const HEARTBEAT_SECONDS = 15;

// expireInSeconds is the queue DEFAULT. analyze and the refine stages override it per job from the
// project's duration (`expireInSecondsFor`: clamp(default, duration * 2, 3 h)), so a long source on a
// slow model is not cut off at 1800 s; every other queue uses its value here as the hard cap.
export const queueDefs:Array<{ name: QueueName; expireInSeconds: number; retryLimit: number }> = [
  { name: QUEUES.ingest, expireInSeconds: 3 * 3600, retryLimit: 3 },
  { name: QUEUES.transcribe, expireInSeconds: 3 * 3600, retryLimit: 3 },
  { name: QUEUES.refineEntities, expireInSeconds: 1800, retryLimit: 3 },
  { name: QUEUES.refineDisfluency, expireInSeconds: 1800, retryLimit: 3 },
  { name: QUEUES.refineScenes, expireInSeconds: 1800, retryLimit: 2 },
  { name: QUEUES.analyze, expireInSeconds: 1800, retryLimit: 3 },
  { name: QUEUES.render, expireInSeconds: 3600, retryLimit: 4 }, // deploy restarts also consume retries
  { name: QUEUES.prepare, expireInSeconds: 900, retryLimit: 3 },
];

/** Stages whose LLM time grows with the media: their hard expiry is set per job from the project's duration. */
const LLM_STAGE_QUEUES: QueueName[] = [QUEUES.analyze, QUEUES.refineEntities, QUEUES.refineDisfluency, QUEUES.refineScenes];

/**
 * Hard expiry for one job, in seconds. The queue default (1800 s for analyze and refine) is far too
 * short for a multi-hour source on a slow local model, and a job that expires is retried from the
 * start, burning a retry each time. The rule: twice the media duration, never below the queue default
 * and never above three hours, i.e. clamp(default, durationSec * 2, 3 h). Other queues, and projects
 * without a duration yet, use the queue default (`undefined`: pg-boss applies the queue's value).
 */
export function expireInSecondsFor(queue: QueueName, durationSec: number | null | undefined): number | undefined {
  if (!LLM_STAGE_QUEUES.includes(queue) || !durationSec || !Number.isFinite(durationSec) || durationSec <= 0) return undefined;
  const base = queueDefs.find((q) => q.name === queue)?.expireInSeconds ?? 1800;
  return Math.round(Math.min(Math.max(base, durationSec * 2), 3 * 3600));
}

export interface Queue {
  boss: PgBoss;
  retryLimitOf(queue: QueueName): number;
  /**
   * Enqueue a stage job. Deduped per project/clip via singletonKey + exclusive policy. Carries the owner's
   * `userId` and a fair `priority` (see `fairPriority`); pass `admission` when the caller already looked it up.
   */
  enqueue(queue: QueueName, data: JobData, opts?: TxOpts & { admission?: Admission; priorityBoost?: number; expireInSeconds?: number }): Promise<string | null>;
  /** A job on any queue the caller created itself (ee/ billing): plain pg-boss send on the transaction's connection when given. */
  send(queue: string, data: object, opts?: TxOpts & { singletonKey?: string }): Promise<string | null>;
  /** The job owner's in-flight work (see `Admission`), on the transaction's connection when given. */
  admission(data: JobData, opts?: TxOpts): Promise<Admission>;
  /** True if a job for this key is created, retrying, or active. */
  hasLiveJob(queue: QueueName, key: string, opts?: TxOpts): Promise<boolean>;
  /** Cancel every live job for a key so it can be re-enqueued cleanly. */
  cancelLiveJobs(queue: QueueName, key: string, opts?: TxOpts): Promise<void>;
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

  const admission: Queue["admission"] = async (data, opts) => {
    const exec = opts?.db ?? { executeSql: (t: string, v?: unknown[]) => pool.query(t, v) };
    // one statement; data->>'userId' has no index, but the live states are few rows next to completed history
    const res = await exec.executeSql(
      `with o as (select coalesce($2::text, (select user_id from projects where id = $1)) as uid)
       select o.uid as "userId",
         (select count(*)::int from pgboss.job j where j.state in ('created','retry','active') and j.data->>'userId' = o.uid) as live,
         (select count(*)::int from pgboss.job j where j.name = any($3::text[]) and j.data->>'by' = 'user' and j.data->>'userId' = o.uid and j.created_on > now() - interval '1 hour') as "userRendersLastHour"
       from o`,
      [data.projectId, data.userId ?? null, USER_RENDER_QUEUES],
    );
    const r = res.rows[0] as Admission | undefined;
    return { userId: r?.userId ?? null, live: Number(r?.live ?? 0), userRendersLastHour: Number(r?.userRendersLastHour ?? 0) };
  };

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
    admission,
    send: (queue, data, opts) => boss.send(queue, data, { ...(opts?.singletonKey ? { singletonKey: opts.singletonKey } : {}), ...(opts?.db ? { db: opts.db } : {}) }),
    async enqueue(queue, data, opts) {
      const singletonKey = "clipId" in data ? data.clipId : data.projectId;
      const a = opts?.admission ?? (await admission(data, opts));
      let payload: JobData = a.userId ? { ...data, userId: a.userId } : data;
      // every stage job carries the version it belongs to, read in the caller's transaction (after any bump it made)
      // (the same read gives the media duration, which sizes the expiry of the long LLM stages)
      let expireInSeconds = opts?.expireInSeconds;
      if (!("clipId" in data) && (data.seq === undefined || expireInSeconds === undefined)) {
        const exec = opts?.db ?? { executeSql: (t: string, v?: unknown[]) => pool.query(t, v) };
        const r = (await exec.executeSql(`select stage_seq as seq, duration_sec as "durationSec" from projects where id = $1`, [data.projectId])).rows[0] as { seq?: number; durationSec?: number | null } | undefined;
        if (r?.seq !== undefined && data.seq === undefined) payload = { ...payload, seq: r.seq };
        expireInSeconds ??= expireInSecondsFor(queue, r?.durationSec);
      }
      // a plan's boost (ee) lifts the account above others with the same backlog, never above an idle account's first job by more than the boost
      return boss.send(queue, payload, { singletonKey, priority: fairPriority(a.live) + (opts?.priorityBoost ?? 0), ...(expireInSeconds ? { expireInSeconds } : {}), ...(opts?.db ? { db: opts.db } : {}) });
    },
    async hasLiveJob(queue, key, opts) {
      const exec = opts?.db ?? { executeSql: (t: string, v?: unknown[]) => pool.query(t, v) };
      const res = await exec.executeSql(
        `select count(*)::text as n from pgboss.job where name = $1 and singleton_key = $2 and state in ('created','retry','active')`,
        [queue, key],
      );
      return Number((res.rows[0] as { n?: string } | undefined)?.n ?? 0) > 0;
    },
    async cancelLiveJobs(queue, key, opts) {
      const exec = opts?.db ?? { executeSql: (t: string, v?: unknown[]) => pool.query(t, v) };
      const res = await exec.executeSql(
        `select id from pgboss.job where name = $1 and singleton_key = $2 and state in ('created','retry','active')`,
        [queue, key],
      );
      const ids = (res.rows as Array<{ id: string }>).map((r) => r.id);
      if (ids.length) await boss.cancel(queue, ids, opts?.db ? { db: opts.db } : undefined);
    },
  };
}
