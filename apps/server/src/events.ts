import { EventEmitter, on } from "node:events";
import pg from "pg";
import type { Config } from "./config.js";
import { schema, type Db } from "./db/index.js";
import type { ProjectEvent, ProjectEventType } from "@reelsaw/shared";
import type { Logger } from "./log.js";

const CHANNEL = "reelsaw_events";

export interface EventNotice {
  id: number;
  projectId: string;
}

/**
 * Project event log + cross-process fan-out. Events are persisted (audit + catch-up) and a
 * Postgres NOTIFY wakes every API process holding a LISTEN connection.
 */
export interface EventBus {
  emit(projectId: string, type: ProjectEventType, payload?: Record<string, unknown>): Promise<ProjectEvent>;
  list(projectId: string, afterId?: number, limit?: number): Promise<ProjectEvent[]>;
  /** Live notices for one project. Ends when `signal` aborts. Requires start(). */
  notices(projectId: string, signal?: AbortSignal): AsyncIterable<EventNotice>;
  /** Open the LISTEN connection (API processes only). */
  start(): Promise<void>;
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
      try {
        const notice = JSON.parse(msg.payload) as EventNotice;
        emitter.emit(`project:${notice.projectId}`, notice);
      } catch {
        /* malformed payload */
      }
    });
    c.on("error", (err) => {
      log.error({ err }, "listener error, reconnecting");
      reconnect();
    });
    c.on("end", () => {
      if (!stopped) reconnect();
    });
    await c.connect();
    await c.query(`LISTEN ${CHANNEL}`);
    client = c;
  }
  function reconnect() {
    if (stopped) return;
    client?.removeAllListeners();
    client = undefined;
    starting = undefined;
    setTimeout(() => bus.start().catch((e) => log.error({ err: e }, "reconnect failed")), 2000);
  }

  const bus: EventBus = {
    async emit(projectId, type, payload = {}) {
      const [row] = await db.insert(schema.projectEvents).values({ projectId, type, payload }).returning();
      // NOTIFY payloads are limited to 8000 bytes: send ids only, listeners fetch rows.
      await pool.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify({ id: row!.id, projectId })]);
      return { id: row!.id, projectId, type, payload, createdAt: row!.createdAt.toISOString() };
    },
    async list(projectId, afterId = 0, limit = 500) {
      const rows = await db.query.projectEvents.findMany({
        where: (t, { and, eq, gt }) => and(eq(t.projectId, projectId), gt(t.id, afterId)),
        orderBy: (t, { asc }) => asc(t.id),
        limit,
      });
      return rows.map((r) => ({ id: r.id, projectId: r.projectId, type: r.type, payload: r.payload, createdAt: r.createdAt.toISOString() }));
    },
    async *notices(projectId, signal) {
      try {
        for await (const [notice] of on(emitter, `project:${projectId}`, { signal }) as AsyncIterable<[EventNotice]>) yield notice;
      } catch (err) {
        if ((err as Error).name !== "AbortError") throw err;
      }
    },
    start() {
      starting ??= connect();
      return starting;
    },
    async stop() {
      stopped = true;
      await client?.end().catch(() => {});
    },
  };
  return bus;
}
