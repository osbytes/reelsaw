import { EventEmitter, on } from "node:events";
import pg from "pg";
import { and, count, desc, eq, gt, lt, lte, max, ne } from "drizzle-orm";
import type { Config } from "./config.js";
import { schema, type Db } from "./db/index.js";
import type { ProjectEvent, ProjectEventType } from "@reelsaw/shared";
import type { Logger } from "./log.js";

export const EVENTS_CHANNEL = "reelsaw_events";
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30_000;
const CHANNEL = EVENTS_CHANNEL;

/** NOTIFY payload of a persisted event: ids only, listeners read the row. */
export interface EventNotice {
  id: number;
  projectId: string;
}

/**
 * NOTIFY payload of a progress tick. Ticks are ephemeral: nothing is written to project_events (the
 * projects row keeps the latest value for reloads), so the payload travels inline. Postgres limits a
 * payload to 8000 bytes; we stay under PROGRESS_NOTICE_MAX.
 */
export interface ProgressNotice {
  kind: "progress";
  projectId: string;
  clipId?: string;
  stage: string;
  progress: number;
  message?: string;
}
export type Notice = EventNotice | ProgressNotice;
export const isProgressNotice = (n: Notice): n is ProgressNotice => "kind" in n && n.kind === "progress";
export const PROGRESS_NOTICE_MAX = 500;

/** JSON for pg_notify, at most PROGRESS_NOTICE_MAX bytes: the message is cut (then dropped) to fit. */
export function encodeProgressNotice(n: Omit<ProgressNotice, "kind">): string {
  const base: ProgressNotice = { kind: "progress", projectId: n.projectId, ...(n.clipId ? { clipId: n.clipId } : {}), stage: n.stage, progress: Math.round(n.progress * 10_000) / 10_000 };
  let message = n.message ?? "";
  for (;;) {
    const json = JSON.stringify(message ? { ...base, message } : base);
    if (Buffer.byteLength(json) <= PROGRESS_NOTICE_MAX || !message) return json;
    message = message.length > 40 ? message.slice(0, Math.floor(message.length * 0.7)) : "";
  }
}

/** A notification from the channel, or null when it is not one we understand. */
export function decodeNotice(payload: string): Notice | null {
  try {
    const n = JSON.parse(payload) as Notice;
    if (typeof n?.projectId !== "string") return null;
    if (isProgressNotice(n)) return typeof n.stage === "string" && typeof n.progress === "number" ? n : null;
    return typeof (n as EventNotice).id === "number" ? n : null;
  } catch {
    return null;
  }
}

/** A progress notice as the event-shaped message the stream sends. id 0 = not stored; never used as a resume point. */
export function progressEvent(n: ProgressNotice, now = new Date()): ProjectEvent {
  return { id: 0, projectId: n.projectId, type: "stage.progress", payload: { stage: n.stage, progress: n.progress, ...(n.message ? { message: n.message } : {}), ...(n.clipId ? { clipId: n.clipId } : {}) }, createdAt: now.toISOString() };
}

/**
 * Project event log + cross-process fan-out. Events are persisted (audit + catch-up) and a
 * Postgres NOTIFY wakes every API process holding a LISTEN connection.
 */
export interface EventBus {
  emit(projectId: string, type: ProjectEventType, payload?: Record<string, unknown>): Promise<ProjectEvent>;
  list(projectId: string, afterId?: number, limit?: number): Promise<ProjectEvent[]>;
  /**
   * The log without progress ticks (those are live-only), newest `limit` rows in ascending order.
   * `after` / `before` / `upTo` bound the id range; `hasMore` says older rows exist below the first one returned.
   */
  history(projectId: string, opts: { limit: number; after?: number; before?: number; upTo?: number }): Promise<{ events: ProjectEvent[]; hasMore: boolean }>;
  /** Highest event id of the project (0 if none) and how many non-progress events it has. */
  stats(projectId: string): Promise<{ headId: number; total: number }>;
  /** Live notices for one project. Ends when `signal` aborts. Requires start(). */
  notices(projectId: string, signal?: AbortSignal): AsyncIterable<Notice>;
  /** Live progress tick: NOTIFY only, no row. */
  progress(projectId: string, tick: Omit<ProgressNotice, "kind" | "projectId">): Promise<void>;
  /** Open the LISTEN connection (API processes only). After it, a dropped connection is re-opened with backoff until `stop()`. */
  start(): Promise<void>;
  /** Is the LISTEN connection up right now (the health check)? False before `start()` and while reconnecting. */
  connected(): boolean;
  stop(): Promise<void>;
}

export function createEventBus(config: Config, db: Db, pool: pg.Pool, log: Logger): EventBus {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  let client: pg.Client | undefined;
  let starting: Promise<void> | undefined;
  let stopped = false;

  async function connect() {
    if (stopped) return;
    const c = new pg.Client({ connectionString: config.DATABASE_URL });
    c.on("notification", (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      const notice = decodeNotice(msg.payload);
      if (notice) emitter.emit(`project:${notice.projectId}`, notice);
    });
    c.on("error", (err) => {
      log.error({ err }, "listener error, reconnecting");
      reconnect();
    });
    c.on("end", () => {
      if (!stopped) reconnect();
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${CHANNEL}`);
    } catch (err) {
      // a half-open client must not linger (or crash the process with an unhandled 'error' event)
      c.removeAllListeners();
      c.on("error", () => {});
      void c.end().catch(() => {});
      throw err;
    }
    client = c;
  }
  let reconnecting = false;
  /**
   * Re-open the LISTEN connection after it dropped, retrying with exponential backoff (2 s doubling to a 30 s cap) until it
   * is back or the bus is stopped. One loop at a time: the error and end events of the dying client, and of a failed
   * attempt, all land here and are ignored while it runs. A failed attempt clears `starting`, so `start()` can also retry.
   */
  function reconnect() {
    if (stopped || reconnecting) return;
    reconnecting = true;
    const dead = client;
    client = undefined;
    starting = undefined;
    if (dead) {
      dead.removeAllListeners();
      dead.on("error", () => {});
      void dead.end().catch(() => {});
    }
    void (async () => {
      let attempt = 0;
      let delayMs = RECONNECT_MIN_MS;
      try {
        while (!stopped) {
          await new Promise((r) => setTimeout(r, delayMs).unref());
          if (stopped) return;
          attempt++;
          try {
            starting = connect();
            await starting;
            log.info({ attempt }, "listener reconnected");
            return;
          } catch (err) {
            starting = undefined;
            log.warn({ err, attempt, retryInMs: Math.min(delayMs * 2, RECONNECT_MAX_MS) }, "listener reconnect failed");
            delayMs = Math.min(delayMs * 2, RECONNECT_MAX_MS);
          }
        }
      } finally {
        reconnecting = false;
      }
    })();
  }

  const bus: EventBus = {
    // Standalone event (progress, notices): insert + NOTIFY in ONE statement, so it is atomic.
    // Events tied to a state change go through the unit of work (svc.tx) instead.
    async emit(projectId, type, payload = {}) {
      // NOTIFY payloads are limited to 8000 bytes: send ids only, listeners fetch rows.
      const res = await pool.query<{ id: number; created_at: Date }>(
        `WITH e AS (INSERT INTO project_events (project_id, type, payload) VALUES ($1, $2, $3) RETURNING id, created_at)
         SELECT e.id, e.created_at, pg_notify($4, json_build_object('id', e.id, 'projectId', $1::text)::text) FROM e`,
        [projectId, type, JSON.stringify(payload), CHANNEL],
      );
      const row = res.rows[0]!;
      return { id: Number(row.id), projectId, type, payload, createdAt: new Date(row.created_at).toISOString() };
    },
    async list(projectId, afterId = 0, limit = 500) {
      const rows = await db.query.projectEvents.findMany({
        where: (t, { and, eq, gt }) => and(eq(t.projectId, projectId), gt(t.id, afterId)),
        orderBy: (t, { asc }) => asc(t.id),
        limit,
      });
      return rows.map((r) => ({ id: r.id, projectId: r.projectId, type: r.type, payload: r.payload, createdAt: r.createdAt.toISOString() }));
    },
    async progress(projectId, tick) {
      await pool.query("SELECT pg_notify($1, $2)", [CHANNEL, encodeProgressNotice({ projectId, ...tick })]);
    },
    async history(projectId, { limit, after, before, upTo }) {
      const t = schema.projectEvents;
      const rows = await db
        .select()
        .from(t)
        .where(and(eq(t.projectId, projectId), ne(t.type, "stage.progress"), after !== undefined ? gt(t.id, after) : undefined, before !== undefined ? lt(t.id, before) : undefined, upTo !== undefined ? lte(t.id, upTo) : undefined))
        .orderBy(desc(t.id))
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      return { events: rows.slice(0, limit).reverse().map((r) => ({ id: r.id, projectId: r.projectId, type: r.type, payload: r.payload, createdAt: r.createdAt.toISOString() })), hasMore };
    },
    async stats(projectId) {
      const t = schema.projectEvents;
      const [head] = await db.select({ v: max(t.id) }).from(t).where(eq(t.projectId, projectId));
      const [total] = await db.select({ v: count() }).from(t).where(and(eq(t.projectId, projectId), ne(t.type, "stage.progress")));
      return { headId: Number(head?.v ?? 0), total: Number(total?.v ?? 0) };
    },
    async *notices(projectId, signal) {
      try {
        for await (const [notice] of on(emitter, `project:${projectId}`, { signal }) as AsyncIterable<[Notice]>) yield notice;
      } catch (err) {
        if ((err as Error).name !== "AbortError") throw err;
      }
    },
    start() {
      starting ??= connect().catch((err) => {
        starting = undefined; // a failed first connect can be tried again
        throw err;
      });
      return starting;
    },
    connected: () => !stopped && client !== undefined,
    async stop() {
      stopped = true;
      await client?.end().catch(() => {});
    },
  };
  return bus;
}
