/**
 * The Projects page's server side: one keyset page of a user's projects with per-card clip facts from a
 * single grouped query over the page's ids (never all of the user's clips), plus the header stats and the
 * light "what is running" query that keeps running cards live.
 */
import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { ProjectStatus } from "@reelsaw/shared";
import { schema, type Db } from "./db/index.js";
import { projectBumperSummaries } from "./bumpers/service.js";
import { decodeCursor, pageOf } from "./pagination.js";

export const ACTIVE_STATUSES = ["queued", "ingesting", "transcribing", "refining", "analyzing", "rendering"] as const satisfies readonly ProjectStatus[];

type Facts = { clipCount: number; clipsDone: number; clipsFailed: number; clipThumbIds: string[]; firstThumbId: string | null; overrides: Array<{ intro?: string | null; outro?: string | null }> };

/** Clip counts, first thumbnails and per-clip bumper overrides for a set of projects: one query, grouped by project. */
async function clipFacts(db: Db, projectIds: string[]): Promise<Map<string, Facts>> {
  if (!projectIds.length) return new Map();
  const C = schema.clips;
  const rows = await db
    .select({
      projectId: C.projectId,
      clipCount: sql<number>`count(*)::int`,
      clipsDone: sql<number>`(count(*) filter (where ${C.status} = 'done'))::int`,
      clipsFailed: sql<number>`(count(*) filter (where ${C.status} = 'failed'))::int`,
      clipThumbIds: sql<string[]>`coalesce((array_agg(${C.id} order by ${C.index}) filter (where ${C.status} = 'done' and ${C.thumbnailKey} is not null))[1:3], '{}')`,
      firstThumbId: sql<string | null>`(array_agg(${C.id} order by ${C.index}) filter (where ${C.thumbnailKey} is not null))[1]`,
      overrides: sql<Facts["overrides"]>`coalesce(jsonb_agg(${C.bumpers} order by ${C.index}) filter (where ${C.bumpers} is not null), '[]'::jsonb)`,
    })
    .from(C)
    .where(and(inArray(C.projectId, projectIds), isNull(C.deletedAt)))
    .groupBy(C.projectId);
  return new Map(rows.map((r) => [r.projectId, r]));
}

/** `deleted: true` lists only deleted (still restorable) projects; otherwise deleted ones are left out. */
export type ListInput = { cursor?: string; limit: number; status?: ProjectStatus; deleted?: boolean };

export async function listProjectsPage(db: Db, userId: string, input: ListInput) {
  const P = schema.projects;
  const conds: SQL[] = [eq(P.userId, userId), input.deleted ? isNotNull(P.deletedAt) : isNull(P.deletedAt)];
  if (input.status) conds.push(eq(P.status, input.status));
  const base = and(...conds);
  if (input.cursor) {
    const c = decodeCursor(input.cursor, 2);
    if (!c) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
    conds.push(sql`(${P.updatedAt}, ${P.id}) < (${String(c[0])}::timestamptz, ${String(c[1])})`);
  }
  const [fetched, [{ total }]] = await Promise.all([
    db
      .select({ row: P, ts: sql<string>`${P.updatedAt}::text` })
      .from(P)
      .where(and(...conds))
      .orderBy(desc(P.updatedAt), desc(P.id))
      .limit(input.limit + 1),
    db.select({ total: sql<number>`count(*)::int` }).from(P).where(base),
  ]);
  const { items, nextCursor } = pageOf(fetched, input.limit, (r) => [r.ts, r.row.id]);
  const rows = items.map((r) => r.row);
  const facts = await clipFacts(db, rows.map((r) => r.id));
  const bumperSummaries = await projectBumperSummaries(
    db,
    userId,
    rows.map((p) => {
      const f = facts.get(p.id);
      // coverage needs per-clip overrides only; the clips without one inherit the project's setting
      const clips = f ? [...f.overrides.map((bumpers) => ({ bumpers })), ...Array.from({ length: f.clipCount - f.overrides.length }, () => ({ bumpers: null }))] : [];
      return { id: p.id, settings: p.settings, clips };
    }),
  );
  return {
    rows: rows.map((p) => {
      const f = facts.get(p.id);
      const sourceThumb = (p.sourceMeta?.thumbnail as string | undefined) ?? null;
      return {
        p,
        clipCount: f?.clipCount ?? 0,
        clipsDone: f?.clipsDone ?? 0,
        clipsFailed: f?.clipsFailed ?? 0,
        sourceThumbnailUrl: sourceThumb,
        clipThumbs: (f?.clipThumbIds ?? []).map((id) => `/media/clips/${p.id}/${id}.jpg`),
        bumpers: bumperSummaries.get(p.id) ?? { intro: null, outro: null },
        thumbnailUrl: f?.firstThumbId ? `/media/clips/${p.id}/${f.firstThumbId}.jpg` : sourceThumb,
        deletedAt: p.deletedAt?.toISOString() ?? null,
      };
    }),
    nextCursor,
    total,
  };
}

/** Header numbers for the Projects page: all of the user's projects, how many are processing, clips rendered. */
export async function projectStats(db: Db, userId: string) {
  const [[a], [b]] = await Promise.all([
    db
      .select({ total: sql<number>`count(*)::int`, running: sql<number>`(count(*) filter (where ${inArray(schema.projects.status, [...ACTIVE_STATUSES])}))::int` })
      .from(schema.projects)
      .where(and(eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt))),
    db
      .select({ clipsDone: sql<number>`count(*)::int` })
      .from(schema.clips)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.clips.projectId))
      .where(and(eq(schema.projects.userId, userId), eq(schema.clips.status, "done"), isNull(schema.projects.deletedAt), isNull(schema.clips.deletedAt))),
  ]);
  return { total: a!.total, running: a!.running, clipsDone: b!.clipsDone };
}

/** Only the projects that are processing right now: id, status, stage and progress. Cheap enough to poll. */
export async function activeProjects(db: Db, userId: string) {
  const P = schema.projects;
  return db
    .select({ id: P.id, status: P.status, stage: P.stage, stageProgress: P.stageProgress, updatedAt: P.updatedAt })
    .from(P)
    .where(and(eq(P.userId, userId), inArray(P.status, [...ACTIVE_STATUSES]), isNull(P.deletedAt)))
    .orderBy(desc(P.updatedAt))
    .limit(100);
}
