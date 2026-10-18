/**
 * Quotas: instance-wide numbers (0 = unlimited) from the runtime settings (the environment or the
 * admin's override, instance-settings.ts), overridable per user by an admin (`user_settings.limits`). Refusals are sentences the user can act on. Checked where the
 * number is known: project count and rate at creation, source minutes once ffprobe has run.
 */
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { schema, type Db } from "./db/index.js";
import type { RuntimeSettings } from "./instance-settings.js";
import type { Admission } from "./queue/boss.js";

export const LIMIT_KEYS = ["MAX_PROJECTS_PER_USER", "MAX_SOURCE_MINUTES_PER_DAY", "MAX_NEW_PROJECTS_PER_HOUR", "MAX_LIVE_JOBS_PER_USER", "MAX_RERENDERS_PER_HOUR", "MAX_STORAGE_MB"] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type Limits = Record<LimitKey, number>;
/** The instance-wide numbers in force (`svc.settings.get()`): the environment, or the admin's runtime override. */
export type InstanceLimits = Pick<RuntimeSettings, LimitKey>;

export async function limitsFor(db: Db, instance: InstanceLimits, userId: string): Promise<Limits> {
  const row = await db.query.userSettings.findFirst({ where: eq(schema.userSettings.userId, userId), columns: { limits: true } });
  const out = {} as Limits;
  for (const k of LIMIT_KEYS) {
    const o = row?.limits?.[k];
    out[k] = typeof o === "number" && o >= 0 ? o : instance[k];
  }
  return out;
}

export class QuotaError extends TRPCError {
  constructor(message: string) {
    super({ code: "TOO_MANY_REQUESTS", message });
  }
}

const nextMidnightUtc = () => new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").getTime() + 86_400_000;
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + " UTC";

/**
 * Before creating a project. Pass the creating unit of work's `u.db` with `lock: true`: a per-user transaction lock
 * then serialises concurrent creates of one user, so the counts below include every project committed before this one
 * and N parallel requests can't all pass a cap they jointly exceed. (Without `lock` it is only an early, advisory check.)
 */
export async function checkProjectQuota(db: Db, instance: InstanceLimits, userId: string, o: { lock?: boolean } = {}) {
  if (o.lock) await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`quota:${userId}`}))`);
  const l = await limitsFor(db, instance, userId);
  if (l.MAX_STORAGE_MB > 0) checkStorage(l, await storedBytes(db, userId));
  if (l.MAX_PROJECTS_PER_USER > 0) {
    // a deleted project frees its slot at once (it is only kept for undo)
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.projects).where(and(eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt)));
    if (n >= l.MAX_PROJECTS_PER_USER) throw new QuotaError(`You have ${n} projects, the most this account may keep (${l.MAX_PROJECTS_PER_USER}). Delete one to start another.`);
  }
  if (l.MAX_NEW_PROJECTS_PER_HOUR > 0) {
    const since = new Date(Date.now() - 3_600_000);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.projects).where(and(eq(schema.projects.userId, userId), gte(schema.projects.createdAt, since)));
    if (n >= l.MAX_NEW_PROJECTS_PER_HOUR) throw new QuotaError(`${n} projects started in the last hour, the most allowed (${l.MAX_NEW_PROJECTS_PER_HOUR}). Try again in a while.`);
  }
  if (l.MAX_SOURCE_MINUTES_PER_DAY > 0) {
    const used = await minutesToday(db, userId);
    if (used >= l.MAX_SOURCE_MINUTES_PER_DAY) throw new QuotaError(`Daily limit of ${l.MAX_SOURCE_MINUTES_PER_DAY} minutes of video reached (${Math.round(used)} used); resets at ${hhmm(nextMidnightUtc())}.`);
  }
}

/**
 * Before work a person asked for is queued (uow.ts `enqueue`, under the user's job lock): jobs in flight
 * across every queue, and renders / new clips asked for in the last hour. `admission` already counts the
 * unit's own earlier enqueues, so a bulk re-render that would pass the limit is refused whole.
 */
export function checkJobLimits(l: Limits, a: Admission, isRender: boolean) {
  if (l.MAX_LIVE_JOBS_PER_USER > 0 && a.live >= l.MAX_LIVE_JOBS_PER_USER)
    throw new QuotaError(`You have ${a.live} jobs queued or running, the most this account may have at once (${l.MAX_LIVE_JOBS_PER_USER}). Try again when some have finished.`);
  if (isRender && l.MAX_RERENDERS_PER_HOUR > 0 && a.userRendersLastHour >= l.MAX_RERENDERS_PER_HOUR)
    throw new QuotaError(`${a.userRendersLastHour} renders requested in the last hour, the most allowed (${l.MAX_RERENDERS_PER_HOUR}). Try again in a while.`);
}

/** Before an upload or a new project: what the account stores now (sources, uploads, renders, intros/outros) plus what is arriving. */
export async function checkStorageQuota(db: Db, instance: InstanceLimits, userId: string, incomingBytes = 0) {
  const l = await limitsFor(db, instance, userId);
  if (l.MAX_STORAGE_MB > 0) checkStorage(l, (await storedBytes(db, userId)) + incomingBytes);
}

function checkStorage(l: Limits, bytes: number) {
  if (l.MAX_STORAGE_MB <= 0) return;
  const mb = Math.round(bytes / 1_048_576);
  if (mb >= l.MAX_STORAGE_MB) throw new QuotaError(`This account stores ${mb} MB, the most allowed is ${l.MAX_STORAGE_MB} MB. Delete projects or uploads to make room.`);
}

/**
 * Bytes one account keeps in storage: downloaded sources, uploads, rendered clips and intro/outro assets (removed
 * ones too until the purge). Thumbnails and scratch files are not counted. `output_bytes` counts only while
 * `output_key` is set (a re-render or retention clears the key); clips rendered before it existed count 0.
 */
export async function storedBytes(db: Db, userId: string): Promise<number> {
  const [r] = (await db.execute(sql`
    select
      coalesce((select sum(source_bytes) from projects where user_id = ${userId}), 0)
      + coalesce((select sum(size_bytes) from uploads where user_id = ${userId}), 0)
      + coalesce((select sum(c.output_bytes) from clips c join projects p on p.id = c.project_id where p.user_id = ${userId} and c.output_key is not null), 0)
      + coalesce((select sum(size_bytes) from bumper_assets where user_id = ${userId}), 0) as bytes`)).rows as Array<{ bytes: string | number }>;
  return Number(r?.bytes ?? 0);
}

/** After ffprobe, when the length is known. Returns a sentence to fail the project with, or null. */
export async function sourceMinutesExceeded(db: Db, instance: InstanceLimits, userId: string, projectId: string, durationSec: number): Promise<string | null> {
  const l = await limitsFor(db, instance, userId);
  if (l.MAX_SOURCE_MINUTES_PER_DAY <= 0) return null;
  const used = await minutesToday(db, userId, projectId);
  const total = used + durationSec / 60;
  if (total <= l.MAX_SOURCE_MINUTES_PER_DAY) return null;
  return `This video is ${Math.round(durationSec / 60)} minutes; with ${Math.round(used)} already used today that passes the daily limit of ${l.MAX_SOURCE_MINUTES_PER_DAY} minutes. Resets at ${hhmm(nextMidnightUtc())}.`;
}

async function minutesToday(db: Db, userId: string, exceptProjectId?: string) {
  const start = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const [{ m }] = await db
    .select({ m: sql<number>`coalesce(sum(${schema.projects.durationSec}), 0) / 60.0` })
    .from(schema.projects)
    .where(and(eq(schema.projects.userId, userId), gte(schema.projects.createdAt, start), exceptProjectId ? sql`${schema.projects.id} <> ${exceptProjectId}` : undefined));
  return Number(m);
}

/** What each limit counts right now, for the admin Limits dialog: kept projects, minutes since 00:00 UTC, projects in the last hour, jobs in flight, renders asked for in the last hour, MB stored. */
export async function limitUsage(db: Db, userId: string): Promise<Record<LimitKey, number>> {
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(schema.projects).where(and(eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt)));
  const [{ hour }] = await db
    .select({ hour: sql<number>`count(*)::int` })
    .from(schema.projects)
    .where(and(eq(schema.projects.userId, userId), gte(schema.projects.createdAt, new Date(Date.now() - 3_600_000))));
  const [jobs] = (await db.execute(sql`
    select
      (select count(*)::int from pgboss.job where state in ('created','retry','active') and data->>'userId' = ${userId}) as live,
      (select count(*)::int from pgboss.job where name in ('clip.render','clip.prepare') and data->>'by' = 'user' and data->>'userId' = ${userId} and created_on > now() - interval '1 hour') as renders`)).rows as Array<{ live: number; renders: number }>;
  return {
    MAX_PROJECTS_PER_USER: total,
    MAX_SOURCE_MINUTES_PER_DAY: Math.round(await minutesToday(db, userId)),
    MAX_NEW_PROJECTS_PER_HOUR: hour,
    MAX_LIVE_JOBS_PER_USER: Number(jobs?.live ?? 0),
    MAX_RERENDERS_PER_HOUR: Number(jobs?.renders ?? 0),
    MAX_STORAGE_MB: Math.round((await storedBytes(db, userId)) / 1_048_576),
  };
}

/**
 * Per-user usage over the last `days`: projects, minutes of source, clips rendered, model calls, tokens and the
 * cost providers reported, seconds of audio transcribed, stored bytes (all time: sources, uploads, renders, intros/outros). One grouped query per metric table over `userIds` (the page the caller is showing), merged here;
 * without ids it covers the first 500 accounts.
 */
export async function usageByUser(db: Db, days: number | null, userIds?: string[]) {
  const ids = userIds ?? (await db.select({ id: schema.user.id }).from(schema.user).orderBy(schema.user.createdAt).limit(500)).map((u) => u.id);
  if (!ids.length) return [];
  // null = all time
  const since = days == null ? sql`'-infinity'::timestamptz` : sql`now() - make_interval(days => ${days}::int)`;
  const { projects: P, clips: C, uploads: U, llmUsage: L, sttUsage: S, bumperAssets: B } = schema;
  const [proj, clip, up, llm, stt, rendered, bump] = await Promise.all([
    db
      .select({
        id: P.userId,
        projects: sql<number>`(count(*) filter (where ${P.createdAt} >= ${since}))::int`,
        projectsTotal: sql<number>`count(*)::int`,
        sourceMinutes: sql<number>`coalesce(sum(${P.durationSec}) filter (where ${P.createdAt} >= ${since}), 0) / 60.0`,
        sourceBytes: sql<number>`coalesce(sum(${P.sourceBytes}), 0)`,
      })
      .from(P)
      .where(inArray(P.userId, ids))
      .groupBy(P.userId),
    db
      .select({ id: P.userId, clipsRendered: sql<number>`count(*)::int` })
      .from(C)
      .innerJoin(P, eq(P.id, C.projectId))
      .where(and(inArray(P.userId, ids), eq(C.status, "done"), sql`${C.updatedAt} >= ${since}`))
      .groupBy(P.userId),
    db.select({ id: U.userId, bytes: sql<number>`coalesce(sum(${U.sizeBytes}), 0)` }).from(U).where(inArray(U.userId, ids)).groupBy(U.userId),
    db
      .select({
        id: L.userId,
        llmCalls: sql<number>`count(*)::int`,
        llmInputTokens: sql<number>`coalesce(sum(${L.inputTokens}), 0)`,
        llmOutputTokens: sql<number>`coalesce(sum(${L.outputTokens}), 0)`,
        llmCostUsd: sql<number | null>`sum(${L.costUsd})`,
      })
      .from(L)
      .where(and(inArray(L.userId, ids), sql`${L.createdAt} >= ${since}`))
      .groupBy(L.userId),
    db
      .select({ id: S.userId, sttCalls: sql<number>`count(*)::int`, sttSeconds: sql<number>`coalesce(sum(${S.audioSec}), 0)` })
      .from(S)
      .where(and(inArray(S.userId, ids), sql`${S.createdAt} >= ${since}`))
      .groupBy(S.userId),
    db
      .select({ id: P.userId, bytes: sql<number>`coalesce(sum(${C.outputBytes}), 0)` })
      .from(C)
      .innerJoin(P, eq(P.id, C.projectId))
      .where(and(inArray(P.userId, ids), sql`${C.outputKey} is not null`))
      .groupBy(P.userId),
    db.select({ id: B.userId, bytes: sql<number>`coalesce(sum(${B.sizeBytes}), 0)` }).from(B).where(inArray(B.userId, ids)).groupBy(B.userId),
  ]);
  const by = <T extends { id: string | null }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const [pm, cm, um, lm, sm, rm, bm] = [by(proj), by(clip), by(up), by(llm), by(stt), by(rendered), by(bump)];
  return ids.map((id) => {
    const p = pm.get(id);
    const l = lm.get(id);
    const s = sm.get(id);
    return {
      id,
      projects: p?.projects ?? 0,
      projectsTotal: p?.projectsTotal ?? 0,
      sourceMinutes: Math.round(Number(p?.sourceMinutes ?? 0)),
      clipsRendered: cm.get(id)?.clipsRendered ?? 0,
      storedBytes: Number(p?.sourceBytes ?? 0) + Number(um.get(id)?.bytes ?? 0) + Number(rm.get(id)?.bytes ?? 0) + Number(bm.get(id)?.bytes ?? 0),
      llmCalls: l?.llmCalls ?? 0,
      llmInputTokens: Number(l?.llmInputTokens ?? 0),
      llmOutputTokens: Number(l?.llmOutputTokens ?? 0),
      /** null when no call in the window reported a price (self-hosted and most direct providers) */
      llmCostUsd: l?.llmCostUsd == null ? null : Number(Number(l.llmCostUsd).toFixed(4)),
      sttCalls: s?.sttCalls ?? 0,
      sttMinutes: Math.round(Number(s?.sttSeconds ?? 0) / 6) / 10,
    };
  });
}
