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
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema, type Db } from "./db/index.js";
import type { ProjectEventType } from "@reelsaw/shared";
import { EVENTS_CHANNEL } from "./events.js";
import type { Queue, QueueName, JobData } from "./queue/boss.js";
import type { Logger } from "./log.js";

export interface UnitOfWork {
  /** drizzle bound to the transaction's connection */
  db: Db;
  /** persist an event and NOTIFY listeners; both take effect at commit */
  emit(projectId: string, type: ProjectEventType, payload?: Record<string, unknown>): Promise<number>;
  enqueue(queue: QueueName, data: JobData): Promise<string | null>;
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
  "clip.done": "info",
  "clip.failed": "error",
  "clip.retrying": "warn",
  "clip.bumper_skipped": "warn",
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

export function createUnitOfWork(pool: pg.Pool, queue: Queue, log: Logger): RunInTx {
  return async (fn) => {
    const client = await pool.connect();
    const after: Array<() => Promise<unknown> | unknown> = [];
    const emitted: Array<{ projectId: string; type: string; payload: Record<string, unknown> }> = [];
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
          return row!.id;
        },
        enqueue: (q, data) => queue.enqueue(q, data, exec),
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
    for (const e of emitted) {
      const level = EVENT_LEVEL[e.type] ?? "debug";
      log[level]({ projectId: e.projectId, event: e.type, ...eventFields(e.payload) }, "project event");
    }
    for (const f of after) {
      try {
        await f();
      } catch (err) {
        log.warn({ err }, "after-commit task failed");
      }
    }
    return result;
  };
}
