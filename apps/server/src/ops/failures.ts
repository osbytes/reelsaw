/**
 * Admin view of failed work, from durable project/clip rows (not pg-boss, which ages out in 3 days).
 * Bulk retry is a thin wrapper over retryProject / requestRender / requestPrepare, one item per
 * transaction so fair enqueue and live-job caps still apply — one admin click cannot jump the queue.
 *
 * Each failure carries its cause (FailureCause in @reelsaw/shared: platform, input, quota), written with the
 * failed status by failedRow (pipeline/common.ts). Bulk retry by filter takes platform failures only unless a
 * cause is named, since a bad link or a plan refusal fails the same way again. Plan refusals are retried on their
 * own when the owner's plan or limits change (retryQuotaRefusals, run by the event handlers below). Dismiss clears
 * a failure from this list without touching the owner's project; a new failure shows again.
 */
import { FAILURE_CAUSES, type FailureCause } from "@reelsaw/shared";
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import type { EventHandler, ReadDb } from "../event-handlers.js";
import type { AccountEventType } from "../event-types.js";
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
export { FAILURE_CAUSES, type FailureCause };
/** How long after it was refused a project is still retried when its owner's plan or limits change. */
export const QUOTA_RETRY_DAYS = 30;

export interface FailureFilter {
  q?: string | undefined;
  stage?: FailureStage | undefined;
  cause?: FailureCause | undefined;
  /** true: only dismissed failures; otherwise only the ones not dismissed */
  dismissed?: boolean | undefined;
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
  /** why it failed; a row from before causes were kept reads as platform */
  cause: FailureCause;
  /** Retry can help as things stand: only a platform fault (input fails the same way; quota retries itself on upgrade) */
  retryable: boolean;
  error: string | null;
  snippet: string;
  failedAt: string;
  dismissedAt: string | null;
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
  cause: FailureCause | null;
  error: string | null;
  failedAt: Date;
  dismissedAt: Date | null;
};

function view(r: Raw): FailureItem {
  const stage = (r.kind === "clip" ? r.stage : r.stage || "ingest") as FailureStage | string;
  const cause = r.cause ?? "platform";
  return {
    kind: r.kind,
    id: r.id,
    projectId: r.projectId,
    clipId: r.clipId,
    title: r.title,
    projectTitle: r.projectTitle,
    ownerEmail: r.ownerEmail,
    stage,
    cause,
    retryable: cause === "platform",
    error: r.error,
    snippet: errorSnippet(r.error),
    failedAt: r.failedAt.toISOString(),
    dismissedAt: r.dismissedAt?.toISOString() ?? null,
  };
}

function sortKey(r: Raw): string {
  return `${r.failedAt.toISOString()}\t${r.kind}\t${r.id}`;
}

/** The cause and dismissed filters, on either table (a null cause is platform). */
function causeWhere(t: typeof schema.projects | typeof schema.clips, filter: FailureFilter): SQL | undefined {
  return and(
    filter.cause ? sql`coalesce(${t.failureCause}, 'platform') = ${filter.cause}` : undefined,
    filter.dismissed ? isNotNull(t.failureDismissedAt) : isNull(t.failureDismissedAt),
  );
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
    causeWhere(schema.projects, filter),
  );
  const clipWhere = and(
    eq(schema.clips.status, "failed"),
    isNull(schema.clips.deletedAt),
    isNull(schema.projects.deletedAt),
    // a failed project already covers its clips; retrying the project resumes them
    ne(schema.projects.status, "failed"),
    since ? gte(schema.clips.updatedAt, since) : undefined,
    qErr(schema.clips.error),
    causeWhere(schema.clips, filter),
  );

  const [projectRows, clipRows, projectCountRow] = await Promise.all([
    wantProjects
      ? db
          .select({
            id: schema.projects.id,
            title: schema.projects.title,
            stage: schema.projects.stage,
            cause: schema.projects.failureCause,
            error: schema.projects.error,
            failedAt: schema.projects.updatedAt,
            dismissedAt: schema.projects.failureDismissedAt,
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
            cause: schema.clips.failureCause,
            error: schema.clips.error,
            failedAt: schema.clips.updatedAt,
            dismissedAt: schema.clips.failureDismissedAt,
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
    ...projectRows.map((p) => ({ kind: "project" as const, projectId: p.id, clipId: null, projectTitle: p.title, ...p })),
    ...clips.map((c) => ({ kind: "clip" as const, clipId: c.id, ...c, stage: clipFailureStage(c) })),
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

/** One failed project or clip, same visibility as the list (a clip whose project also failed is not returned). Dismissed ones too. */
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

type Ids = Array<{ kind: FailureKind; id: string }>;

/** The items a bulk action works on: exactly `ids` (capped), or one page of the filter. */
async function pick(svc: Services, filter: FailureFilter, ids: Ids | undefined, limit: number) {
  if (ids?.length) return { items: await loadByIds(svc, ids.slice(0, limit)), nextCursor: ids.length > limit ? "ids" : null };
  const page = await listFailures(svc, { ...filter, limit });
  return { items: page.items, nextCursor: page.nextCursor };
}

/**
 * Retry matching failures. Each item is its own unit of work so enqueue goes through admission
 * (fair priority + per-user live-job caps) instead of one giant transaction that could starve the fleet.
 * By filter it takes platform failures unless `filter.cause` names another; `ids` retries exactly those, whatever
 * their cause.
 */
export async function retryFailures(
  svc: Services,
  filter: FailureFilter,
  actor: FailureActor | null,
  opts: { ids?: Ids | undefined; limit?: number | undefined } = {},
): Promise<RetryResult> {
  const limit = Math.min(FAILURE_PAGE, Math.max(1, opts.limit ?? FAILURE_PAGE));
  const { items, nextCursor } = await pick(svc, { ...filter, cause: filter.cause ?? "platform" }, opts.ids, limit);
  const projectIds = new Set(items.filter((i) => i.kind === "project").map((i) => i.projectId));
  const work = items.filter((i) => i.kind === "project" || !projectIds.has(i.projectId));
  let retried = 0;
  let skipped = items.length - work.length;
  const log = svc.log.child({ module: "ops" });
  for (const item of work) {
    try {
      const ok =
        item.kind === "project"
          ? await retryFailedProject(svc, item.projectId)
          : await svc.tx(async (u) => {
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
  await svc.tx((u) =>
    u.emit(
      "failures.retried",
      {
        userId: actor?.id ?? "operator",
        email: actor?.email ?? "operator",
        filter: { ...filterPayload(filter), ids: opts.ids ?? null },
        retried,
        skipped,
      },
      { actorId: actor?.id ?? null },
    ),
  );
  return { retried, skipped, nextCursor };
}

/** Resume one failed project, in its own transaction; false when it is no longer failed (retried meanwhile, deleted). */
async function retryFailedProject(svc: Services, projectId: string): Promise<boolean> {
  return svc.tx(async (u) => {
    const [p] = await u.db
      .select({ status: schema.projects.status })
      .from(schema.projects)
      .where(and(eq(schema.projects.id, projectId), eq(schema.projects.status, "failed"), isNull(schema.projects.deletedAt)));
    if (!p) return false;
    return !!(await retryProject(svc, u, projectId));
  });
}

function filterPayload(filter: FailureFilter) {
  return { q: filter.q ?? null, stage: filter.stage ?? null, since: filter.since ?? null, cause: filter.cause ?? null };
}

export interface DismissResult {
  /** how many changed (dismissed, or brought back with `restore`) */
  changed: number;
  skipped: number;
  nextCursor: string | null;
}

/**
 * Clear matching failures from Failed work (or, with `restore`, bring dismissed ones back). Only the admin list
 * changes: the owner's project, its error and its own Retry stay as they are, and failing again shows it again.
 * One page (50) per call, like retry; by filter, run again while `nextCursor` is set.
 */
export async function dismissFailures(
  svc: Services,
  filter: FailureFilter,
  actor: FailureActor | null,
  opts: { ids?: Ids | undefined; limit?: number | undefined; restore?: boolean | undefined } = {},
): Promise<DismissResult> {
  const limit = Math.min(FAILURE_PAGE, Math.max(1, opts.limit ?? FAILURE_PAGE));
  const restore = !!opts.restore;
  const { items, nextCursor } = await pick(svc, { ...filter, dismissed: restore }, opts.ids, limit);
  const at = restore ? null : new Date();
  const ids = (k: FailureKind) => items.filter((i) => i.kind === k).map((i) => i.id);
  const changed = await svc.tx(async (u) => {
    const mark = async (t: typeof schema.projects | typeof schema.clips, these: string[]) =>
      these.length
        ? (
            await u.db
              .update(t)
              .set({ failureDismissedAt: at })
              .where(and(inArray(t.id, these), eq(t.status, "failed"), restore ? isNotNull(t.failureDismissedAt) : isNull(t.failureDismissedAt)))
              .returning({ id: t.id })
          ).length
        : 0;
    const n = (await mark(schema.projects, ids("project"))) + (await mark(schema.clips, ids("clip")));
    await u.emit(
      "failures.dismissed",
      {
        userId: actor?.id ?? "operator",
        email: actor?.email ?? "operator",
        filter: { ...filterPayload(filter), ids: opts.ids ?? null },
        restore,
        changed: n,
      },
      { actorId: actor?.id ?? null },
    );
    return n;
  });
  return { changed, skipped: items.length - changed, nextCursor };
}

/** The owner's projects a plan or limits change may now let through: refused for quota in the last QUOTA_RETRY_DAYS. */
function quotaRefusedWhere(userId: string) {
  return and(
    eq(schema.projects.userId, userId),
    eq(schema.projects.status, "failed"),
    eq(schema.projects.failureCause, "quota"),
    isNull(schema.projects.deletedAt),
    gte(schema.projects.updatedAt, new Date(Date.now() - QUOTA_RETRY_DAYS * 86_400_000)),
  );
}

/**
 * Resume the owner's recent plan refusals after their plan or limits changed, newest first, up to a page. Ingest
 * checks the minutes again, so a change that still does not cover a video fails it the same way, once.
 */
export async function retryQuotaRefusals(svc: Services, userId: string): Promise<{ retried: number }> {
  const rows = await svc.database.db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(quotaRefusedWhere(userId))
    .orderBy(desc(schema.projects.updatedAt))
    .limit(FAILURE_PAGE);
  let retried = 0;
  for (const r of rows) if (await retryFailedProject(svc, r.id)) retried++;
  if (retried) svc.log.child({ module: "ops", userId }).info({ retried }, "retried plan refusals after a plan or limits change");
  return { retried };
}

type PlanChange = Extract<AccountEventType, "user.limits_changed" | "billing.subscribed" | "billing.changed" | "billing.complimentary">;

/**
 * The handler that follows a plan or limits change: resumes the account's plan refusals (retryQuotaRefusals).
 * Skipped at emit when there are none, one job per account at a time.
 */
export function retryRefusedWork<T extends PlanChange>(): EventHandler<T> {
  const userOf = (payload: unknown) => (payload as { userId: string }).userId;
  return {
    key: async ({ event, db }: { event: { payload: unknown }; db: ReadDb }) => {
      const userId = userOf(event.payload);
      const [hit] = await db.select({ id: schema.projects.id }).from(schema.projects).where(quotaRefusedWhere(userId)).limit(1);
      return hit ? `quota-retry:${userId}` : null;
    },
    coalesce: true,
    oneAtATime: true,
    handle: async ({ event, svc }) => void (await retryQuotaRefusals(svc, userOf(event.payload))),
  };
}

async function loadByIds(svc: Services, ids: Ids): Promise<FailureItem[]> {
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
            cause: schema.projects.failureCause,
            error: schema.projects.error,
            failedAt: schema.projects.updatedAt,
            dismissedAt: schema.projects.failureDismissedAt,
            ownerEmail: schema.user.email,
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
            cause: schema.clips.failureCause,
            error: schema.clips.error,
            failedAt: schema.clips.updatedAt,
            dismissedAt: schema.clips.failureDismissedAt,
            ownerEmail: schema.user.email,
            origin: schema.clips.origin,
            reasoning: schema.clips.reasoning,
            scores: schema.clips.scores,
          })
          .from(schema.clips)
          .innerJoin(schema.projects, eq(schema.projects.id, schema.clips.projectId))
          .innerJoin(schema.user, eq(schema.user.id, schema.projects.userId))
          .where(and(inArray(schema.clips.id, clipIds), eq(schema.clips.status, "failed"), isNull(schema.clips.deletedAt), isNull(schema.projects.deletedAt)))
      : Promise.resolve([]),
  ]);
  const order = new Map(ids.map((i, n) => [`${i.kind}:${i.id}`, n]));
  const items: FailureItem[] = [
    ...projects.map((p) => view({ kind: "project", projectId: p.id, clipId: null, projectTitle: p.title, ...p })),
    ...clips.map((c) => view({ kind: "clip", clipId: c.id, ...c, stage: clipFailureStage(c) })),
  ];
  items.sort((a, b) => (order.get(`${a.kind}:${a.id}`) ?? 0) - (order.get(`${b.kind}:${b.id}`) ?? 0));
  return items;
}
