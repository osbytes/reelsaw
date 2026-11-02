/**
 * One email when projects finish, if the account has stepped away.
 *
 * Same shape as Basecamp (bundle a few minutes of news, and don't mail someone who is in the
 * app), Linear (a digest only for what is still unread) and Discourse (`last_seen_at` is the
 * cutoff; already-seen posts are skipped):
 *
 * `readyEmail` is a `project.done` handler (event-handlers.ts) keyed by the account, so its job
 * commits with the completion and runs `EVENT_PROJECT_DONE_READY_EMAIL_DELAY_MINUTES` later. It opts into both kinds of
 * concurrency (pg-boss `stately`): a completion while a job is still waiting joins it (the job reads
 * every unseen `project.done` when it runs, so the late one is included), and at most one job per
 * account runs at once, so two runs never mail the same batch side by side. The send is skipped for
 * anything at or before `user.last_active_at` (presence.ts: a web tab in front and in use, or MCP). Nothing is queued when email is off, and
 * nothing is sent to an account that turned the note off (notify/preferences.ts; every note carries a
 * one-click unsubscribe, RFC 8058).
 *
 * `projects.ready_mailed_through` marks the last `project.done` each project's note covered; a later
 * finish (a re-render's) is above it and mailed. Milestones count the account's finished projects from
 * the events themselves: a project's events outlive "Delete forever" and retention never prunes
 * `project.done`, so the count does not go down and re-announce one (forgetting what Reelsaw learned
 * does lower it: that is the owner's choice). A crash after a successful send and before the mark
 * sends the same batch again with the same idempotency key (`completionIdempotencyKey`):
 * Resend drops the repeat within its 24-hour window; SMTP gets the same Message-ID, which some inboxes
 * collapse and others show twice (SMTP has no dedup of its own).
 */
import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { EventHandler } from "../event-handlers.js";
import type { UnitOfWork } from "../uow.js";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import { templates } from "../email.js";
import { unsubscribeUrl, wantsEmail } from "./preferences.js";

/** Round numbers worth a line in the note. 1 is "your first", announced ahead of any higher one crossed in the same batch. */
export const MILESTONES = [1, 10, 25, 50, 100] as const;

const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** One more than one note covers, so a full page schedules a follow-up for the rest. */
const FETCH_LIMIT = 41;
/** A batch cut short at FETCH_LIMIT sends the rest this long after. */
const FOLLOW_UP_SEC = 60;
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
    columns: { id: true, email: true, name: true, banned: true, approvedAt: true },
  });
  if (!user || user.banned || !user.approvedAt || !user.email) {
    log.debug({ reason: !user ? "gone" : user.banned ? "suspended" : !user.approvedAt ? "pending" : "no email" }, "completion notice skipped");
    return;
  }
  // read when the job runs, not when it was queued: turning it off during the delay holds the note
  if (!(await wantsEmail(db, userId, "ready"))) {
    log.debug({ reason: "turned off" }, "completion notice skipped");
    return;
  }

  const cutoff = new Date(Date.now() - LOOKBACK_MS);
  const rows = await db
    .select({
      eventId: schema.events.id,
      at: schema.events.createdAt,
      payload: schema.events.payload,
      projectId: schema.projects.id,
      title: schema.projects.title,
    })
    .from(schema.events)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.events.projectId))
    .where(
      and(
        eq(schema.projects.userId, userId),
        isNull(schema.projects.deletedAt),
        eq(schema.events.type, "project.done"),
        gt(schema.events.createdAt, cutoff),
        // compared in SQL: both sides keep Postgres's microseconds, which a JS Date would cut to milliseconds
        sql`${schema.events.createdAt} > coalesce((select u.last_active_at from "user" u where u.id = ${userId}), '-infinity')`,
        // not mailed yet: above the project's mark
        sql`${schema.events.id} > coalesce(${schema.projects.readyMailedThrough}, 0)`,
      ),
    )
    // by id, the order the mark moves in: a page cut short never marks past an event it left out
    .orderBy(asc(schema.events.id))
    .limit(FETCH_LIMIT);

  const truncated = rows.length > FETCH_LIMIT - 1;
  const page = truncated ? rows.slice(0, FETCH_LIMIT - 1) : rows;
  // the query above is the one definition of "unseen": inside the lookback, after the last activity, not yet mailed
  const mine: DoneNotice[] = page.map((r) => ({
    eventId: Number(r.eventId),
    projectId: r.projectId,
    title: r.title,
    at: r.at.getTime(),
    clips: num(r.payload.clips),
    failed: num(r.payload.failed),
    rerender: r.payload.runReason === "rerender",
  }));
  if (!mine.length) {
    log.debug({ reason: "nothing unseen" }, "completion notice skipped");
    return;
  }

  const projects = collapseProjects(mine);
  const clipRows = await db
    .select({ projectId: schema.clips.projectId, title: schema.clips.title, hook: schema.clips.hook, status: schema.clips.status })
    .from(schema.clips)
    .where(
      and(
        inArray(
          schema.clips.projectId,
          projects.map((p) => p.id),
        ),
        isNull(schema.clips.deletedAt),
      ),
    )
    .orderBy(asc(schema.clips.startSec));
  const byProject = new Map<string, Array<{ hook: string; title: string; status: string }>>();
  for (const c of clipRows) {
    const list = byProject.get(c.projectId) ?? [];
    list.push(c);
    byProject.set(c.projectId, list);
  }

  // Milestones: the account's projects that ever finished, from their events (which outlive a purge; retention
  // keeps project.done). A project finishes for the first time in this batch when its first project.done is
  // one of the events being mailed.
  // a Postgres array literal: drizzle would spread a JS array into a row
  const mailedIds = `{${mine.map((e) => e.eventId).join(",")}}`;
  const { rows: countRows } = await db.execute<{ finished: number; first_time: number }>(sql`
    select count(*)::int as finished, (count(*) filter (where f.first_id = any(${mailedIds}::bigint[])))::int as first_time
    from (
      select min(id) as first_id from events
      where user_id = ${userId} and type = 'project.done' and project_id is not null
      group by project_id
    ) f`);
  const finished = countRows[0]?.finished ?? 0;
  const milestone = milestoneCrossed(finished - (countRows[0]?.first_time ?? 0), finished);

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
      {
        to: user.email,
        ...templates.clipsReady(svc.config.APP_URL, {
          greeting: greetingName(user.name),
          projects: mailProjects,
          hidden: projects.length - shown.length,
          milestone,
          unsubscribeUrl: unsubscribeUrl(svc.config.APP_URL, svc.config.BETTER_AUTH_SECRET, userId, "ready"),
        }),
      },
      { strict: true, idempotencyKey: completionIdempotencyKey(userId, sent) },
    );
  } catch (err) {
    log.error({ err, events: sent.length }, "completion notice not sent");
    throw err;
  }
  // The marks and the follow-up for a page cut short commit together: the follow-up exists exactly
  // when this batch is marked as mailed, so neither a failed mark nor a crash leaves a second run
  // re-sending it (the idempotency key only dedups on Resend). A mark only moves forward.
  const followUp = await svc.tx(async (u) => {
    for (const p of projects)
      await u.db
        .update(schema.projects)
        .set({ readyMailedThrough: sql`greatest(coalesce(${schema.projects.readyMailedThrough}, 0), ${Math.max(...p.eventIds)})` })
        .where(eq(schema.projects.id, p.id));
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
 * The ready note as a `project.done` handler (listed in event-handler-map.ts), keyed by the
 * account: a completion joins a note still waiting, and one note per account is sent at a time.
 * Nothing when email is off.
 */
export const readyEmail: EventHandler<"project.done"> = {
  async key({ event, db, deps }) {
    if (!deps.email.enabled) return null;
    const [project] = await db.select({ userId: schema.projects.userId }).from(schema.projects).where(eq(schema.projects.id, event.payload.projectId));
    return project?.userId ?? null;
  },
  delaySeconds: (deps) => deps.settings.get().EVENT_PROJECT_DONE_READY_EMAIL_DELAY_MINUTES * 60,
  coalesce: true,
  oneAtATime: true,
  // a send takes seconds (Resend times out at 15 s): a run stuck for 2 min is failed and retried
  queue: { expireInSeconds: 120 },
  handle: ({ key, svc, again }) => deliverCompletionNotice(svc, key, (u) => again(u, { delaySeconds: FOLLOW_UP_SEC })),
};
