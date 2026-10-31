/**
 * Unit of work: one Postgres transaction that covers a state change *and* its side effects.
 *
 * Row updates, the project event row, the NOTIFY that wakes listeners, and pg-boss job
 * enqueues/cancels all go through the same connection, so they commit together or not at all:
 *   - no event announcing a change that rolled back, no change without its event;
 *   - no clip marked "pending" without its render job (or a job for a change that never happened);
 *   - NOTIFY is delivered by Postgres only at COMMIT, so listeners never read uncommitted state.
 * Read-modify-write on shared rows (transcript flags, a project's terminal status) must lock the
 * row first (`for("update")`) inside the unit so concurrent writers serialize instead of losing
 * each other's changes.
 */
import type pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema, type Db } from "./db/index.js";
import type { ProjectEventType } from "@reelsaw/shared";
import { EVENTS_CHANNEL } from "./events.js";
import { USER_RERUN_QUEUES, type Queue, type QueueName, type JobData } from "./queue/boss.js";
import type { Logger } from "./log.js";
import type { Telemetry } from "./telemetry.js";
import { TX_LOCK_SQL, txLock } from "./locks.js";
import type { Entitlements, InstanceLimits } from "./quota.js";
import { checkJobLimits, limitsFor } from "./quota.js";
import { isWebhookEvent, writeDeliveries } from "./webhooks/outbox.js";

/**
 * Who asked for the work running now. Set around every approved user's tRPC call (protectedProcedure, which MCP
 * and the CLI's acting-as-user calls go through too); absent in workers, the reconciler and operator CLI commands.
 * Jobs a unit enqueues for that user's own projects are their requests: tagged `by: "user"` and admitted against
 * MAX_LIVE_JOBS_PER_USER / MAX_RERENDERS_PER_HOUR. Pipeline hand-offs are never refused.
 */
const requestedBy = new AsyncLocalStorage<{ userId: string; surface: Surface }>();
export function asUserRequest<T>(userId: string, surface: Surface, fn: () => T): T {
  return requestedBy.run({ userId, surface }, fn);
}

/** Where a person's request came in: the browser, an API key over tRPC, an MCP client, or the operator CLI. */
export type Surface = "web" | "api" | "mcp" | "cli";

export interface UnitOfWork {
  /** drizzle bound to the transaction's connection */
  db: Db;
  /** persist an event and NOTIFY listeners; both take effect at commit */
  emit(projectId: string, type: ProjectEventType, payload?: Record<string, unknown>): Promise<number>;
  /** `expireInSeconds` overrides the job's hard expiry; by default analyze/refine jobs size it from the project's duration (queue/boss.ts) */
  enqueue(queue: QueueName, data: JobData, opts?: { expireInSeconds?: number }): Promise<string | null>;
  /** a job outside the pipeline (billing sync, …): no owner, no admission; dedup by `singletonKey` per the queue's policy */
  send(queue: string, data: object, opts?: { singletonKey?: string; startAfterSeconds?: number }): Promise<string | null>;
  cancelLiveJobs(queue: QueueName, key: string): Promise<void>;
  hasLiveJob(queue: QueueName, key: string): Promise<boolean>;
  /** record what a stage decided and which models ran (see schema.stageArtifacts) */
  artifact(projectId: string, stage: string, kind: string, data: unknown, models?: Record<string, string>): Promise<void>;
  /** run after a successful commit (best-effort cleanup such as deleting superseded files) */
  afterCommit(fn: () => Promise<unknown> | unknown): void;
}

export type RunInTx = <T>(fn: (u: UnitOfWork) => Promise<T>) => Promise<T>;

/** Events that are state transitions: logged at the level a person reading the log should care about. */
const EVENT_LEVEL: Record<string, "info" | "warn" | "error"> = {
  "project.created": "info",
  "run.started": "info",
  "stage.started": "info",
  "stage.completed": "info",
  "stage.failed": "warn",
  "project.done": "info",
  "project.failed": "error",
  "project.deleted": "info",
  "project.restored": "info",
  "clip.restored": "info",
  "clip.deleted": "info",
  "project.updated": "info",
  "transcript.imported": "info",
  "clip.done": "info",
  "clip.failed": "error",
  "clip.retrying": "warn",
  "clip.bumper_skipped": "warn",
  "clip.overlay_skipped": "warn",
  "clip.cut_unverified": "warn",
  "job.stalled": "warn",
};

/** The scalar fields of an event payload (counts, durations, reasons), trimmed: enough to read the log without the event feed. */
export function eventFields(payload: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(payload).slice(0, 16)) {
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
  }
  return out;
}

/** Postgres aborted the transaction to break a lock cycle (40P01) or a serialization conflict (40001); nothing was committed. */
export function isRetryableTxError(err: unknown): boolean {
  let e = err as { code?: unknown; cause?: unknown } | undefined;
  for (let i = 0; e && i < 4; i++, e = e.cause as typeof e) if (e.code === "40P01" || e.code === "40001") return true;
  return false;
}

const TX_ATTEMPTS = 3;

/**
 * A committed project event as a product event (telemetry.ts), or null when it is not one. Each event names the
 * properties PostHog may see: ids, counts, durations and enum values, never a title or an error message (those
 * stay in the event feed and the log). A run stopped by deleting the project is `project.cancelled`, not a failure.
 */
export function productEvent(type: string, payload: Record<string, unknown>): { event: string; properties: Record<string, string | number | boolean> } | null {
  const pick = (...keys: string[]) => {
    const out: Record<string, string | number | boolean> = {};
    for (const k of keys) {
      const v = payload[k];
      // strings here are enums and ids (stage, runReason, errorKind); a long one is not, so it stays out
      if (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 64)) out[k] = v;
    }
    return out;
  };
  switch (type) {
    case "project.created":
      return { event: type, properties: pick("sourceType") };
    case "project.done":
      return { event: type, properties: pick("clips", "failed", "runSec", "renderSec", "runReason", "runSeq") };
    case "project.failed":
      return {
        event: payload.cancelled === true ? "project.cancelled" : type,
        properties: pick("stage", "errorKind", "runSec", "renderSec", "runReason", "runSeq"),
      };
    case "clip.done":
      return { event: type, properties: pick("clipId", "renderSec") };
    case "clip.failed":
      return { event: type, properties: pick("clipId", "errorKind") };
    default:
      return null;
  }
}

export function createUnitOfWork(
  pool: pg.Pool,
  queue: Queue,
  log: Logger,
  instanceLimits?: () => InstanceLimits,
  entitlements: () => Entitlements | null = () => null,
  telemetry?: Telemetry,
): RunInTx {
  const once: RunInTx = async (fn) => {
    const client = await pool.connect();
    const after: Array<() => Promise<unknown> | unknown> = [];
    const emitted: Array<{ projectId: string; type: string; payload: Record<string, unknown> }> = [];
    /** jobs a person asked for in this unit (product analytics, sent after commit) */
    const requested: Array<{ queue: QueueName; projectId: string; clipId?: string }> = [];
    let result;
    try {
      await client.query("BEGIN");
      const db = drizzle(client, { schema }) as unknown as Db;
      const exec = { db: { executeSql: (text: string, values?: unknown[]) => client.query(text, values) } };
      const u: UnitOfWork = {
        db,
        async emit(projectId, type, payload = {}) {
          emitted.push({ projectId, type, payload });
          const [row] = await db.insert(schema.projectEvents).values({ projectId, type, payload }).returning({ id: schema.projectEvents.id });
          await client.query("SELECT pg_notify($1, $2)", [EVENTS_CHANNEL, JSON.stringify({ id: row!.id, projectId })]);
          // webhooks: the deliveries and their jobs commit with the event (webhooks/outbox.ts)
          if (isWebhookEvent(type)) await writeDeliveries(exec.db, queue, row!.id, projectId, type);
          return row!.id;
        },
        async enqueue(q, data, opts) {
          let a = await queue.admission(data, exec);
          const who = requestedBy.getStore();
          // the owner's plan may lift the job (hosted Pro); one indexed read, nothing self-hosted
          const ent = entitlements();
          const priorityBoost = ent && a.userId ? ((await ent.grantsFor(db, a.userId))?.queuePriority ?? 0) : 0;
          if (!who || !a.userId || a.userId !== who.userId) return queue.enqueue(q, data, { ...exec, admission: a, priorityBoost, ...opts });
          if (instanceLimits) {
            const limits = await limitsFor(db, instanceLimits(), a.userId, entitlements());
            if (limits.MAX_LIVE_JOBS_PER_USER > 0 || limits.MAX_RERENDERS_PER_HOUR > 0) {
              // one admission at a time per user, counted again under the lock, so two requests can't both take the last slot
              await client.query(TX_LOCK_SQL, [txLock.jobs(a.userId)]);
              a = await queue.admission(data, exec);
              try {
                checkJobLimits(limits, a, USER_RERUN_QUEUES.includes(q));
              } catch (err) {
                log.warn(
                  { userId: a.userId, queue: q, live: a.live, userLive: a.userLive, rendersLastHour: a.userRendersLastHour, reason: (err as Error).message },
                  "job limit reached",
                );
                throw err;
              }
            }
          }
          requested.push({ queue: q, projectId: data.projectId, ...("clipId" in data && typeof data.clipId === "string" ? { clipId: data.clipId } : {}) });
          return queue.enqueue(q, { ...data, by: "user" }, { ...exec, admission: a, priorityBoost, ...opts });
        },
        send: (q, data, opts) => queue.send(q, data, { ...exec, singletonKey: opts?.singletonKey, startAfterSeconds: opts?.startAfterSeconds }),
        cancelLiveJobs: (q, key) => queue.cancelLiveJobs(q, key, exec),
        hasLiveJob: (q, key) => queue.hasLiveJob(q, key, exec),
        async artifact(projectId, stage, kind, data, models = {}) {
          await db.insert(schema.stageArtifacts).values({ projectId, stage, kind, data, models });
        },
        afterCommit: (f) => void after.push(f),
      };
      result = await fn(u);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    // committed: every state transition is also a log line carrying the ids, so a log alone tells the story
    const who = requestedBy.getStore();
    for (const e of emitted) {
      const level = EVENT_LEVEL[e.type] ?? "debug";
      log[level]({ projectId: e.projectId, event: e.type, ...eventFields(e.payload) }, "project event");
      const product = telemetry?.enabled.posthog ? productEvent(e.type, e.payload) : null;
      if (telemetry && product) {
        // the owner is the distinct id (an admin acting on someone's project is not them); the surface is the request's
        const properties = { projectId: e.projectId, ...product.properties, ...(who ? { surface: who.surface } : {}) };
        void pool
          .query<{ user_id: string }>("select user_id from projects where id = $1", [e.projectId])
          .then((r) => r.rows[0] && telemetry.capture(product.event, r.rows[0].user_id, properties))
          .catch(() => {});
      }
    }
    // the user's own jobs only (admission above checked the owner), so the requester is the distinct id
    if (who) for (const j of requested) telemetry?.capture("job.requested", who.userId, { ...j, surface: who.surface });
    for (const f of after) {
      try {
        await f();
      } catch (err) {
        log.warn({ err }, "after-commit task failed");
      }
    }
    return result;
  };
  // A deadlock victim is rolled back whole, so running the unit again is safe (its events, jobs and after-commit
  // tasks were only queued in memory) and far cheaper than failing a render job that finished its ffmpeg work.
  return async (fn) => {
    for (let n = 1; ; n++) {
      try {
        return await once(fn);
      } catch (err) {
        if (n >= TX_ATTEMPTS || !isRetryableTxError(err)) throw err;
        log.warn({ err, attempt: n }, "transaction aborted by a lock conflict; retrying");
        await new Promise((r) => setTimeout(r, 20 + Math.random() * 80 * n));
      }
    }
  };
}
