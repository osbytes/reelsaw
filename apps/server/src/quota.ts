/**
 * Quotas: instance-wide numbers from the environment (0 = unlimited), overridable per user by an
 * admin (`user_settings.limits`). Refusals are sentences the user can act on. Checked where the
 * number is known: project count and rate at creation, source minutes once ffprobe has run.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { schema, type Db } from "./db/index.js";
import type { Config } from "./config.js";

export const LIMIT_KEYS = ["MAX_PROJECTS_PER_USER", "MAX_SOURCE_MINUTES_PER_DAY", "MAX_NEW_PROJECTS_PER_HOUR"] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
export type Limits = Record<LimitKey, number>;

export async function limitsFor(db: Db, config: Config, userId: string): Promise<Limits> {
  const row = await db.query.userSettings.findFirst({ where: eq(schema.userSettings.userId, userId), columns: { limits: true } });
  const out = {} as Limits;
  for (const k of LIMIT_KEYS) {
    const o = row?.limits?.[k];
    out[k] = typeof o === "number" && o >= 0 ? o : config[k];
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
export async function checkProjectQuota(db: Db, config: Config, userId: string, o: { lock?: boolean } = {}) {
  if (o.lock) await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`quota:${userId}`}))`);
  const l = await limitsFor(db, config, userId);
  if (l.MAX_PROJECTS_PER_USER > 0) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.projects).where(eq(schema.projects.userId, userId));
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

/** After ffprobe, when the length is known. Returns a sentence to fail the project with, or null. */
export async function sourceMinutesExceeded(db: Db, config: Config, userId: string, projectId: string, durationSec: number): Promise<string | null> {
  const l = await limitsFor(db, config, userId);
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

/** What each limit counts right now, for the admin Limits dialog: kept projects, minutes since 00:00 UTC, projects in the last hour. */
export async function limitUsage(db: Db, userId: string): Promise<Record<LimitKey, number>> {
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(schema.projects).where(eq(schema.projects.userId, userId));
  const [{ hour }] = await db
    .select({ hour: sql<number>`count(*)::int` })
    .from(schema.projects)
    .where(and(eq(schema.projects.userId, userId), gte(schema.projects.createdAt, new Date(Date.now() - 3_600_000))));
  return { MAX_PROJECTS_PER_USER: total, MAX_SOURCE_MINUTES_PER_DAY: Math.round(await minutesToday(db, userId)), MAX_NEW_PROJECTS_PER_HOUR: hour };
}

/**
 * Per-user usage over the last `days`: projects, minutes of source, clips rendered, model calls and tokens,
 * stored bytes. One grouped query per metric table over `userIds` (the page the caller is showing), merged here;
 * without ids it covers the first 500 accounts.
 */
export async function usageByUser(db: Db, days: number | null, userIds?: string[]) {
  const ids = userIds ?? (await db.select({ id: schema.user.id }).from(schema.user).orderBy(schema.user.createdAt).limit(500)).map((u) => u.id);
  if (!ids.length) return [];
  // null = all time
  const since = days == null ? sql`'-infinity'::timestamptz` : sql`now() - make_interval(days => ${days}::int)`;
  const { projects: P, clips: C, uploads: U, llmUsage: L } = schema;
  const [proj, clip, up, llm] = await Promise.all([
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
      })
      .from(L)
      .where(and(inArray(L.userId, ids), sql`${L.createdAt} >= ${since}`))
      .groupBy(L.userId),
  ]);
  const by = <T extends { id: string | null }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const [pm, cm, um, lm] = [by(proj), by(clip), by(up), by(llm)];
  return ids.map((id) => {
    const p = pm.get(id);
    const l = lm.get(id);
    return {
      id,
      projects: p?.projects ?? 0,
      projectsTotal: p?.projectsTotal ?? 0,
      sourceMinutes: Math.round(Number(p?.sourceMinutes ?? 0)),
      clipsRendered: cm.get(id)?.clipsRendered ?? 0,
      storedBytes: Number(p?.sourceBytes ?? 0) + Number(um.get(id)?.bytes ?? 0),
      llmCalls: l?.llmCalls ?? 0,
      llmInputTokens: Number(l?.llmInputTokens ?? 0),
      llmOutputTokens: Number(l?.llmOutputTokens ?? 0),
    };
  });
}
