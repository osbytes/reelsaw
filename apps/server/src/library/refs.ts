/**
 * `asset_refs`: which library assets each project and clip point at, kept in the same transaction that writes the
 * pointer (docs/specs/library.md, decision 4). "Used by N", `asset_usage` and the purge's "still referenced" test
 * read this table instead of scanning jsonb on every clip.
 *
 * Rows: a clip's own `bumpers.intro` / `bumpers.outro` strings (role intro / outro; "inherit" and "none" are not
 * assets), every asset and audio layer of the clip (role layer, via `clipLayers`, so legacy overlays + audio rows
 * count), and the project's `introAssetId` / `outroAssetId` settings (clip_id null). A clip that inherits has no
 * row of its own for that slot: the project row stands for it.
 *
 * Soft-deleted clips (replaced by a re-analyze, restorable) keep their rows so their assets are not purged out
 * from under them; `bumpers.usage` and the counts skip them (they render nowhere).
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { clipLayers } from "@reelsaw/shared";
import { schema, type Db } from "../db/index.js";
import type { Services } from "../services.js";
import { deadlineIn, keysetLoop } from "../lib/batch.js";
import { getState, setState } from "../lib/state.js";

export interface AssetRefRow {
  assetId: string;
  projectId: string;
  clipId: string | null;
  role: "intro" | "outro" | "layer";
}

type ClipIn = { id: string; bumpers?: { intro?: string | null; outro?: string | null } | null; layers?: unknown; overlays?: unknown; audio?: unknown };
type ProjectIn = { id: string; settings?: { introAssetId?: string | null; outroAssetId?: string | null } | null };

/** Pure: the rows one clip should have. The same asset twice in a role collapses to one row. */
export function refsForClip(projectId: string, clip: ClipIn): AssetRefRow[] {
  const out = new Map<string, AssetRefRow>();
  const add = (assetId: string | null | undefined, role: AssetRefRow["role"]) => {
    // "inherit", "default" and "none" are choices, not asset ids
    if (!assetId || assetId === "inherit" || assetId === "default" || assetId === "none") return;
    out.set(`${role}:${assetId}`, { assetId, projectId, clipId: clip.id, role });
  };
  add(clip.bumpers?.intro, "intro");
  add(clip.bumpers?.outro, "outro");
  for (const l of clipLayers(clip)) if (l.kind === "asset" || l.kind === "audio") add(l.assetId, "layer");
  return [...out.values()];
}

/** Pure: the rows a project's own settings should have (clip_id null). */
export function refsForProject(project: ProjectIn): AssetRefRow[] {
  const s = project.settings ?? {};
  const out: AssetRefRow[] = [];
  if (s.introAssetId) out.push({ assetId: s.introAssetId, projectId: project.id, clipId: null, role: "intro" });
  if (s.outroAssetId) out.push({ assetId: s.outroAssetId, projectId: project.id, clipId: null, role: "outro" });
  return out;
}

/** Replace a clip's rows with the current ones. Call in the transaction that wrote the clip. */
export async function syncClipRefs(db: Db, projectId: string, clip: ClipIn): Promise<void> {
  await syncClipsRefs(db, projectId, [clip]);
}

/** Replace the rows of several clips of one project (one delete, one insert). */
export async function syncClipsRefs(db: Db, projectId: string, clips: ClipIn[]): Promise<void> {
  if (!clips.length) return;
  await db.delete(schema.assetRefs).where(sql`${schema.assetRefs.clipId} in (${sql.join(clips.map((c) => sql`${c.id}`), sql`, `)})`);
  const rows = clips.flatMap((c) => refsForClip(projectId, c));
  if (rows.length) await db.insert(schema.assetRefs).values(rows);
}

/** Replace the rows the project's own settings account for. Call in the transaction that wrote the settings. */
export async function syncProjectRefs(db: Db, project: ProjectIn): Promise<void> {
  await db.delete(schema.assetRefs).where(and(eq(schema.assetRefs.projectId, project.id), isNull(schema.assetRefs.clipId)));
  const rows = refsForProject(project);
  if (rows.length) await db.insert(schema.assetRefs).values(rows);
}

/** Re-read one project and its clips (locked) and rewrite every row. Used by the backfill and `library reindex`. */
export async function reindexProject(db: Db, projectId: string): Promise<{ clips: number; refs: number }> {
  const [p] = await db.select({ id: schema.projects.id, settings: schema.projects.settings }).from(schema.projects).where(eq(schema.projects.id, projectId));
  if (!p) return { clips: 0, refs: 0 };
  const clips = await db
    .select({ id: schema.clips.id, bumpers: schema.clips.bumpers, layers: schema.clips.layers, overlays: schema.clips.overlays, audio: schema.clips.audio })
    .from(schema.clips)
    .where(eq(schema.clips.projectId, projectId))
    .for("update");
  await db.delete(schema.assetRefs).where(eq(schema.assetRefs.projectId, projectId));
  const rows = [...refsForProject(p), ...clips.flatMap((c) => refsForClip(projectId, c))];
  if (rows.length) await db.insert(schema.assetRefs).values(rows);
  return { clips: clips.length, refs: rows.length };
}

// ── backfill ─────────────────────────────────────────────────────────────────

const BACKFILL_KEY = "asset_refs.backfill";
const BACKFILL_BATCH = 200;
const BACKFILL_BUDGET_MS = 20_000;

/** True once the backfill has covered every project (reads of "is it referenced" can be trusted). */
export async function assetRefsReady(db: Db): Promise<boolean> {
  return !!(await getState<{ done: boolean }>(db, BACKFILL_KEY)).done;
}

/**
 * Fill `asset_refs` for projects written before the table existed. Walks projects by id (keyset, 200 per batch),
 * one transaction per project (it locks that project's clips), resumable from the cursor kept in instance state, and
 * idempotent (every project's rows are rewritten from its current data). A tick stops after BACKFILL_BUDGET_MS;
 * `all: true` (reelsaw library reindex) runs to the end and restarts from the beginning. Once finished the flag is
 * set and ticks return at once: new writes keep the table current from then on.
 */
export async function backfillAssetRefs(svc: Services, opts: { all?: boolean; budgetMs?: number } = {}): Promise<{ done: boolean; projects: number; clips: number; refs: number }> {
  const db = svc.database.db;
  const state = opts.all ? {} : await getState<{ done: boolean; cursor: string }>(db, BACKFILL_KEY);
  if (state.done) return { done: true, projects: 0, clips: 0, refs: 0 };
  const totals = { projects: 0, clips: 0, refs: 0 };
  const r = await keysetLoop<{ id: string }, string>({
    size: BACKFILL_BATCH,
    deadline: opts.all ? Infinity : deadlineIn(opts.budgetMs ?? BACKFILL_BUDGET_MS),
    start: state.cursor ?? null,
    fetch: async (cursor, size) => db.select({ id: schema.projects.id }).from(schema.projects).where(cursor ? gt(schema.projects.id, cursor) : undefined).orderBy(schema.projects.id).limit(size),
    cursorOf: (row) => row.id,
    handle: async (rows) => {
      for (const { id } of rows) {
        const n = await svc.tx((u) => reindexProject(u.db, id));
        totals.projects++;
        totals.clips += n.clips;
        totals.refs += n.refs;
      }
    },
  });
  await setState(db, BACKFILL_KEY, r.complete ? { done: true, finishedAt: new Date().toISOString() } : { cursor: r.cursor });
  if (totals.projects || r.complete) svc.log.child({ module: "refs" }).info({ ...totals, complete: r.complete }, "asset refs backfill");
  return { done: r.complete, ...totals };
}
