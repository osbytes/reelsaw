import { PgBoss } from "pg-boss";
import type { EventHandlerQueue } from "../event-handlers.js";
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

/**
 * Event handler queues (event-handlers.ts) are named `event.<type>.<handler>`. They are not pipeline
 * stages, so they stay out of `QUEUES` and out of fair-share admission.
 */
export const EVENT_HANDLER_QUEUE_LIKE = "event.%";

/**
 * Webhook deliveries (webhooks/deliver.ts): outside the pipeline, no admission. pg-boss retries are off: the retry
 * schedule is the delivery row's (each attempt is a new job with startAfter), so it is visible in the delivery log.
 */
export const WEBHOOK_QUEUE = "webhooks.deliver";

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
 * their jobs are queued or running (any queue), how many of those they asked for themselves, and how many renders, new
 * clips and re-runs (analysis, refinement) they asked for in the last hour. Jobs enqueued before `userId` was carried in
 * job data are not counted.
 */
export interface Admission {
  userId: string | null;
  /** every live job of the owner, pipeline hand-offs included: the fair-share priority */
  live: number;
  /** live jobs tagged `by: "user"`: what MAX_LIVE_JOBS_PER_USER counts, so a project's own renders never block the next request */
  userLive: number;
  userRendersLastHour: number;
}

/**
 * pg-boss fetches `priority desc, created_on`, so a job's priority is minus its owner's live jobs when it was
 * queued: the first job of someone with nothing in flight goes ahead of the 20th of someone with a backlog,
 * and within one user (and between users with equal backlogs) the order stays first-come first-served.
 * Bounded so a huge backlog can't overflow and so ties form among heavy users.
 */
export const fairPriority = (live: number) => -Math.min(Math.max(0, live), 1000);

/** queues whose user-requested jobs count toward MAX_RERENDERS_PER_HOUR: renders and new clips, and re-runs of analysis and refinement */
export const USER_RERUN_QUEUES: QueueName[] = [
  QUEUES.render,
  QUEUES.prepare,
  QUEUES.analyze,
  QUEUES.refineEntities,
  QUEUES.refineDisfluency,
  QUEUES.refineScenes,
];

// Jobs lose their heartbeat within seconds of a worker crash, which lets pg-boss
// hand them to another worker long before the hard expiry hits.
const HEARTBEAT_SECONDS = 15;

// expireInSeconds is the queue DEFAULT. analyze and the refine stages override it per job from the
// project's duration (`expireInSecondsFor`), so a long source on a slow model is not cut off at 1800 s; every
// other queue uses its value here as the hard cap.
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

/** Stages whose LLM time grows with the media: their hard expiry is set per job from the project's duration. */
const LLM_STAGE_QUEUES: QueueName[] = [QUEUES.analyze, QUEUES.refineEntities, QUEUES.refineDisfluency, QUEUES.refineScenes];

/** No job may be given longer than this: pg-boss caps a job's expiry at 24 h, and disk leases (disk-leases.ts) live as long. */
export const MAX_JOB_EXPIRE_SECONDS = 24 * 3600;

/** Whether `expireInSecondsFor` sizes this queue's expiry by the project's duration (so enqueue must read it). */
export const hasDurationExpiry = (queue: QueueName): boolean => LLM_STAGE_QUEUES.includes(queue);

/**
 * Backstop wall for one job, in seconds: the longest an attempt may run before pg-boss expires it. It is not the
 * time budget (that is the per-call and idle timeouts, and steps that survive an attempt: pipeline/steps.ts), only
 * what stops a runaway. The rule is clamp(default, default + duration × factor, 24 h), with factor 4 when the
 * language model is self-hosted (a CPU-only local model can take a few times the video's length) and 1 otherwise.
 * Other queues, and projects without a duration yet, use the queue default (`undefined`: pg-boss applies the queue's value).
 */
export function expireInSecondsFor(queue: QueueName, durationSec: number | null | undefined, selfHosted = false): number | undefined {
  if (!hasDurationExpiry(queue) || !durationSec || !Number.isFinite(durationSec) || durationSec <= 0) return undefined;
  const base = queueDefs.find((q) => q.name === queue)?.expireInSeconds ?? 1800;
  return Math.round(Math.min(Math.max(base, base + durationSec * (selfHosted ? 4 : 1)), MAX_JOB_EXPIRE_SECONDS));
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
  send(queue: string, data: object, opts?: TxOpts & { singletonKey?: string | undefined; startAfterSeconds?: number | undefined }): Promise<string | null>;
  /** The job owner's in-flight work (see `Admission`), on the transaction's connection when given. */
  admission(data: JobData, opts?: TxOpts): Promise<Admission>;
  /** True if a job for this key is created, retrying, or active. */
  hasLiveJob(queue: QueueName, key: string, opts?: TxOpts): Promise<boolean>;
  /** Cancel every live job for a key so it can be re-enqueued cleanly. */
  cancelLiveJobs(queue: QueueName, key: string, opts?: TxOpts): Promise<void>;
  /** Start pg-boss (runs its own migrations) and create the queues. */
  start(): Promise<void>;
  /** Has `start()` completed and `stop()` not begun (the health check)? */
  started(): boolean;
  stop(): Promise<void>;
}

/**
 * `languageSelfHosted`: is the language model that is in force right now (the environment or an admin's override) a
 * self-hosted one? Asked at enqueue time, to size the backstop wall of the long LLM stages.
 */
export function createQueue(
  config: Config,
  pool: pg.Pool,
  otelEnabled: boolean,
  log: Logger,
  languageSelfHosted: () => boolean = () => false,
  handlerQueues: readonly EventHandlerQueue[] = [],
): Queue {
  const boss = new PgBoss({
    db: { executeSql: (text, values) => pool.query(text, values) },
    schema: "pgboss",
    useListenNotify: false,
    instanceName: config.RUN_WORKERS ? "reelsaw-worker" : "reelsaw-api",
    openTelemetry: { enabled: otelEnabled, propagateContext: true },
  });
  // a failed poll or maintenance pass is retried on the next tick; one that keeps failing shows as stalled jobs
  boss.on("error", (err) => log.warn({ err }, "pg-boss error"));
  boss.on("warning", (w) => log.warn({ warning: w }, "pg-boss warning"));
  let started = false;

  const admission: Queue["admission"] = async (data, opts) => {
    const exec = opts?.db ?? { executeSql: (t: string, v?: unknown[]) => pool.query(t, v) };
    // one statement; data->>'userId' has no index, but the live states are few rows next to completed history.
    // event handler jobs can carry userId too, and are not pipeline work, so they are left out of the live count ($4).
    const res = await exec.executeSql(
      `with o as (select coalesce($2::text, (select user_id from projects where id = $1)) as uid)
       select o.uid as "userId",
         l.live, l."userLive",
         (select count(*)::int from pgboss.job j where j.name = any($3::text[]) and j.data->>'by' = 'user' and j.data->>'userId' = o.uid and j.created_on > now() - interval '1 hour') as "userRendersLastHour"
       from o, lateral (
         select count(*)::int as live, (count(*) filter (where j.data->>'by' = 'user'))::int as "userLive"
         from pgboss.job j where j.state in ('created','retry','active') and j.data->>'userId' = o.uid and j.name not like $4
       ) l`,
      [data.projectId, data.userId ?? null, USER_RERUN_QUEUES, EVENT_HANDLER_QUEUE_LIKE],
    );
    const r = res.rows[0] as Admission | undefined;
    return {
      userId: r?.userId ?? null,
      live: Number(r?.live ?? 0),
      userLive: Number(r?.userLive ?? 0),
      userRendersLastHour: Number(r?.userRendersLastHour ?? 0),
    };
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
        await boss
          .updateQueue(q.name, { expireInSeconds: q.expireInSeconds, retryLimit: q.retryLimit })
          .catch((err) => log.warn({ err, queue: q.name }, "updateQueue failed"));
      }
      // one queue per event handler; its policy is the concurrency the handler opted into (policyOf)
      for (const q of handlerQueues) {
        const o = q.options;
        const opts = {
          retryLimit: o.retryLimit,
          retryDelay: o.retryDelaySeconds,
          retryBackoff: o.retryBackoff,
          expireInSeconds: o.expireInSeconds,
          deleteAfterSeconds: o.deleteAfterSeconds,
        };
        await boss.createQueue(q.name, { policy: q.policy, ...opts });
        // createQueue is a no-op for an existing queue; keep its options in sync with the definition
        await boss.updateQueue(q.name, opts).catch((err) => log.warn({ err, queue: q.name }, "updateQueue failed"));
      }
      // the http process sends to it too (test, resend), so it exists wherever the queue starts
      await boss.createQueue(WEBHOOK_QUEUE, { policy: "standard", retryLimit: 0, expireInSeconds: 120, deleteAfterSeconds: 3 * 24 * 3600 });
      started = true;
    },
    started: () => started,
    async stop() {
      if (!started) return;
      // graceful: stop fetching, let running jobs finish (deploys shouldn't kill a 5-minute render)
      await boss.stop({ graceful: true, timeout: config.SHUTDOWN_GRACE_SECONDS * 1000, close: false });
      started = false;
    },
    admission,
    send: (queue, data, opts) =>
      boss.send(queue, data, {
        ...(opts?.singletonKey ? { singletonKey: opts.singletonKey } : {}),
        ...(opts?.startAfterSeconds ? { startAfter: opts.startAfterSeconds } : {}),
        ...(opts?.db ? { db: opts.db } : {}),
      }),
    async enqueue(queue, data, opts) {
      const singletonKey = "clipId" in data ? data.clipId : data.projectId;
      const a = opts?.admission ?? (await admission(data, opts));
      let payload: JobData = a.userId ? { ...data, userId: a.userId } : data;
      // every stage job carries the version it belongs to, read in the caller's transaction (after any bump it made)
      // (the same read gives the media duration, which sizes the expiry of the long LLM stages)
      let expireInSeconds = opts?.expireInSeconds;
      if (!("clipId" in data) && (data.seq === undefined || (expireInSeconds === undefined && hasDurationExpiry(queue)))) {
        const exec = opts?.db ?? { executeSql: (t: string, v?: unknown[]) => pool.query(t, v) };
        const r = (await exec.executeSql(`select stage_seq as seq, duration_sec as "durationSec" from projects where id = $1`, [data.projectId])).rows[0] as
          | { seq?: number; durationSec?: number | null }
          | undefined;
        if (r?.seq !== undefined && data.seq === undefined) payload = { ...payload, seq: r.seq };
        expireInSeconds ??= expireInSecondsFor(queue, r?.durationSec, languageSelfHosted());
      }
      // a plan's boost (ee) lifts the account above others with the same backlog, never above an idle account's first job by more than the boost
      return boss.send(queue, payload, {
        singletonKey,
        priority: fairPriority(a.live) + (opts?.priorityBoost ?? 0),
        ...(expireInSeconds ? { expireInSeconds } : {}),
        ...(opts?.db ? { db: opts.db } : {}),
      });
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
      const res = await exec.executeSql(`select id from pgboss.job where name = $1 and singleton_key = $2 and state in ('created','retry','active')`, [
        queue,
        key,
      ]);
      const ids = (res.rows as Array<{ id: string }>).map((r) => r.id);
      if (ids.length) await boss.cancel(queue, ids, opts?.db ? { db: opts.db } : undefined);
    },
  };
}
