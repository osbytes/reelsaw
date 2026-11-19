/**
 * Live queue depth from pg-boss: waiting / running / retrying per stage, how long jobs waited to be picked up
 * (the last hour), whose work is queued and at what priority, plus the jobs in flight in the order workers take
 * them. Failed work that operators retry lives in ops/failures.ts (projects/clips), not here — pg-boss drops
 * failed rows after three days.
 */
import { inArray, sql } from "drizzle-orm";
import { type RawTime, rawTimeIso, schema } from "../db/index.js";
import { QUEUES, WEBHOOK_QUEUE } from "../queue/boss.js";
import { queuePriorityOf, type QueuePrioritySource } from "../quota.js";
import type { Services } from "../services.js";

export const QUEUE_ORDER = Object.values(QUEUES);
const ACTIVE_LIMIT = 50;
const OWNER_LIMIT = 20;
/** pickup times are measured over jobs that started in this window */
export const PICKUP_WINDOW_MINUTES = 60;

const QUEUE_LABEL: Record<string, string> = {
  [QUEUES.ingest]: "ingest",
  [QUEUES.transcribe]: "transcribe",
  [QUEUES.refineEntities]: "names",
  [QUEUES.refineDisfluency]: "fillers",
  [QUEUES.refineScenes]: "scenes",
  [QUEUES.analyze]: "analyze",
  [QUEUES.render]: "render",
  [QUEUES.prepare]: "prepare",
  [WEBHOOK_QUEUE]: "webhooks",
  "billing.reconcile": "billing sync",
};

/** pg-boss's own bookkeeping queues (`__pgboss__send-it`, …): not work anyone queued, so not shown. */
const isInternal = (name: string) => name.startsWith("__pgboss");

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
  /** when the longest-waiting job that may start now became eligible (start_after has passed); null when none waits */
  oldestWaitingAt: string | null;
  /** how long jobs waited between becoming eligible and a worker picking them up, over the last PICKUP_WINDOW_MINUTES */
  pickup: Pickup;
}

export interface Pickup {
  /** jobs a worker picked up in the window (each attempt counts) */
  started: number;
  /** median and 95th-percentile wait in seconds; null when nothing started */
  p50Sec: number | null;
  p95Sec: number | null;
  maxSec: number | null;
}

/** One account with work queued or running: how much, since when, and the priority its next job gets. */
export interface QueueOwner {
  userId: string;
  email: string | null;
  waiting: number;
  running: number;
  oldestWaitingAt: string | null;
  /** points on the fair-share priority of the account's next job, and where they come from */
  priority: number;
  prioritySource: QueuePrioritySource;
  plan: string | null;
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
  /** a retrying job's previous attempt failed with this (pg-boss keeps it in `output`) */
  lastError?: string | undefined;
  /** pg-boss priority the job was queued with (higher starts first): minus the owner's backlog then, plus their priority */
  priority: number;
  ownerEmail?: string | undefined;
}

export interface QueueSummary {
  queues: QueueDepth[];
  /** every pipeline stage together (webhooks, billing and event handlers left out) */
  pickup: Pickup;
  pickupWindowMinutes: number;
  /** false when asked without the pickup times and accounts (`summarizeQueue` `detail`): those are then empty */
  detail: boolean;
  /** accounts with pipeline work waiting or running, most waiting first */
  owners: QueueOwner[];
  ownersTruncated: boolean;
  /** running first, then waiting in the order workers will take them (eligible by priority then age, then those in a backoff) */
  active: ActiveJob[];
  truncated: boolean;
  error?: string;
}

const NO_PICKUP: Pickup = { started: 0, p50Sec: null, p95Sec: null, maxSec: null };

export function foldCounts(rows: Array<{ name: string; state: string; n: number; oldest?: RawTime | null }>): QueueDepth[] {
  const by = new Map<string, QueueDepth>();
  const ensure = (queue: string) => {
    let row = by.get(queue);
    if (!row) {
      row = { queue, label: queueLabel(queue), waiting: 0, running: 0, retrying: 0, failed: 0, oldestWaitingAt: null, pickup: NO_PICKUP };
      by.set(queue, row);
    }
    return row;
  };
  for (const q of QUEUE_ORDER) ensure(q);
  for (const r of rows) {
    if (isInternal(r.name)) continue;
    const row = ensure(r.name);
    if (r.oldest && (r.state === "created" || r.state === "retry")) {
      const at = rawTimeIso(r.oldest)!;
      if (!row.oldestWaitingAt || at < row.oldestWaitingAt) row.oldestWaitingAt = at;
    }
    if (r.state === "created") row.waiting += r.n;
    else if (r.state === "active") row.running += r.n;
    else if (r.state === "retry") row.retrying += r.n;
    else if (r.state === "failed") row.failed += r.n;
  }
  const known = new Set<string>(QUEUE_ORDER);
  const extra = [...by.keys()].filter((k) => !known.has(k)).sort();
  return [...QUEUE_ORDER, ...extra].map((k) => by.get(k)!);
}

type CountRow = { name: string; state: string; n: number; oldest: RawTime | null };
type PickupRow = { name: string | null; started: number; p50: number | null; p95: number | null; max: number | null };
type OwnerRow = { userId: string; waiting: number; running: number; oldest: RawTime | null };
type ActiveRow = {
  priority: number;
  userId: string | null;
  name: string;
  state: string;
  retries: number;
  projectId: string | null;
  clipId: string | null;
  startedOn: RawTime | null;
  createdOn: RawTime;
  lastError: string | null;
};

const roundSec = (v: number | null) => (v === null ? null : Math.round(Number(v) * 10) / 10);
const toPickup = (r: PickupRow | undefined): Pickup =>
  r?.started ? { started: r.started, p50Sec: roundSec(r.p50), p95Sec: roundSec(r.p95), maxSec: roundSec(r.max) } : NO_PICKUP;

/**
 * `detail: false` leaves out the pickup times and the accounts (empty, `detail` false in the result): the fleet
 * cards poll only the counts, so they don't pay for the window scan and the per-account plan reads. `queues`: which
 * queues pickup times and accounts count (the pipeline stages; a test passes its throwaway queue).
 */
export async function summarizeQueue(
  svc: Pick<Services, "database" | "entitlements">,
  opts: { detail?: boolean; queues?: readonly string[] } = {},
): Promise<QueueSummary> {
  const db = svc.database.db;
  const detail = opts.detail ?? true;
  // a Postgres array literal: drizzle would spread a JS array into a row
  const pipeline = `{${(opts.queues ?? QUEUE_ORDER).join(",")}}`;
  try {
    const none = { rows: [] as never[] };
    const [counts, pickups, owners, active] = await Promise.all([
      db.execute<CountRow>(sql`
        select name, state, count(*)::int as n, min(start_after) filter (where start_after <= now()) as oldest
        from pgboss.job group by 1, 2 order by 1, 2`),
      // wait = picked up (started_on) minus eligible (start_after: queued, or a retry's backoff ended); per stage, and
      // every pipeline stage together (grouping sets: the row with a null name). Completed jobs stay 3 days, so the
      // window has them. A job back in 'retry' keeps its failed attempt's started_on while pg-boss moved start_after
      // past it: not a pickup, so left out (its next start counts).
      detail
        ? db.execute<PickupRow>(sql`
            select name, count(*)::int as started,
              percentile_cont(0.5) within group (order by w) as p50,
              percentile_cont(0.95) within group (order by w) as p95,
              max(w) as max
            from (
              select name, extract(epoch from started_on - start_after)::float8 as w
              from pgboss.job
              where started_on > now() - make_interval(mins => ${PICKUP_WINDOW_MINUTES}) and name = any(${pipeline}::text[])
                and state <> 'retry' and started_on >= start_after
            ) s
            group by grouping sets ((name), ())`)
        : none,
      // whose pipeline work is queued (webhooks, billing and event handlers carry userId too, and are nobody's request)
      detail
        ? db.execute<OwnerRow>(sql`
            select data->>'userId' as "userId",
              (count(*) filter (where state in ('created','retry')))::int as waiting,
              (count(*) filter (where state = 'active'))::int as running,
              min(start_after) filter (where state in ('created','retry') and start_after <= now()) as oldest
            from pgboss.job
            where state in ('created','retry','active') and name = any(${pipeline}::text[]) and data ? 'userId'
            group by 1
            order by waiting desc, running desc, oldest nulls last
            limit ${OWNER_LIMIT + 1}`)
        : none,
      // running first (latest start first), then waiting in pg-boss's fetch order: jobs it may start now by priority desc,
      // created_on; then those still in a retry backoff or scheduled later, soonest first
      db.execute<ActiveRow>(sql`
        select name, state, retry_count as retries, data->>'projectId' as "projectId", data->>'clipId' as "clipId",
               data->>'userId' as "userId", priority,
               started_on as "startedOn", created_on as "createdOn",
               case when state = 'retry' then output->>'message' end as "lastError"
        from pgboss.job
        where state in ('created','retry','active') and left(name, 8) <> '__pgboss'
        order by (state = 'active') desc,
                 case when state = 'active' then started_on end desc nulls last,
                 (start_after <= now()) desc,
                 case when start_after <= now() then priority end desc,
                 case when start_after > now() then start_after end,
                 created_on
        limit ${ACTIVE_LIMIT + 1}`),
    ]);
    const rows = active.rows.slice(0, ACTIVE_LIMIT);
    const ownerRows = owners.rows.slice(0, OWNER_LIMIT);
    const ids = [...new Set(rows.map((r) => r.projectId).filter((id): id is string => !!id))];
    const userIds = [...new Set([...ownerRows.map((r) => r.userId), ...rows.map((r) => r.userId)].filter((id): id is string => !!id))];
    const ownerIds = ownerRows.map((r) => r.userId);
    const S = schema.userSettings;
    const [titles, users, settings] = await Promise.all([
      ids.length ? db.select({ id: schema.projects.id, title: schema.projects.title }).from(schema.projects).where(inArray(schema.projects.id, ids)) : [],
      userIds.length ? db.select({ id: schema.user.id, email: schema.user.email }).from(schema.user).where(inArray(schema.user.id, userIds)) : [],
      ownerIds.length ? db.select({ userId: S.userId, queuePriority: S.queuePriority }).from(S).where(inArray(S.userId, ownerIds)) : [],
    ]);
    const byId = new Map(titles.map((t) => [t.id, t.title]));
    const emailOf = new Map(users.map((u) => [u.id, u.email]));
    const overrideOf = new Map(settings.map((s) => [s.userId, s.queuePriority]));
    // each owner's plan (hosted): at most OWNER_LIMIT indexed reads
    const ent = svc.entitlements;
    const grants = await Promise.all(ownerIds.map((id) => (ent ? ent.grantsFor(db, id) : null)));
    const pickupBy = new Map(pickups.rows.map((r) => [r.name, r]));
    return {
      queues: foldCounts(counts.rows).map((q) => ({ ...q, pickup: toPickup(pickupBy.get(q.queue)) })),
      pickup: toPickup(pickupBy.get(null)),
      pickupWindowMinutes: PICKUP_WINDOW_MINUTES,
      detail,
      owners: ownerRows.map((r, i) => {
        const p = queuePriorityOf(overrideOf.get(r.userId) ?? null, grants[i] ?? null);
        return {
          userId: r.userId,
          email: emailOf.get(r.userId) ?? null,
          waiting: r.waiting,
          running: r.running,
          oldestWaitingAt: rawTimeIso(r.oldest),
          priority: p.value,
          prioritySource: p.source,
          plan: grants[i]?.plan ?? null,
        };
      }),
      ownersTruncated: owners.rows.length > OWNER_LIMIT,
      active: rows.map((r) => ({
        queue: r.name,
        label: queueLabel(r.name),
        state: r.state,
        projectId: r.projectId,
        clipId: r.clipId,
        ...(r.projectId && byId.get(r.projectId) ? { title: byId.get(r.projectId) } : {}),
        attempt: r.retries + 1,
        startedAt: rawTimeIso(r.startedOn),
        createdAt: rawTimeIso(r.createdOn)!,
        ...(r.lastError ? { lastError: r.lastError.slice(0, 500) } : {}),
        priority: r.priority,
        ...(r.userId && emailOf.get(r.userId) ? { ownerEmail: emailOf.get(r.userId) } : {}),
      })),
      truncated: active.rows.length > ACTIVE_LIMIT,
    };
  } catch (err) {
    return {
      queues: foldCounts([]),
      pickup: NO_PICKUP,
      pickupWindowMinutes: PICKUP_WINDOW_MINUTES,
      detail,
      owners: [],
      ownersTruncated: false,
      active: [],
      truncated: false,
      error: (err as Error).message,
    };
  }
}
