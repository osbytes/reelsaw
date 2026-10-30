/**
 * Live queue depth from pg-boss: waiting / running / retrying per stage, plus the jobs that are in
 * flight. Failed work that operators retry lives in ops/failures.ts (projects/clips), not here —
 * pg-boss drops failed rows after three days.
 */
import { inArray, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import { QUEUES } from "../queue/boss.js";
import type { Services } from "../services.js";

export const QUEUE_ORDER = Object.values(QUEUES);
const ACTIVE_LIMIT = 50;

const QUEUE_LABEL: Record<string, string> = {
  [QUEUES.ingest]: "ingest",
  [QUEUES.transcribe]: "transcribe",
  [QUEUES.refineEntities]: "names",
  [QUEUES.refineDisfluency]: "fillers",
  [QUEUES.refineScenes]: "scenes",
  [QUEUES.analyze]: "analyze",
  [QUEUES.render]: "render",
  [QUEUES.prepare]: "prepare",
};

export function queueLabel(name: string): string {
  return QUEUE_LABEL[name] ?? name.split(".").pop() ?? name;
}

export interface QueueDepth {
  queue: string;
  label: string;
  waiting: number;
  running: number;
  retrying: number;
  failed: number;
}

export interface ActiveJob {
  queue: string;
  label: string;
  state: string;
  projectId: string | null;
  clipId: string | null;
  title?: string | undefined;
  attempt: number;
  startedAt: string | null;
  createdAt: string;
}

export interface QueueSummary {
  queues: QueueDepth[];
  active: ActiveJob[];
  truncated: boolean;
  error?: string;
}

export function foldCounts(rows: Array<{ name: string; state: string; n: number }>): QueueDepth[] {
  const by = new Map<string, QueueDepth>();
  const ensure = (queue: string) => {
    let row = by.get(queue);
    if (!row) {
      row = { queue, label: queueLabel(queue), waiting: 0, running: 0, retrying: 0, failed: 0 };
      by.set(queue, row);
    }
    return row;
  };
  for (const q of QUEUE_ORDER) ensure(q);
  for (const r of rows) {
    const row = ensure(r.name);
    if (r.state === "created") row.waiting += r.n;
    else if (r.state === "active") row.running += r.n;
    else if (r.state === "retry") row.retrying += r.n;
    else if (r.state === "failed") row.failed += r.n;
  }
  const known = new Set<string>(QUEUE_ORDER);
  const extra = [...by.keys()].filter((k) => !known.has(k)).sort();
  return [...QUEUE_ORDER, ...extra].map((k) => by.get(k)!);
}

type CountRow = { name: string; state: string; n: number };
type ActiveRow = {
  name: string;
  state: string;
  retries: number;
  projectId: string | null;
  clipId: string | null;
  startedOn: Date | null;
  createdOn: Date;
};

export async function summarizeQueue(svc: Services): Promise<QueueSummary> {
  const db = svc.database.db;
  try {
    const counts = await db.execute<CountRow>(sql`select name, state, count(*)::int as n from pgboss.job group by 1, 2 order by 1, 2`);
    const active = await db.execute<ActiveRow>(sql`
      select name, state, retry_count as retries, data->>'projectId' as "projectId", data->>'clipId' as "clipId",
             started_on as "startedOn", created_on as "createdOn"
      from pgboss.job
      where state in ('created','retry','active')
      order by started_on desc nulls last, created_on
      limit ${ACTIVE_LIMIT + 1}`);
    const rows = active.rows.slice(0, ACTIVE_LIMIT);
    const ids = [...new Set(rows.map((r) => r.projectId).filter((id): id is string => !!id))];
    const titles = ids.length
      ? await db.select({ id: schema.projects.id, title: schema.projects.title }).from(schema.projects).where(inArray(schema.projects.id, ids))
      : [];
    const byId = new Map(titles.map((t) => [t.id, t.title]));
    return {
      queues: foldCounts(counts.rows),
      active: rows.map((r) => ({
        queue: r.name,
        label: queueLabel(r.name),
        state: r.state,
        projectId: r.projectId,
        clipId: r.clipId,
        ...(r.projectId && byId.get(r.projectId) ? { title: byId.get(r.projectId) } : {}),
        attempt: r.retries + 1,
        startedAt: r.startedOn?.toISOString() ?? null,
        createdAt: r.createdOn.toISOString(),
      })),
      truncated: active.rows.length > ACTIVE_LIMIT,
    };
  } catch (err) {
    return { queues: foldCounts([]), active: [], truncated: false, error: (err as Error).message };
  }
}
