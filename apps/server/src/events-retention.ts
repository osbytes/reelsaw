/**
 * History pruning: project_events, llm_usage, stt_usage, admin_events and user_decisions older than their retention are deleted
 * in batches by id (keyset), from the reconciler, at most once a day per table.
 *
 * `planPruneBatch` is the pure part: given one page of rows in id order it says which ids to delete
 * and where to resume. Rows are ordered by id, which tracks time, so the scan stops at the first
 * row newer than the cutoff and the cursor never moves past rows that are merely too young.
 * Protected event types (the run skeleton the Activity tab and `runsOf` read) are skipped, so the
 * cursor does move past them and they are never rescanned. They go with the project (cascade).
 * user_decisions is the exception (`byTime`): backfilled rows get new ids but old times, so id order does not track
 * time there, and it is pruned by created_at instead.
 */
import type { Services } from "./services.js";
import type { RuntimeSettings } from "./instance-settings.js";
import { deadlineIn, expired } from "./lib/batch.js";
import { getState, setState } from "./lib/state.js";

export const PRUNE_BATCH = 5000;
export const PRUNE_BUDGET_MS = 60_000;
export const PRUNE_EVERY_MS = 24 * 60 * 60_000;
export const PROTECTED_EVENT_TYPES = ["project.created", "run.started", "project.done"] as const;

export function retentionCutoff(days: number, now = Date.now()): Date | null {
  return days > 0 ? new Date(now - days * 86_400_000) : null;
}

export interface PruneRow {
  id: number;
  type?: string | undefined;
  createdAt: Date;
}
export interface PrunePlan {
  deleteIds: number[];
  /** resume after this id next time (unchanged when the page held nothing old) */
  cursor: number;
  /** no more old rows to look at: the page was short or reached a row newer than the cutoff */
  done: boolean;
}

export function planPruneBatch(rows: PruneRow[], cursor: number, cutoff: Date, size = PRUNE_BATCH, protectedTypes: readonly string[] = []): PrunePlan {
  const deleteIds: number[] = [];
  let next = cursor;
  let reachedYoung = false;
  for (const r of rows) {
    if (r.createdAt >= cutoff) {
      reachedYoung = true;
      break;
    }
    next = r.id;
    if (r.type && protectedTypes.includes(r.type)) continue;
    deleteIds.push(r.id);
  }
  return { deleteIds, cursor: next, done: reachedYoung || rows.length < size };
}

const TABLES = {
  events: { table: "project_events", typed: true, days: (c: RuntimeSettings) => c.EVENT_RETENTION_DAYS },
  llm: { table: "llm_usage", typed: false, days: (c: RuntimeSettings) => c.LLM_USAGE_RETENTION_DAYS },
  stt: { table: "stt_usage", typed: false, days: (c: RuntimeSettings) => c.LLM_USAGE_RETENTION_DAYS },
  admin: { table: "admin_events", typed: false, days: (c: RuntimeSettings) => c.ADMIN_EVENT_RETENTION_DAYS },
  decisions: { table: "user_decisions", typed: false, byTime: true, days: (c: RuntimeSettings) => c.DECISION_RETENTION_DAYS },
} as const;
type Which = keyof typeof TABLES;
interface PruneState {
  [k: string]: { cursor?: number; doneAt?: number };
}

/** Prune one table until done or the deadline. Returns rows deleted and whether the pass finished. */
async function pruneTable(
  svc: Services,
  which: Which,
  cutoff: Date,
  startCursor: number,
  deadline: number,
): Promise<{ deleted: number; cursor: number; done: boolean }> {
  const { table, typed } = TABLES[which];
  const pool = svc.database.pool;
  let cursor = startCursor;
  let deleted = 0;
  if ("byTime" in TABLES[which]) {
    for (;;) {
      if (expired(deadline)) return { deleted, cursor, done: false };
      const r = await pool.query(`delete from ${table} where id in (select id from ${table} where created_at < $1 limit ${PRUNE_BATCH})`, [cutoff]);
      deleted += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < PRUNE_BATCH) return { deleted, cursor, done: true };
    }
  }
  for (;;) {
    if (expired(deadline)) return { deleted, cursor, done: false };
    const page = await pool.query<{ id: string; type?: string; created_at: Date }>(
      `select id, ${typed ? "type," : ""} created_at from ${table} where id > $1 order by id limit ${PRUNE_BATCH}`,
      [cursor],
    );
    const rows = page.rows.map((r) => ({ id: Number(r.id), type: r.type, createdAt: r.created_at }));
    const plan = planPruneBatch(rows, cursor, cutoff, PRUNE_BATCH, typed && which === "events" ? PROTECTED_EVENT_TYPES : []);
    if (plan.deleteIds.length) {
      await pool.query(`delete from ${table} where id = any($1::bigint[])`, [plan.deleteIds]);
      deleted += plan.deleteIds.length;
    }
    cursor = plan.cursor;
    if (plan.done) return { deleted, cursor, done: true };
  }
}

/**
 * Daily, batched, resumable. A pass that hits the time budget saves its cursor and is not marked
 * done, so the next reconciler tick (5 min) continues it; a big backlog is cleared over a few ticks
 * without ever holding a long transaction (each batch is its own short delete).
 */
export async function pruneHistory(svc: Services, now = Date.now()): Promise<Record<string, number>> {
  const log = svc.log.child({ module: "prune" });
  const db = svc.database.db;
  const state = (await getState<PruneState>(db, "prune_state")) as PruneState;
  const deadline = deadlineIn(PRUNE_BUDGET_MS, now);
  const out: Record<string, number> = {};
  let changed = false;
  for (const which of Object.keys(TABLES) as Which[]) {
    const cutoff = retentionCutoff(TABLES[which].days(svc.settings.get()), now);
    if (!cutoff) continue;
    const s = state[which] ?? {};
    if (s.doneAt && now - s.doneAt < PRUNE_EVERY_MS) continue;
    if (expired(deadline)) break;
    const r = await pruneTable(svc, which, cutoff, s.cursor ?? 0, deadline);
    state[which] = { cursor: r.cursor, ...(r.done ? { doneAt: now } : {}) };
    changed = true;
    out[which] = r.deleted;
    if (r.deleted) log.info({ table: TABLES[which].table, deleted: r.deleted, finished: r.done }, "pruned old rows");
  }
  if (changed) await setState(db, "prune_state", state);
  return out;
}
