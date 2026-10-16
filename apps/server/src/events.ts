import { EventEmitter, on } from "node:events";
import pg from "pg";
import type { Config } from "./config.js";
import { schema, type Db } from "./db/index.js";
import type { ProjectEvent, ProjectEventType } from "@reelsaw/shared";
import type { Logger } from "./log.js";

export const EVENTS_CHANNEL = "reelsaw_events";
const CHANNEL = EVENTS_CHANNEL;

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
