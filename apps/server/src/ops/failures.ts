/**
 * Admin view of failed work, from durable project/clip rows (not pg-boss, which ages out in 3 days).
 * Bulk retry is a thin wrapper over retryProject / requestRender / requestPrepare, one item per
 * transaction so fair enqueue and live-job caps still apply — one admin click cannot jump the queue.
 */
import { and, desc, eq, gte, ilike, inArray, isNull, ne, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import { decodeCursor, escapeLike, pageOf } from "../pagination.js";
import { retryProject } from "../projects/service.js";
import { needsPrepare } from "../pipeline/manual.js";
import { requestPrepare, requestRender } from "../pipeline/lifecycle.js";

export const FAILURE_PAGE = 50;
/** Widen the fetch a little so a keyset page can merge projects + clips without going silent. */
const FETCH = 200;
export const FAILURE_STAGES = ["ingest", "transcribe", "refine", "analyze", "render", "prepare"] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];
export type FailureKind = "project" | "clip";

export interface FailureFilter {
  q?: string | undefined;
  stage?: FailureStage | undefined;
  since?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface FailureItem {
  kind: FailureKind;
  id: string;
  projectId: string;
  clipId: string | null;
  /** Clip title when kind is clip, otherwise the project title. */
  title: string;
  projectTitle: string;
  ownerEmail: string;
  stage: FailureStage | string;
  error: string | null;
  snippet: string;
  failedAt: string;
}

export interface FailurePage {
  items: FailureItem[];
  nextCursor: string | null;
  total: number;
  limit: number;
  truncated: boolean;
}

export interface FailureActor {
  id: string;
  email: string;
}

export function errorSnippet(error: string | null | undefined, n = 120): string {
  if (!error?.trim()) return "Failed with no reason recorded";
  const one = error.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

export function clipFailureStage(c: { origin: string; reasoning: string; scores: unknown }): "prepare" | "render" {
  return c.origin !== "ai" && !c.reasoning && !c.scores ? "prepare" : "render";
}

function parseSince(s?: string): Date | undefined {
  if (!s?.trim()) return undefined;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : undefined;
}

function likePat(q?: string): string | undefined {
  const t = q?.trim().toLowerCase();
  return t ? `%${escapeLike(t)}%` : undefined;
}

type Raw = {
  kind: FailureKind;
  id: string;
  projectId: string;
  clipId: string | null;
  title: string;
  projectTitle: string;
  ownerEmail: string;
  stage: string | null;
  error: string | null;
  failedAt: Date;
};

function view(r: Raw): FailureItem {
  const stage = (r.kind === "clip" ? r.stage : r.stage || "ingest") as FailureStage | string;
  return {
    kind: r.kind,
    id: r.id,
    projectId: r.projectId,
    clipId: r.clipId,
    title: r.title,
    projectTitle: r.projectTitle,
    ownerEmail: r.ownerEmail,
    stage,
    error: r.error,
    snippet: errorSnippet(r.error),
    failedAt: r.failedAt.toISOString(),
  };
}

function sortKey(r: Raw): string {
  return `${r.failedAt.toISOString()}\t${r.kind}\t${r.id}`;
}

export async function listFailures(svc: Services, filter: FailureFilter = {}): Promise<FailurePage> {
  const db = svc.database.db;
  const limit = Math.min(FAILURE_PAGE, Math.max(1, filter.limit ?? FAILURE_PAGE));
  const since = parseSince(filter.since);
  const pat = likePat(filter.q);
  const stage = filter.stage;
  const wantProjects = !stage || stage !== "prepare";
  const wantClips = !stage || stage === "render" || stage === "prepare";

  const qErr = (col: typeof schema.projects.error | typeof schema.clips.error) => (pat ? ilike(col, pat) : undefined);

  const projectWhere = and(
    eq(schema.projects.status, "failed"),
    isNull(schema.projects.deletedAt),
    stage && stage !== "render" ? eq(schema.projects.stage, stage) : stage === "render" ? eq(schema.projects.stage, "render") : undefined,
    since ? gte(schema.projects.updatedAt, since) : undefined,
    qErr(schema.projects.error),
  );
  const clipWhere = and(
    eq(schema.clips.status, "failed"),
    isNull(schema.clips.deletedAt),
    isNull(schema.projects.deletedAt),
    // a failed project already covers its clips; retrying the project resumes them
    ne(schema.projects.status, "failed"),
    since ? gte(schema.clips.updatedAt, since) : undefined,
    qErr(schema.clips.error),
  );

  const [projectRows, clipRows, projectCountRow] = await Promise.all([
    wantProjects
      ? db
          .select({
            id: schema.projects.id,
            title: schema.projects.title,
            stage: schema.projects.stage,
            error: schema.projects.error,
            failedAt: schema.projects.updatedAt,
            ownerEmail: schema.user.email,
          })
          .from(schema.projects)
          .innerJoin(schema.user, eq(schema.user.id, schema.projects.userId))
          .where(projectWhere)
          .orderBy(desc(schema.projects.updatedAt), desc(schema.projects.id))
          .limit(FETCH)
      : Promise.resolve([]),
    wantClips
      ? db
          .select({
            id: schema.clips.id,
            projectId: schema.clips.projectId,
            title: schema.clips.title,
            projectTitle: schema.projects.title,
            error: schema.clips.error,
            failedAt: schema.clips.updatedAt,
            ownerEmail: schema.user.email,
            origin: schema.clips.origin,
            reasoning: schema.clips.reasoning,
            scores: schema.clips.scores,
          })
          .from(schema.clips)
          .innerJoin(schema.projects, eq(schema.projects.id, schema.clips.projectId))
          .innerJoin(schema.user, eq(schema.user.id, schema.projects.userId))
          .where(clipWhere)
          .orderBy(desc(schema.clips.updatedAt), desc(schema.clips.id))
          .limit(FETCH)
      : Promise.resolve([]),
    wantProjects ? db.select({ n: sql<number>`count(*)::int` }).from(schema.projects).where(projectWhere) : Promise.resolve([{ n: 0 }]),
  ]);

  const clips = clipRows.filter((c) => !stage || clipFailureStage(c) === stage);
  let merged: Raw[] = [
    ...projectRows.map((p) => ({
      kind: "project" as const,
      id: p.id,
      projectId: p.id,
      clipId: null,
      title: p.title,
      projectTitle: p.title,
      ownerEmail: p.ownerEmail,
      stage: p.stage,
      error: p.error,
      failedAt: p.failedAt,
    })),
    ...clips.map((c) => ({
      kind: "clip" as const,
      id: c.id,
      projectId: c.projectId,
      clipId: c.id,
      title: c.title,
      projectTitle: c.projectTitle,
      ownerEmail: c.ownerEmail,
      stage: clipFailureStage(c),
      error: c.error,
      failedAt: c.failedAt,
    })),
  ];
  merged.sort((a, b) => b.failedAt.getTime() - a.failedAt.getTime() || b.kind.localeCompare(a.kind) || b.id.localeCompare(a.id));

  const cur = filter.cursor ? decodeCursor(filter.cursor, 3) : null;
  if (cur) {
    const mark = `${cur[0]}\t${cur[1]}\t${cur[2]}`;
    const i = merged.findIndex((r) => sortKey(r) === mark);
    merged = i >= 0 ? merged.slice(i + 1) : merged.filter((r) => sortKey(r) < mark);
  }

  const page = pageOf(merged, limit, (last) => [last.failedAt.toISOString(), last.kind, last.id]);
  const truncated = projectRows.length === FETCH || clipRows.length === FETCH;
  const total = (projectCountRow[0]?.n ?? 0) + clips.length;
  return {
    items: page.items.map(view),
    nextCursor: page.nextCursor,
    total,
    limit,
    truncated,
  };
}

/** One failed project or clip, same visibility as the list (a clip whose project also failed is not returned). */
export async function getFailure(svc: Services, kind: FailureKind, id: string): Promise<FailureItem | null> {
  const [item] = await loadByIds(svc, [{ kind, id }]);
  if (!item) return null;
  if (kind === "clip") {
    const [p] = await svc.database.db.select({ status: schema.projects.status }).from(schema.projects).where(eq(schema.projects.id, item.projectId));
    if (p?.status === "failed") return null;
  }
  return item;
}

export interface RetryResult {
  retried: number;
  skipped: number;
  nextCursor: string | null;
}

/**
 * Retry matching failures. Each item is its own unit of work so enqueue goes through admission
 * (fair priority + per-user live-job caps) instead of one giant transaction that could starve the fleet.
 */
export async function retryFailures(
  svc: Services,
  filter: FailureFilter,
  actor: FailureActor | null,
  opts: { ids?: Array<{ kind: FailureKind; id: string }> | undefined; limit?: number | undefined } = {},
): Promise<RetryResult> {
  const limit = Math.min(FAILURE_PAGE, Math.max(1, opts.limit ?? FAILURE_PAGE));
  let items: FailureItem[];
  let nextCursor: string | null;
  if (opts.ids?.length) {
    items = await loadByIds(svc, opts.ids.slice(0, limit));
    nextCursor = opts.ids.length > limit ? "ids" : null;
  } else {
    const page = await listFailures(svc, { ...filter, limit });
    items = page.items;
    nextCursor = page.nextCursor;
  }
  const projectIds = new Set(items.filter((i) => i.kind === "project").map((i) => i.projectId));
  const work = items.filter((i) => i.kind === "project" || !projectIds.has(i.projectId));
  let retried = 0;
  let skipped = items.length - work.length;
  const log = svc.log.child({ module: "ops" });
  for (const item of work) {
    try {
      const ok = await svc.tx(async (u) => {
        if (item.kind === "project") {
          const [p] = await u.db
            .select({ status: schema.projects.status })
            .from(schema.projects)
            .where(and(eq(schema.projects.id, item.projectId), eq(schema.projects.status, "failed"), isNull(schema.projects.deletedAt)));
          if (!p) return false;
          return !!(await retryProject(svc, u, item.projectId));
        }
        const [c] = await u.db
          .select({
            id: schema.clips.id,
            projectId: schema.clips.projectId,
            status: schema.clips.status,
            origin: schema.clips.origin,
            reasoning: schema.clips.reasoning,
            scores: schema.clips.scores,
          })
          .from(schema.clips)
          .where(and(eq(schema.clips.id, item.id), eq(schema.clips.status, "failed"), isNull(schema.clips.deletedAt)));
        if (!c) return false;
        if (needsPrepare(c)) return requestPrepare(svc, u, c.projectId, c.id, { reason: "retry" });
        return (await requestRender(svc, u, c.projectId, c.id, {}, "retry")) !== null;
      });
      if (ok) retried++;
      else skipped++;
    } catch (err) {
      skipped++;
      log.warn({ err, kind: item.kind, id: item.id }, "retry failure skipped");
    }
  }
  await svc.database.db.insert(schema.adminEvents).values({
    type: "failures.retried",
    actorId: actor?.id ?? null,
    userId: actor?.id ?? "operator",
    email: actor?.email ?? "operator",
    payload: {
      filter: { q: filter.q ?? null, stage: filter.stage ?? null, since: filter.since ?? null, ids: opts.ids ?? null },
      retried,
      skipped,
    },
  });
  return { retried, skipped, nextCursor };
}

async function loadByIds(svc: Services, ids: Array<{ kind: FailureKind; id: string }>): Promise<FailureItem[]> {
  const db = svc.database.db;
  const projectIds = ids.filter((i) => i.kind === "project").map((i) => i.id);
  const clipIds = ids.filter((i) => i.kind === "clip").map((i) => i.id);
  const [projects, clips] = await Promise.all([
    projectIds.length
      ? db
          .select({
            id: schema.projects.id,
            title: schema.projects.title,
            stage: schema.projects.stage,
            error: schema.projects.error,
            failedAt: schema.projects.updatedAt,
            ownerEmail: schema.user.email,
            status: schema.projects.status,
          })
          .from(schema.projects)
          .innerJoin(schema.user, eq(schema.user.id, schema.projects.userId))
          .where(and(inArray(schema.projects.id, projectIds), eq(schema.projects.status, "failed"), isNull(schema.projects.deletedAt)))
      : Promise.resolve([]),
    clipIds.length
      ? db
          .select({
            id: schema.clips.id,
            projectId: schema.clips.projectId,
            title: schema.clips.title,
            projectTitle: schema.projects.title,
            error: schema.clips.error,
            failedAt: schema.clips.updatedAt,
            ownerEmail: schema.user.email,
            origin: schema.clips.origin,
            reasoning: schema.clips.reasoning,
            scores: schema.clips.scores,
            status: schema.clips.status,
            projectStatus: schema.projects.status,
          })
          .from(schema.clips)
          .innerJoin(schema.projects, eq(schema.projects.id, schema.clips.projectId))
          .innerJoin(schema.user, eq(schema.user.id, schema.projects.userId))
          .where(and(inArray(schema.clips.id, clipIds), eq(schema.clips.status, "failed"), isNull(schema.clips.deletedAt), isNull(schema.projects.deletedAt)))
      : Promise.resolve([]),
  ]);
  const order = new Map(ids.map((i, n) => [`${i.kind}:${i.id}`, n]));
  const items: FailureItem[] = [
    ...projects.map((p) =>
      view({
        kind: "project",
        id: p.id,
        projectId: p.id,
        clipId: null,
        title: p.title,
        projectTitle: p.title,
        ownerEmail: p.ownerEmail,
        stage: p.stage,
        error: p.error,
        failedAt: p.failedAt,
      }),
    ),
    ...clips.map((c) =>
      view({
        kind: "clip",
        id: c.id,
        projectId: c.projectId,
        clipId: c.id,
        title: c.title,
        projectTitle: c.projectTitle,
        ownerEmail: c.ownerEmail,
        stage: clipFailureStage(c),
        error: c.error,
        failedAt: c.failedAt,
      }),
    ),
  ];
  items.sort((a, b) => (order.get(`${a.kind}:${a.id}`) ?? 0) - (order.get(`${b.kind}:${b.id}`) ?? 0));
  return items;
}
