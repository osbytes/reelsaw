/**
 * One email when projects finish, if the account has stepped away.
 *
 * Same shape as Basecamp (bundle a few minutes of news, and don't mail someone who is in the
 * app), Linear (a digest only for what is still unread) and Discourse (`last_seen_at` is the
 * cutoff; already-seen posts are skipped):
 *
 * `readyEmail` is a `project.done` handler (event-handlers.ts) keyed by the account, so its job
 * commits with the completion and runs `COMPLETION_NOTIFY_MINUTES` later. It opts into both kinds of
 * concurrency (pg-boss `stately`): a completion while a job is still waiting joins it (the job reads
 * every unseen `project.done` when it runs, so the late one is included), and at most one job per
 * account runs at once, so two runs never mail the same batch side by side. The send is skipped for
 * anything at or before `user.last_active_at` (presence.ts). Nothing is queued when email is off.
 *
 * `completion_notices` records which events were mailed. A crash after a successful send and before
 * that record sends the same batch again with the same idempotency key (`completionIdempotencyKey`):
 * Resend drops the repeat within its 24-hour window; SMTP gets the same Message-ID, which some inboxes
 * collapse and others show twice (SMTP has no dedup of its own).
 */
import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { defineEventHandlers } from "../event-handlers.js";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import type { UnitOfWork } from "../uow.js";
import { templates } from "../email.js";

/** Round numbers worth a line in the note. 1 is "your first", announced ahead of any higher one crossed in the same batch. */
export const MILESTONES = [1, 10, 25, 50, 100] as const;

const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** One more than one note covers, so a full page schedules a follow-up for the rest. */
const FETCH_LIMIT = 41;
const SHOW = 8;
const HIGHLIGHTS = 3;

export interface DoneNotice {
  eventId: number;
  projectId: string;
  title: string;
  /** unix ms */
  at: number;
  clips: number;
  failed: number;
  rerender: boolean;
}

/** Completions strictly after the account was last active, and not older than the lookback. */
export function selectUnseen(events: DoneNotice[], lastActiveMs: number | null, nowMs: number, lookbackMs = LOOKBACK_MS): DoneNotice[] {
  const cutoff = nowMs - lookbackMs;
  return events.filter((e) => e.at > cutoff && (lastActiveMs === null || e.at > lastActiveMs));
}

/**
 * The milestone this batch crossed. The first project wins over a higher number crossed in the
 * same batch (a first note that also happens to be the tenth still says "first"). Otherwise the
 * highest one crossed, so jumping 8 → 26 says 25 and not only 10.
 */
export function milestoneCrossed(before: number, after: number): number | null {
  const hit = MILESTONES.filter((m) => before < m && m <= after);
  if (hit.includes(1)) return 1;
  return hit.length ? hit[hit.length - 1]! : null;
}

/** First word of a display name, for "Hi Ada". An address or a blank is no greeting. */
export function greetingName(name: string): string | null {
  const n = name.trim();
  if (!n || n.includes("@")) return null;
  const first = n.split(/\s+/)[0] ?? "";
  return first.length > 0 && first.length <= 40 ? first : null;
}

export interface CollapsedProject {
  id: string;
  title: string;
  clips: number;
  failed: number;
  rerender: boolean;
  eventIds: number[];
}

/** One row per project, fields from the latest event, every event id kept so each run is recorded as mailed. */
export function collapseProjects(events: DoneNotice[]): CollapsedProject[] {
  const byId = new Map<string, CollapsedProject>();
  for (const e of [...events].sort((a, b) => a.at - b.at || a.eventId - b.eventId)) {
    const cur = byId.get(e.projectId);
    if (!cur) {
      byId.set(e.projectId, { id: e.projectId, title: e.title, clips: e.clips, failed: e.failed, rerender: e.rerender, eventIds: [e.eventId] });
      continue;
    }
    cur.title = e.title;
    cur.clips = e.clips;
    cur.failed = e.failed;
    cur.rerender = e.rerender;
    cur.eventIds.push(e.eventId);
  }
  return [...byId.values()];
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function clipLabel(hook: string, title: string): string {
  const raw = hook.trim() || title.trim();
  if (!raw) return "";
  return raw.length > 80 ? `${raw.slice(0, 79)}…` : raw;
}

/**
 * Send the ready note for everything this account finished after they were last here. Idempotent;
 * the handler's queue runs one at a time per account. `again` queues the rest of a batch cut short.
 */
export async function deliverCompletionNotice(svc: Services, userId: string, again?: (u: UnitOfWork) => Promise<string | null>): Promise<void> {
  const log = svc.log.child({ module: "notify", userId });
  if (!svc.email.enabled) {
    log.debug({ reason: "email off" }, "completion notice skipped");
    return;
  }
  const db = svc.database.db;
  const user = await db.query.user.findFirst({
    where: eq(schema.user.id, userId),
    columns: { id: true, email: true, name: true, banned: true, approvedAt: true, lastActiveAt: true },
  });
  if (!user || user.banned || !user.approvedAt || !user.email) {
    log.debug({ reason: !user ? "gone" : user.banned ? "suspended" : !user.approvedAt ? "pending" : "no email" }, "completion notice skipped");
    return;
  }

  const lastActiveAt = user.lastActiveAt;
  const cutoff = new Date(Date.now() - LOOKBACK_MS);
  const rows = await db
    .select({
      eventId: schema.projectEvents.id,
      at: schema.projectEvents.createdAt,
      payload: schema.projectEvents.payload,
      projectId: schema.projects.id,
      title: schema.projects.title,
    })
    .from(schema.projectEvents)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectEvents.projectId))
    .where(and(
      eq(schema.projects.userId, userId),
      isNull(schema.projects.deletedAt),
      eq(schema.projectEvents.type, "project.done"),
      gt(schema.projectEvents.createdAt, cutoff),
      lastActiveAt ? gt(schema.projectEvents.createdAt, lastActiveAt) : sql`true`,
      sql`not exists (select 1 from completion_notices n where n.event_id = ${schema.projectEvents.id})`,
    ))
    .orderBy(asc(schema.projectEvents.createdAt))
    .limit(FETCH_LIMIT);

  const truncated = rows.length > FETCH_LIMIT - 1;
  const page = truncated ? rows.slice(0, FETCH_LIMIT - 1) : rows;
  const notices: DoneNotice[] = page.map((r) => ({
    eventId: Number(r.eventId),
    projectId: r.projectId,
    title: r.title,
    at: r.at.getTime(),
    clips: num(r.payload.clips),
    failed: num(r.payload.failed),
    rerender: r.payload.runReason === "rerender",
  }));
  const mine = selectUnseen(notices, lastActiveAt?.getTime() ?? null, Date.now());
  if (!mine.length) {
    log.debug({ reason: "nothing unseen" }, "completion notice skipped");
    return;
  }

  const projects = collapseProjects(mine);
  const clipRows = await db
    .select({ projectId: schema.clips.projectId, title: schema.clips.title, hook: schema.clips.hook, status: schema.clips.status })
    .from(schema.clips)
    .where(and(inArray(schema.clips.projectId, projects.map((p) => p.id)), isNull(schema.clips.deletedAt)))
    .orderBy(asc(schema.clips.startSec));
  const byProject = new Map<string, Array<{ hook: string; title: string; status: string }>>();
  for (const c of clipRows) {
    const list = byProject.get(c.projectId) ?? [];
    list.push(c);
    byProject.set(c.projectId, list);
  }

  const finishedRow = await db
    .select({ n: sql<number>`count(distinct ${schema.projectEvents.projectId})::int` })
    .from(schema.projectEvents)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectEvents.projectId))
    .where(and(eq(schema.projects.userId, userId), eq(schema.projectEvents.type, "project.done")));
  const finished = finishedRow[0]?.n ?? projects.length;
  const firsts = await db
    .select({ projectId: schema.projectEvents.projectId, firstId: sql<number>`min(${schema.projectEvents.id})` })
    .from(schema.projectEvents)
    .where(and(eq(schema.projectEvents.type, "project.done"), inArray(schema.projectEvents.projectId, projects.map((p) => p.id))))
    .groupBy(schema.projectEvents.projectId);
  const ownedIds = new Set(mine.map((e) => Number(e.eventId)));
  const firstTime = firsts.filter((f) => ownedIds.has(Number(f.firstId))).length;
  const milestone = milestoneCrossed(finished - firstTime, finished);

  const shown = projects.slice(0, SHOW);
  const mailProjects = shown.map((p) => {
    const names: string[] = [];
    for (const c of byProject.get(p.id) ?? []) {
      if (c.status !== "done") continue;
      const label = clipLabel(c.hook, c.title);
      if (label && !names.includes(label)) names.push(label);
    }
    return {
      id: p.id,
      title: p.title,
      clips: p.clips,
      failed: p.failed,
      rerender: p.rerender,
      highlights: names.slice(0, HIGHLIGHTS),
      more: Math.max(0, names.length - HIGHLIGHTS),
    };
  });

  const sent = mine.map((e) => e.eventId);
  // The send sits outside a transaction on purpose: one held open across the mail provider's network
  // call would hold its connection for as long as the provider takes. No other run for this account
  // can start meanwhile (the handler runs one at a time per account), and the idempotency key (same
  // events, same key) lets Resend drop the repeat if this run dies before the record below commits.
  try {
    await svc.email.send(
      { to: user.email, ...templates.clipsReady(svc.config.APP_URL, { greeting: greetingName(user.name), projects: mailProjects, hidden: projects.length - shown.length, milestone }) },
      { strict: true, idempotencyKey: completionIdempotencyKey(userId, sent) },
    );
  } catch (err) {
    log.error({ err, events: sent.length }, "completion notice not sent");
    throw err;
  }
  // the record and the follow-up for a page that was cut short commit together
  const followUp = await svc.tx(async (u) => {
    await u.db.insert(schema.completionNotices).values(sent.map((eventId) => ({ eventId, userId }))).onConflictDoNothing();
    return truncated && again ? again(u) : null;
  });
  log.info({ projects: projects.length, events: sent.length, ...(milestone ? { milestone } : {}) }, "completion notice sent");
  if (truncated) log.warn({ queued: !!followUp, held: FETCH_LIMIT - 1 }, "completion notice truncated");
}

/**
 * The provider's dedup key for one batch: the account and the events it covers, order-free. A
 * retry of the same batch sends the same key; a batch that gained an event is a different note.
 */
export function completionIdempotencyKey(userId: string, eventIds: number[]): string {
  const ids = [...eventIds].sort((a, b) => a - b).join(",");
  return `ready-${createHash("sha256").update(`${userId}:${ids}`).digest("hex").slice(0, 40)}`;
}

/**
 * The ready note as a `project.done` handler (event-handlers.ts), keyed by the account: a completion
 * joins a note still waiting, and one note per account is sent at a time. Nothing when email is off.
 */
export const readyEmailHandlers = defineEventHandlers({
  "project.done": {
    readyEmail: {
      async key({ event, db, deps }) {
        if (!deps.email.enabled) return null;
        const [project] = await db.select({ userId: schema.projects.userId }).from(schema.projects).where(eq(schema.projects.id, event.projectId));
        return project?.userId ?? null;
      },
      delaySeconds: (deps) => deps.settings.get().COMPLETION_NOTIFY_MINUTES * 60,
      coalesce: true,
      oneAtATime: true,
      // a minute apart with backoff; a run is failed after 2 min (a send takes seconds; Resend times out at 15 s)
      retryLimit: 3,
      expireInSeconds: 120,
      handle: ({ key, svc, again }) => deliverCompletionNotice(svc, key, (u) => again(u, { delaySeconds: 60 })),
    },
  },
});
