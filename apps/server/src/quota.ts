/**
 * Quotas: instance-wide numbers from the environment (0 = unlimited), overridable per user by an
 * admin (`user_settings.limits`). Refusals are sentences the user can act on. Checked where the
 * number is known: project count and rate at creation, source minutes once ffprobe has run.
 */
import { and, eq, gte, sql } from "drizzle-orm";
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

/** Before creating a project. */
export async function checkProjectQuota(db: Db, config: Config, userId: string) {
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

/** Per-user usage over the last `days`: projects, minutes of source, clips rendered, model calls and tokens, stored bytes. */
export async function usageByUser(db: Db, days: number) {
  const since = sql`now() - make_interval(days => ${days}::int)`;
  const uid = sql.raw('"user"."id"');
  const rows = await db
    .select({
      id: schema.user.id,
      projects: sql<number>`(select count(*)::int from projects p where p.user_id = ${uid} and p.created_at >= ${since})`,
      projectsTotal: sql<number>`(select count(*)::int from projects p where p.user_id = ${uid})`,
      sourceMinutes: sql<number>`(select coalesce(sum(p.duration_sec), 0) / 60.0 from projects p where p.user_id = ${uid} and p.created_at >= ${since})`,
      clipsRendered: sql<number>`(select count(*)::int from clips c join projects p on p.id = c.project_id where p.user_id = ${uid} and c.status = 'done' and c.updated_at >= ${since})`,
      storedBytes: sql<number>`(select coalesce(sum(p.source_bytes), 0) from projects p where p.user_id = ${uid}) + (select coalesce(sum(u.size_bytes), 0) from uploads u where u.user_id = ${uid})`,
      llmCalls: sql<number>`(select count(*)::int from llm_usage l where l.user_id = ${uid} and l.created_at >= ${since})`,
      llmInputTokens: sql<number>`(select coalesce(sum(l.input_tokens), 0) from llm_usage l where l.user_id = ${uid} and l.created_at >= ${since})`,
      llmOutputTokens: sql<number>`(select coalesce(sum(l.output_tokens), 0) from llm_usage l where l.user_id = ${uid} and l.created_at >= ${since})`,
    })
    .from(schema.user)
    .limit(500);
  return rows.map((r) => ({ ...r, sourceMinutes: Math.round(Number(r.sourceMinutes)), storedBytes: Number(r.storedBytes), llmInputTokens: Number(r.llmInputTokens), llmOutputTokens: Number(r.llmOutputTokens) }));
}
