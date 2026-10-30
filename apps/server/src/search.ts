/**
 * Palette and MCP search, done in SQL so the cost follows the page of results, not the size of the
 * account. Words are ANDed; each must match a project title, or a clip's title, hook or caption,
 * either as a case-insensitive substring or (words of 3+ characters) approximately, so typos still
 * find things ("budgt" finds "Budgeting"). Both forms are served by the pg_trgm GIN indexes
 * (migration 0028): ILIKE, and the `<%` word-similarity operator at SEARCH_SIM. Results are ranked by
 * a weighted similarity score with a bonus for literal matches, then by how recently the project changed.
 * Everything is scoped to the user.
 */
import { and, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { schema, type Db } from "./db/index.js";

export const SEARCH_PROJECTS = 8;
export const SEARCH_CLIPS = 15;
/** the Users page shows this many best matches for a search (no paging) */
export const SEARCH_USERS = 100;
/**
 * These mirror the palette's old client-side Fuse config (threshold 0.38; keys title 3, hook 1.5,
 * caption 0.6, project title 1). word_similarity("budgt", "Budgeting") is 0.67, a two-letter typo in
 * a six-letter word about 0.5, unrelated words 0 to 0.2, so 0.4 keeps typos and drops noise.
 */
export const SEARCH_SIM = 0.4;
export const WEIGHT_CLIP_TITLE = 3;
export const WEIGHT_CLIP_HOOK = 1.5;
export const WEIGHT_CLIP_CAPTION = 0.6;
export const WEIGHT_PROJECT_TITLE = 1;
/** added per word that matches literally, so a substring hit always outranks a fuzzy one (fuzzy scores stay below 3) */
export const EXACT_BONUS = 10;
/** words shorter than this match literally only: a trigram needs three characters */
export const FUZZY_MIN_CHARS = 3;
/** the most words of a query that are matched (the rest are ignored) */
const MAX_WORDS = 6;

/** Escape `\`, `%` and `_` so user text is matched literally by LIKE / ILIKE. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
export const words = (q: string) => q.trim().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
const contains = (col: Parameters<typeof ilike>[0], w: string) => ilike(col, `%${escapeLike(w)}%`);
type Col = Parameters<typeof ilike>[0];
/** the word is in the column literally, or (3+ characters) close to a word in it; the `<%` operator reads pg_trgm.word_similarity_threshold */
export const near = (col: Col, w: string): SQL => (w.length >= FUZZY_MIN_CHARS ? or(contains(col, w), sql`${w} <% ${col}`)! : contains(col, w));
/** weighted similarity of one word over weighted columns, plus the literal bonus */
export function wordScore(w: string, cols: Array<[Col, number]>): SQL {
  const sims = cols.map(([c, weight]) => sql`word_similarity(${w}, ${c}) * ${weight}`);
  const literal = or(...cols.map(([c]) => contains(c, w)))!;
  return sql`(greatest(${sql.join(sims, sql`, `)}) + case when ${literal} then ${EXACT_BONUS} else 0 end)`;
}
export const sumScores = (parts: SQL[]): SQL => sql`(${sql.join(parts, sql` + `)})`;
/** Users page: every word must be in the name or email (literally, or close to a word in it); score weights the name 2 over the email 1. */
export const userMatch = (ws: string[]): SQL | undefined =>
  ws.length ? and(...ws.map((w) => or(near(schema.user.name, w), near(schema.user.email, w))!)) : undefined;
export const userScore = (ws: string[]): SQL | undefined =>
  ws.length
    ? sumScores(
        ws.map((w) =>
          wordScore(w, [
            [schema.user.name, 2],
            [schema.user.email, 1],
          ]),
        ),
      )
    : undefined;
/** `<%` compares against this setting; call first inside a transaction (local to it) */
export const setSearchThreshold = (tx: Pick<Db, "execute">) =>
  tx.execute(sql`select set_config('pg_trgm.word_similarity_threshold', ${String(SEARCH_SIM)}, true)`);

type ProjectRow = Pick<schema.Project, "id" | "title" | "status" | "durationSec" | "sourceUrl" | "updatedAt" | "sourceMeta">;
const PROJECT_COLUMNS = { id: true, title: true, status: true, durationSec: true, sourceMeta: true, sourceUrl: true, updatedAt: true } as const;

/** Clip counts per project for exactly these projects (one grouped query), as the palette shows them. */
async function clipFacts(db: Db, ids: string[]) {
  const facts = new Map<string, { clipCount: number; clipsDone: number; failedClipIds: string[] }>();
  if (!ids.length) return facts;
  const rows = await db
    .select({ projectId: schema.clips.projectId, id: schema.clips.id, status: schema.clips.status })
    .from(schema.clips)
    .where(and(inArray(schema.clips.projectId, ids), isNull(schema.clips.deletedAt)));
  for (const c of rows) {
    const f = facts.get(c.projectId) ?? { clipCount: 0, clipsDone: 0, failedClipIds: [] };
    f.clipCount++;
    if (c.status === "done") f.clipsDone++;
    if (c.status === "failed") f.failedClipIds.push(c.id);
    facts.set(c.projectId, f);
  }
  return facts;
}

async function projectRows(db: Db, rows: Array<ProjectRow & { score?: number }>) {
  const facts = await clipFacts(
    db,
    rows.map((p) => p.id),
  );
  return rows.map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    durationSec: p.durationSec,
    sourceUrl: p.sourceUrl,
    updatedAt: p.updatedAt.toISOString(),
    thumbnailUrl: (p.sourceMeta?.thumbnail as string | undefined) ?? null,
    /** relevance (higher is better); 0 where the list is not ranked by relevance */
    score: p.score ?? 0,
    ...(facts.get(p.id) ?? { clipCount: 0, clipsDone: 0, failedClipIds: [] as string[] }),
  }));
}
export type SearchProject = Awaited<ReturnType<typeof projectRows>>[number];

/** The user's most recently changed projects (the palette's list before anything is typed). */
export async function recentProjects(db: Db, userId: string, limit = 20) {
  const rows = await db.query.projects.findMany({
    where: and(eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt)),
    columns: PROJECT_COLUMNS,
    orderBy: desc(schema.projects.updatedAt),
    limit,
  });
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
  links?: string[] | undefined;
}

export async function searchLibrary(db: Db, userId: string, input: SearchInput) {
  const limit = input.limit ?? SEARCH_CLIPS;
  // deleted projects (and clips a re-analyze replaced) are not found until restored
  const mine = and(eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt));
  if (input.links?.length) {
    const rows = await db.query.projects.findMany({
      where: and(mine, or(...input.links.map((n) => contains(schema.projects.sourceUrl, n)))),
      columns: PROJECT_COLUMNS,
      orderBy: desc(schema.projects.updatedAt),
      limit: 50,
    });
    return { projects: await projectRows(db, rows), clips: [], truncated: false };
  }
  const ws = words(input.q);
  if (!ws.length) return { projects: await recentProjects(db, userId, SEARCH_PROJECTS), clips: [], truncated: false };

  const projScore = sumScores(ws.map((w) => wordScore(w, [[schema.projects.title, WEIGHT_PROJECT_TITLE]])));
  const clipScore = sumScores(
    ws.map((w) =>
      wordScore(w, [
        [schema.clips.title, WEIGHT_CLIP_TITLE],
        [schema.clips.hook, WEIGHT_CLIP_HOOK],
        [schema.clips.caption, WEIGHT_CLIP_CAPTION],
      ]),
    ),
  );
  const clipMatch: SQL[] = ws.map((w) => or(near(schema.clips.title, w), near(schema.clips.hook, w), near(schema.clips.caption, w))!);
  const { projectsFound, clipsFound } = await db.transaction(async (tx) => {
    await setSearchThreshold(tx);
    const projectsFound = await tx
      .select({
        id: schema.projects.id,
        title: schema.projects.title,
        status: schema.projects.status,
        durationSec: schema.projects.durationSec,
        sourceMeta: schema.projects.sourceMeta,
        sourceUrl: schema.projects.sourceUrl,
        updatedAt: schema.projects.updatedAt,
        score: sql<number>`${projScore}`.mapWith(Number),
      })
      .from(schema.projects)
      .where(and(mine, ...ws.map((w) => near(schema.projects.title, w))))
      .orderBy(desc(projScore), desc(schema.projects.updatedAt))
      .limit(SEARCH_PROJECTS + 1);
    const clipsFound = await tx
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
        score: sql<number>`${clipScore}`.mapWith(Number),
      })
      .from(schema.clips)
      .innerJoin(schema.projects, eq(schema.clips.projectId, schema.projects.id))
      .where(and(mine, isNull(schema.clips.deletedAt), ...clipMatch))
      .orderBy(desc(clipScore), desc(schema.projects.updatedAt), schema.clips.index)
      .limit(limit + 1);
    return { projectsFound, clipsFound };
  });
  const truncated = projectsFound.length > SEARCH_PROJECTS || clipsFound.length > limit;
  return {
    projects: await projectRows(db, projectsFound.slice(0, SEARCH_PROJECTS)),
    clips: clipsFound.slice(0, limit).map((c) => ({
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
      score: c.score,
      videoUrl: c.outputKey ? `/media/clips/${c.projectId}/${c.id}.mp4` : null,
      thumbnailUrl: c.thumbnailKey ? `/media/clips/${c.projectId}/${c.id}.jpg` : null,
    })),
    truncated,
  };
}

/** Failed work across the account, for the palette's "Retry all failed" commands (ids capped; the counts are exact). */
export async function failedCounts(db: Db, userId: string) {
  const failedClip = and(
    eq(schema.projects.userId, userId),
    eq(schema.clips.status, "failed"),
    isNull(schema.projects.deletedAt),
    isNull(schema.clips.deletedAt),
  );
  const [[clipTotals], clipIds, projectIds] = await Promise.all([
    db
      .select({ clips: count(), projects: sql<number>`count(distinct ${schema.clips.projectId})` })
      .from(schema.clips)
      .innerJoin(schema.projects, eq(schema.clips.projectId, schema.projects.id))
      .where(failedClip),
    db
      .select({ id: schema.clips.id })
      .from(schema.clips)
      .innerJoin(schema.projects, eq(schema.clips.projectId, schema.projects.id))
      .where(failedClip)
      .limit(500),
    db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(and(eq(schema.projects.userId, userId), eq(schema.projects.status, "failed"), isNull(schema.projects.deletedAt)))
      .limit(200),
  ]);
  return {
    failedClips: Number(clipTotals?.clips ?? 0),
    failedClipProjects: Number(clipTotals?.projects ?? 0),
    failedProjects: projectIds.length,
    failedClipIds: clipIds.map((c) => c.id),
    failedProjectIds: projectIds.map((p) => p.id),
  };
}
