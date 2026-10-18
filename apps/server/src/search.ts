/**
 * Palette and MCP search, done in SQL so the cost follows the page of results, not the size of the
 * account. Words are ANDed; each must appear (case-insensitive substring) in a project title, or in
 * a clip's title, hook or caption. Substring matching is served by the pg_trgm GIN indexes
 * (migration 0028). Everything is scoped to the user and ordered by how recently the project changed.
 */
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { schema, type Db } from "./db/index.js";

export const SEARCH_PROJECTS = 8;
export const SEARCH_CLIPS = 15;
/** the most words of a query that are matched (the rest are ignored) */
const MAX_WORDS = 6;

/** Escape `\`, `%` and `_` so user text is matched literally by LIKE / ILIKE. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
const words = (q: string) => q.trim().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
const contains = (col: Parameters<typeof ilike>[0], w: string) => ilike(col, `%${escapeLike(w)}%`);

type ProjectRow = Pick<schema.Project, "id" | "title" | "status" | "durationSec" | "sourceUrl" | "updatedAt" | "sourceMeta">;
const PROJECT_COLUMNS = { id: true, title: true, status: true, durationSec: true, sourceMeta: true, sourceUrl: true, updatedAt: true } as const;

/** Clip counts per project for exactly these projects (one grouped query), as the palette shows them. */
async function clipFacts(db: Db, ids: string[]) {
  const facts = new Map<string, { clipCount: number; clipsDone: number; failedClipIds: string[] }>();
  if (!ids.length) return facts;
  const rows = await db.select({ projectId: schema.clips.projectId, id: schema.clips.id, status: schema.clips.status }).from(schema.clips).where(inArray(schema.clips.projectId, ids));
  for (const c of rows) {
    const f = facts.get(c.projectId) ?? { clipCount: 0, clipsDone: 0, failedClipIds: [] };
    f.clipCount++;
    if (c.status === "done") f.clipsDone++;
    if (c.status === "failed") f.failedClipIds.push(c.id);
    facts.set(c.projectId, f);
  }
  return facts;
}

async function projectRows(db: Db, rows: ProjectRow[]) {
  const facts = await clipFacts(db, rows.map((p) => p.id));
  return rows.map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    durationSec: p.durationSec,
    sourceUrl: p.sourceUrl,
    updatedAt: p.updatedAt.toISOString(),
    thumbnailUrl: (p.sourceMeta?.thumbnail as string | undefined) ?? null,
    ...(facts.get(p.id) ?? { clipCount: 0, clipsDone: 0, failedClipIds: [] as string[] }),
  }));
}
export type SearchProject = Awaited<ReturnType<typeof projectRows>>[number];

/** The user's most recently changed projects (the palette's list before anything is typed). */
export async function recentProjects(db: Db, userId: string, limit = 20) {
  const rows = await db.query.projects.findMany({ where: eq(schema.projects.userId, userId), columns: PROJECT_COLUMNS, orderBy: desc(schema.projects.updatedAt), limit });
  return projectRows(db, rows);
}

export interface SearchInput {
  q: string;
  /** most clips returned */
  limit?: number;
  /**
   * Link needles (a YouTube id, or host + path): projects whose source link contains one of them, so the
   * client can tell whether a pasted link already has a project. The client decides which candidates really match.
   */
  links?: string[];
}

export async function searchLibrary(db: Db, userId: string, input: SearchInput) {
  const limit = input.limit ?? SEARCH_CLIPS;
  const mine = eq(schema.projects.userId, userId);
  if (input.links?.length) {
    const rows = await db.query.projects.findMany({ where: and(mine, or(...input.links.map((n) => contains(schema.projects.sourceUrl, n)))), columns: PROJECT_COLUMNS, orderBy: desc(schema.projects.updatedAt), limit: 50 });
    return { projects: await projectRows(db, rows), clips: [], truncated: false };
  }
  const ws = words(input.q);
  if (!ws.length) return { projects: await recentProjects(db, userId, SEARCH_PROJECTS), clips: [], truncated: false };

  const projectRowsFound = await db.query.projects.findMany({
    where: and(mine, ...ws.map((w) => contains(schema.projects.title, w))),
    columns: PROJECT_COLUMNS,
    orderBy: desc(schema.projects.updatedAt),
    limit: SEARCH_PROJECTS + 1,
  });
  const clipMatch: SQL[] = ws.map((w) => or(contains(schema.clips.title, w), contains(schema.clips.hook, w), contains(schema.clips.caption, w))!);
  const clipRowsFound = await db
    .select({
      id: schema.clips.id,
      projectId: schema.clips.projectId,
      projectTitle: schema.projects.title,
      title: schema.clips.title,
      hook: schema.clips.hook,
      caption: schema.clips.caption,
      index: schema.clips.index,
      status: schema.clips.status,
      startSec: schema.clips.startSec,
      endSec: schema.clips.endSec,
      outputKey: schema.clips.outputKey,
      thumbnailKey: schema.clips.thumbnailKey,
    })
    .from(schema.clips)
    .innerJoin(schema.projects, eq(schema.clips.projectId, schema.projects.id))
    .where(and(mine, ...clipMatch))
    .orderBy(desc(schema.projects.updatedAt), asc(schema.clips.index))
    .limit(limit + 1);
  const truncated = projectRowsFound.length > SEARCH_PROJECTS || clipRowsFound.length > limit;
  return {
    projects: await projectRows(db, projectRowsFound.slice(0, SEARCH_PROJECTS)),
    clips: clipRowsFound.slice(0, limit).map((c) => ({
      id: c.id,
      projectId: c.projectId,
      projectTitle: c.projectTitle,
      title: c.title,
      hook: c.hook,
      caption: c.caption,
      index: c.index,
      status: c.status,
      startSec: c.startSec,
      endSec: c.endSec,
      videoUrl: c.outputKey ? `/media/clips/${c.projectId}/${c.id}.mp4` : null,
      thumbnailUrl: c.thumbnailKey ? `/media/clips/${c.projectId}/${c.id}.jpg` : null,
    })),
    truncated,
  };
}

/** Failed work across the account, for the palette's "Retry all failed" commands (ids capped; the counts are exact). */
export async function failedCounts(db: Db, userId: string) {
  const failedClip = and(eq(schema.projects.userId, userId), eq(schema.clips.status, "failed"));
  const [[clipTotals], clipIds, projectIds] = await Promise.all([
    db.select({ clips: count(), projects: sql<number>`count(distinct ${schema.clips.projectId})` }).from(schema.clips).innerJoin(schema.projects, eq(schema.clips.projectId, schema.projects.id)).where(failedClip),
    db.select({ id: schema.clips.id }).from(schema.clips).innerJoin(schema.projects, eq(schema.clips.projectId, schema.projects.id)).where(failedClip).limit(500),
    db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.userId, userId), eq(schema.projects.status, "failed"))).limit(200),
  ]);
  return {
    failedClips: Number(clipTotals?.clips ?? 0),
    failedClipProjects: Number(clipTotals?.projects ?? 0),
    failedProjects: projectIds.length,
    failedClipIds: clipIds.map((c) => c.id),
    failedProjectIds: projectIds.map((p) => p.id),
  };
}
