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
 * finish (a re-render's) is above it and mailed. Milestones count the account's finished projects in
 * the usage ledger (`source_usage.first_done_event_id`), which deleting, purging and forgetting what
 * Reelsaw learned never touch, so a count never goes down and re-announces one. A crash after a successful send and before the mark
 * sends the same batch again with the same idempotency key (`completionIdempotencyKey`):
 * Resend drops the repeat within its 24-hour window; SMTP gets the same Message-ID, which some inboxes
 * collapse and others show twice (SMTP has no dedup of its own).
 */
import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { finiteNumber, firstName, truncate } from "@reelsaw/shared";
import type { EventHandler } from "../event-handlers.js";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import { templates } from "../email.js";
import { unsubscribeUrl, wantsEmail } from "./preferences.js";

/** Round numbers worth a line in the note. 1 is "your first", announced ahead of any higher one crossed in the same batch. */
export const MILESTONES = [1, 10, 25, 50, 100] as const;

const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** Projects listed in full; the rest of a big batch is one "And N more on your projects page" line, in the same note. */
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

/**
 * Send the ready note for everything this account finished after they were last here: one note,
 * however many finished (the first SHOW listed, the rest counted). Idempotent; the handler's queue
 * runs one at a time per account.
 */
export async function deliverCompletionNotice(svc: Services, userId: string): Promise<void> {
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
    .orderBy(asc(schema.events.id));

  // the query above is the one definition of "unseen": inside the lookback, after the last activity, not yet mailed
  const mine: DoneNotice[] = rows.map((r) => ({
    eventId: Number(r.eventId),
    projectId: r.projectId,
    title: r.title,
    at: r.at.getTime(),
    clips: finiteNumber(r.payload.clips),
    failed: finiteNumber(r.payload.failed),
    rerender: r.payload.runReason === "rerender",
  }));
  if (!mine.length) {
    log.debug({ reason: "nothing unseen" }, "completion notice skipped");
    return;
  }

  const projects = collapseProjects(mine);
  const shown = projects.slice(0, SHOW);
  const clipRows = await db
    .select({ projectId: schema.clips.projectId, title: schema.clips.title, hook: schema.clips.hook, status: schema.clips.status })
    .from(schema.clips)
    .where(
      and(
        inArray(
          schema.clips.projectId,
          shown.map((p) => p.id),
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

  // Milestones: the account's projects that ever finished, from the usage ledger (never lowered by deleting or
  // forgetting). A project finishes for the first time in this batch when its first project.done is mailed now.
  // a Postgres array literal: drizzle would spread a JS array into a row
  const mailedIds = `{${mine.map((e) => e.eventId).join(",")}}`;
  const { rows: countRows } = await db.execute<{ finished: number; first_time: number }>(sql`
    select count(*)::int as finished, (count(*) filter (where first_done_event_id = any(${mailedIds}::bigint[])))::int as first_time
    from source_usage where user_id = ${userId} and first_done_event_id is not null`);
  const finished = countRows[0]?.finished ?? 0;
  const milestone = milestoneCrossed(finished - (countRows[0]?.first_time ?? 0), finished);

  const mailProjects = shown.map((p) => {
    const names: string[] = [];
    for (const c of byProject.get(p.id) ?? []) {
      if (c.status !== "done") continue;
      const label = truncate(c.hook || c.title, 80);
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
          greeting: firstName(user),
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
  // Every project in the note, listed or counted, is marked mailed in one statement (a mark only moves forward).
  const marks = projects.map((p) => ({ id: p.id, through: Math.max(...p.eventIds) }));
  await db.execute(sql`
    update projects p set ready_mailed_through = greatest(coalesce(p.ready_mailed_through, 0), m.through)
    from jsonb_to_recordset(${JSON.stringify(marks)}::jsonb) as m(id text, through bigint)
    where p.id = m.id`);
  log.info({ projects: projects.length, events: sent.length, ...(milestone ? { milestone } : {}) }, "completion notice sent");
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
  handle: ({ key, svc }) => deliverCompletionNotice(svc, key),
};
