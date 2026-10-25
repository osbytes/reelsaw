/**
 * One email when projects finish, if the account has stepped away.
 *
 * Same shape as Basecamp (bundle a few minutes of news, and don't mail someone who is in the
 * app), Linear (a digest only for what is still unread) and Discourse (`last_seen_at` is the
 * cutoff; already-seen posts are skipped):
 *
 * The first `project.done` schedules one pg-boss job (`short` policy, `singletonKey` = the
 * account) to run after `COMPLETION_NOTIFY_MINUTES`. A second completion while that job is
 * still waiting is a no-op — the job reads every unseen `project.done` when it runs, so the
 * late one is included. The send is skipped for anything at or before `user.last_active_at`
 * (presence.ts). Nothing is queued when email is off.
 *
 * The job may run twice, and two runs for one account can overlap (`short` only dedups the
 * waiting job; a retry or the next batch can start while one is still sending). Each event is
 * claimed in `completion_notices` with a lease before the send and marked after it: a second run
 * skips what a live lease holds, a failed send gives its claim back for the retry, and a run that
 * died is overtaken once its lease runs out. A crash after a successful send and before the mark
 * can mail twice; that is the rare case.
 */
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import type { Logger } from "../log.js";
import type { UnitOfWork } from "../uow.js";
import { COMPLETION_NOTIFY_QUEUE } from "../queue/boss.js";
import { templates } from "../email.js";

/** Round numbers worth a line in the note. 1 is "your first", announced ahead of any higher one crossed in the same batch. */
export const MILESTONES = [1, 10, 25, 50, 100] as const;

const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * How long a claim belongs to the run that made it. Longer than any send (Resend times out at 15 s,
 * SMTP well inside this) and than the job's expiry, so a run is never overtaken while it is sending.
 */
const CLAIM_LEASE_SEC = 10 * 60;
/** One more than we claim, so a full page schedules a follow-up for the rest. */
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

/** One row per project, fields from the latest event, every event id kept so each run is claimed. */
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
 * Queue the ready note, or no-op when one is already waiting for this account. Returns what happened
 * so a caller (and the tests) can tell a debounce from "email is off".
 */
export async function scheduleCompletionNotify(
  opts: { emailEnabled: boolean; delayMinutes: number; log: Logger; send: UnitOfWork["send"] },
  userId: string,
): Promise<"off" | "queued" | "already"> {
  if (!opts.emailEnabled) return "off";
  const startAfter = opts.delayMinutes * 60;
  const jobId = await opts.send(COMPLETION_NOTIFY_QUEUE, { userId }, { singletonKey: userId, startAfter });
  const log = opts.log.child({ module: "notify", userId });
  if (jobId) log.debug({ jobId, startAfter }, "completion notice queued");
  else log.debug({ startAfter }, "completion notice already queued");
  return jobId ? "queued" : "already";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function clipLabel(hook: string, title: string): string {
  const raw = hook.trim() || title.trim();
  if (!raw) return "";
  return raw.length > 80 ? `${raw.slice(0, 79)}…` : raw;
}

/** Send the ready note for everything this account finished after they were last here. Idempotent. */
export async function deliverCompletionNotice(svc: Services, userId: string): Promise<void> {
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

  // a claim from a send that never went out, for a completion they have since seen, is dropped
  if (user.lastActiveAt) {
    await db.delete(schema.completionNotices).where(and(
      eq(schema.completionNotices.userId, userId),
      isNull(schema.completionNotices.sentAt),
      sql`${schema.completionNotices.eventId} in (select id from project_events where created_at <= ${user.lastActiveAt})`,
    ));
  }

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
      user.lastActiveAt ? gt(schema.projectEvents.createdAt, user.lastActiveAt) : sql`true`,
      sql`not exists (select 1 from completion_notices n where n.event_id = ${schema.projectEvents.id} and n.sent_at is not null)`,
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
  const unseen = selectUnseen(notices, user.lastActiveAt?.getTime() ?? null, Date.now());
  if (!unseen.length) {
    log.debug({ reason: "nothing unseen" }, "completion notice skipped");
    return;
  }

  // One statement claims each event: a new row, or an unsent one whose lease ran out (a run that died
  // mid-send). A live lease belongs to a run still sending (pg-boss can start a retry, or the next
  // batch's job, while an expired one is still running), so it is not taken. RETURNING is what we own.
  const eventIds = unseen.map((e) => e.eventId);
  const N = schema.completionNotices;
  const claimedRows = await db
    .insert(N)
    .values(eventIds.map((eventId) => ({ eventId, userId })))
    .onConflictDoUpdate({
      target: N.eventId,
      set: { claimedAt: sql`now()` },
      setWhere: and(isNull(N.sentAt), sql`${N.claimedAt} < now() - make_interval(secs => ${CLAIM_LEASE_SEC})`),
    })
    .returning({ eventId: N.eventId });
  const owned = new Set(claimedRows.map((r) => r.eventId));
  const mine = unseen.filter((e) => owned.has(e.eventId));
  if (!mine.length) {
    // held by another run: if that run dies, this follow-up (after its lease) sends what it held
    const again = await svc.queue.send(COMPLETION_NOTIFY_QUEUE, { userId }, { singletonKey: userId, startAfter: CLAIM_LEASE_SEC + 30 });
    log.debug({ reason: "already claimed", followUp: !!again }, "completion notice skipped");
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

  const claimed = mine.map((e) => e.eventId);
  try {
    await svc.email.send(
      { to: user.email, ...templates.clipsReady(svc.config.APP_URL, { greeting: greetingName(user.name), projects: mailProjects, hidden: projects.length - shown.length, milestone }) },
      { strict: true },
    );
  } catch (err) {
    // give the claim back so pg-boss's retry (a minute away, inside the lease) can take it again
    await db.update(N).set({ claimedAt: new Date(0) }).where(and(inArray(N.eventId, claimed), isNull(N.sentAt)))
      .catch((e) => log.warn({ err: e }, "completion notice claim not released"));
    log.error({ err, events: claimed.length }, "completion notice not sent");
    throw err;
  }
  await db.update(N).set({ sentAt: new Date() }).where(inArray(N.eventId, claimed));
  log.info({ projects: projects.length, events: claimed.length, ...(milestone ? { milestone } : {}) }, "completion notice sent");

  if (truncated) {
    const again = await svc.queue.send(COMPLETION_NOTIFY_QUEUE, { userId }, { singletonKey: userId, startAfter: 60 });
    log.warn({ queued: !!again, held: FETCH_LIMIT - 1 }, "completion notice truncated");
  }
}
