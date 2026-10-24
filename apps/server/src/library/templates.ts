/**
 * Layer templates (docs/specs/layer-templates.md): a named set of layers placed by timing modes (head / tail / fill /
 * relative) instead of absolute seconds, so one template fits a clip of any length. Applying one *materialises*
 * ordinary `clips.layers`: the render path, the editor and `asset_refs` never learn about templates. The tRPC
 * `layerTemplates.*` procedures, the `*_layer_template` MCP tools, `reelsaw templates` and the pipeline (new clips of
 * a project whose settings name a template) all call these functions.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { MAX_CLIP_LAYERS, clipLayers, layerTemplateLayersSchema, layerTemplateNameSchema, resolveTemplateLayers, templateFromLayers, type ClipLayer, type TemplateLayer } from "@reelsaw/shared";
import { schema, type Db } from "../db/index.js";
import type { Services } from "../services.js";
import type { Logger } from "../log.js";
import { requestRender } from "../pipeline/lifecycle.js";
import { assetVisibleTo } from "./visible.js";
import { syncClipsRefs } from "./refs.js";
import { cleanLayers } from "./layers.js";

const RESTORE_DAYS = 30;

export const templateIdSchema = z.string().min(1).max(100).describe("Layer template id (list_layer_templates)");
export const applyModeSchema = z.enum(["replace", "add"]).describe('"replace" (default) = the template becomes the clip\'s layers; "add" = its layers join the ones the clip already has');

/** The MCP / CLI shape of an apply call; the tRPC procedure takes the same fields. */
export const applyLayerTemplateInput = {
  templateId: templateIdSchema,
  projectId: z.string().describe("Project the clips belong to (list_projects)"),
  clipIds: z.array(z.string()).min(1).max(200).optional().describe("Clip ids of that project (get_project), 1-200; omitted = every clip of the project"),
  mode: applyModeSchema.default("replace"),
  rerender: z.boolean().default(false).describe("true = re-render the affected finished clips now; false = the layers show on their next render"),
};
export const saveLayerTemplateInput = {
  name: layerTemplateNameSchema,
  clipId: z.string().optional().describe("Build the template from this clip's layers (get_project or search_clips). Pass clipId or layers, not both"),
  layers: layerTemplateLayersSchema.optional().describe("Or the layers themselves, each with a timing: { kind: asset|text|audio, id, timing: { mode: head|tail|fill|relative, start, end, minSec, maxSec }, ...the layer's own fields (assetId, x, y, w / text, size, color / volume, duck, fade, loop) }"),
};

export type PublicLayerTemplate = ReturnType<typeof publicTemplate>;
export function publicTemplate(t: schema.LayerTemplate) {
  return {
    id: t.id,
    name: t.name,
    layers: t.layers,
    layerCount: t.layers.length,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    deletedAt: t.deletedAt?.toISOString() ?? null,
  };
}

const notFound = () => new TRPCError({ code: "NOT_FOUND", message: `No such layer template. A removed template can be restored for ${RESTORE_DAYS} days (restore_layer_template).` });

/** The account's templates, newest change first, and the ones removed in the last 30 days (restorable). */
export async function listLayerTemplates(db: Db, userId: string) {
  const rows = await db.select().from(schema.layerTemplates).where(eq(schema.layerTemplates.userId, userId)).orderBy(desc(schema.layerTemplates.updatedAt), desc(schema.layerTemplates.id));
  const cutoff = Date.now() - RESTORE_DAYS * 86_400_000;
  return {
    templates: rows.filter((r) => !r.deletedAt).map(publicTemplate),
    deleted: rows.filter((r) => r.deletedAt && r.deletedAt.getTime() > cutoff).map(publicTemplate),
  };
}

/** One live template of the account (`deleted: true` also finds a removed one, for restore). NOT_FOUND otherwise. */
export async function getLayerTemplate(db: Db, userId: string, id: string, opts: { deleted?: boolean; lock?: boolean } = {}): Promise<schema.LayerTemplate> {
  const q = db
    .select()
    .from(schema.layerTemplates)
    .where(and(eq(schema.layerTemplates.id, id), eq(schema.layerTemplates.userId, userId), opts.deleted ? undefined : isNull(schema.layerTemplates.deletedAt)));
  const [row] = opts.lock ? await q.for("update") : await q;
  if (!row) throw notFound();
  return row;
}

/** Every asset a template names is one the account may use (own upload or instance-shared) and still in the library. */
async function assertTemplateAssets(db: Db, userId: string, layers: TemplateLayer[]) {
  const want = [...new Set(layers.flatMap((l) => (l.kind === "text" ? [] : [l.assetId])))];
  if (!want.length) return;
  const rows = await db.select({ id: schema.assets.id, kind: schema.assets.kind }).from(schema.assets).where(and(inArray(schema.assets.id, want), assetVisibleTo(userId), isNull(schema.assets.deletedAt)));
  const kinds = new Map(rows.map((r) => [r.id, r.kind]));
  for (const l of layers) {
    if (l.kind === "text") continue;
    const kind = kinds.get(l.assetId);
    if (!kind) throw new TRPCError({ code: "NOT_FOUND", message: `Layer “${l.id}”: that library item is not in your library` });
    if (l.kind === "audio" && kind !== "audio") throw new TRPCError({ code: "BAD_REQUEST", message: `Layer “${l.id}”: a sound layer needs an audio file, not a ${kind}` });
    if (l.kind === "asset" && kind === "audio") throw new TRPCError({ code: "BAD_REQUEST", message: `Layer “${l.id}”: that library item is a sound; use an audio layer` });
  }
}

/** Ids unique; nothing else to normalise here (windows are resolved per clip and cleaned there). */
function checkTemplateLayers(layers: TemplateLayer[]) {
  const seen = new Set<string>();
  for (const l of layers) {
    if (seen.has(l.id)) throw new TRPCError({ code: "BAD_REQUEST", message: `Layer id “${l.id}” is used twice` });
    seen.add(l.id);
  }
}

export async function createLayerTemplate(svc: Services, userId: string, input: { name: string; layers: TemplateLayer[] }) {
  checkTemplateLayers(input.layers);
  return svc.tx(async (u) => {
    await assertTemplateAssets(u.db, userId, input.layers);
    const [row] = await u.db.insert(schema.layerTemplates).values({ id: randomUUID(), userId, name: input.name.trim(), layers: input.layers }).returning();
    svc.log.child({ module: "templates", userId }).info({ templateId: row!.id, layers: input.layers.length }, "layer template created");
    return publicTemplate(row!);
  });
}

export async function updateLayerTemplate(svc: Services, userId: string, id: string, patch: { name?: string; layers?: TemplateLayer[] }) {
  if (patch.layers) checkTemplateLayers(patch.layers);
  return svc.tx(async (u) => {
    await getLayerTemplate(u.db, userId, id, { lock: true });
    if (patch.layers) await assertTemplateAssets(u.db, userId, patch.layers);
    const [row] = await u.db
      .update(schema.layerTemplates)
      .set({ ...(patch.name !== undefined ? { name: patch.name.trim() } : {}), ...(patch.layers !== undefined ? { layers: patch.layers } : {}), updatedAt: new Date() })
      .where(eq(schema.layerTemplates.id, id))
      .returning();
    return publicTemplate(row!);
  });
}

/**
 * Soft delete: hidden from the list and the pickers, cleared from the user's project defaults. Projects that name it
 * keep the id; their new clips simply get no template until it is restored or they pick another. Clips that already
 * got its layers are untouched (the layers are theirs).
 */
export async function removeLayerTemplate(svc: Services, userId: string, id: string) {
  return svc.tx(async (u) => {
    const gone = await u.db
      .update(schema.layerTemplates)
      .set({ deletedAt: new Date() })
      .where(and(eq(schema.layerTemplates.id, id), eq(schema.layerTemplates.userId, userId), isNull(schema.layerTemplates.deletedAt)))
      .returning({ id: schema.layerTemplates.id });
    if (!gone.length) throw notFound();
    const cleared = await u.db.execute(sql`update user_settings set project_defaults = project_defaults - 'layerTemplateId', updated_at = now() where user_id = ${userId} and project_defaults ->> 'layerTemplateId' = ${id}`);
    return { ok: true as const, clearedDefault: (cleared.rowCount ?? 0) > 0 };
  });
}

export async function restoreLayerTemplate(svc: Services, userId: string, id: string) {
  return svc.tx(async (u) => {
    const r = await u.db
      .update(schema.layerTemplates)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(and(eq(schema.layerTemplates.id, id), eq(schema.layerTemplates.userId, userId), gt(schema.layerTemplates.deletedAt, new Date(Date.now() - RESTORE_DAYS * 86_400_000))))
      .returning();
    if (!r.length) throw notFound();
    return publicTemplate(r[0]!);
  });
}

/** A template from one clip's current layers (templateFromLayers decides each layer's timing). */
export async function layerTemplateFromClip(svc: Services, userId: string, input: { clipId: string; name: string }) {
  const [clip] = await svc.database.db
    .select({ id: schema.clips.id, startSec: schema.clips.startSec, endSec: schema.clips.endSec, layers: schema.clips.layers, overlays: schema.clips.overlays, audio: schema.clips.audio })
    .from(schema.clips)
    .where(and(eq(schema.clips.id, input.clipId), isNull(schema.clips.deletedAt), sql`exists (select 1 from ${schema.projects} where ${schema.projects.id} = ${schema.clips.projectId} and ${schema.projects.userId} = ${userId} and ${schema.projects.deletedAt} is null)`));
  if (!clip) throw new TRPCError({ code: "NOT_FOUND", message: "No such clip" });
  const layers = templateFromLayers(clipLayers(clip), clip);
  if (!layers.length) throw new TRPCError({ code: "BAD_REQUEST", message: "This clip has no layers to save as a template" });
  return createLayerTemplate(svc, userId, { name: input.name, layers });
}

export interface ApplyResult {
  updated: number;
  rerendered: number;
  /** clips left alone, with why (still being prepared) */
  skipped: Array<{ clipId: string; reason: string }>;
  /** template layers that had no room on some clip (a tail longer than the clip, a relative window under its minimum) */
  layersSkipped: number;
}

/**
 * Materialise a template on clips of one project: each clip gets the template's layers resolved against its own
 * length (replacing its layers, or added to them), is marked edited (so a re-analyze keeps it) and, with `rerender`,
 * re-rendered when finished. One transaction: clips locked in id order (like lockProjectClips), asset refs rewritten
 * with the layers. A clip still being prepared has no final bounds and is skipped with a reason.
 */
export async function applyLayerTemplate(svc: Services, userId: string, input: { templateId: string; projectId: string; clipIds?: string[]; mode: "replace" | "add"; rerender: boolean }): Promise<ApplyResult> {
  const log = svc.log.child({ module: "templates", userId, projectId: input.projectId, templateId: input.templateId });
  return svc.tx(async (u) => {
    const [p] = await u.db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.id, input.projectId), eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt)));
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "No such project" });
    const t = await getLayerTemplate(u.db, userId, input.templateId);
    await assertTemplateAssets(u.db, userId, t.layers);
    const ids = input.clipIds ? [...new Set(input.clipIds)] : undefined;
    const clips = await u.db
      .select({ id: schema.clips.id, status: schema.clips.status, startSec: schema.clips.startSec, endSec: schema.clips.endSec, layers: schema.clips.layers, overlays: schema.clips.overlays, audio: schema.clips.audio })
      .from(schema.clips)
      .where(and(eq(schema.clips.projectId, p.id), isNull(schema.clips.deletedAt), ids ? inArray(schema.clips.id, ids) : undefined))
      .orderBy(schema.clips.id)
      .for("update");
    if (ids && clips.length !== ids.length) throw new TRPCError({ code: "NOT_FOUND", message: "Some of those clips no longer exist" });
    const result: ApplyResult = { updated: 0, rerendered: 0, skipped: [], layersSkipped: 0 };
    const touched: string[] = [];
    const now = new Date();
    for (const c of clips) {
      if (c.status === "preparing") {
        result.skipped.push({ clipId: c.id, reason: "still being prepared; its bounds are not final yet" });
        continue;
      }
      const resolved = resolveTemplateLayers(t.layers, c);
      result.layersSkipped += resolved.skipped.length;
      const next = input.mode === "add" ? [...clipLayers(c), ...resolved.layers] : resolved.layers;
      if (next.length > MAX_CLIP_LAYERS) throw new TRPCError({ code: "BAD_REQUEST", message: `Clip ${c.id} would have ${next.length} layers; a clip can have at most ${MAX_CLIP_LAYERS}. Use mode "replace" or remove some layers first.` });
      const cleaned = cleanLayers(next, c) ?? [];
      await u.db.update(schema.clips).set({ layers: cleaned, overlays: null, audio: null, editedAt: now, updatedAt: now }).where(eq(schema.clips.id, c.id));
      touched.push(c.id);
      result.updated++;
    }
    if (touched.length) {
      const fresh = await u.db.select({ id: schema.clips.id, bumpers: schema.clips.bumpers, layers: schema.clips.layers, overlays: schema.clips.overlays, audio: schema.clips.audio }).from(schema.clips).where(inArray(schema.clips.id, touched));
      await syncClipsRefs(u.db, p.id, fresh);
    }
    if (input.rerender) {
      for (const c of clips) if (touched.includes(c.id) && (c.status === "done" || c.status === "failed") && (await requestRender(svc, u, p.id, c.id)) !== null) result.rerendered++;
    }
    log.info({ mode: input.mode, clips: clips.length, updated: result.updated, rerendered: result.rerendered, skipped: result.skipped.length, layersSkipped: result.layersSkipped }, "layer template applied");
    return result;
  });
}

/**
 * The template a project's new clips get, read when the pipeline creates them: null when the project names none, or
 * names one that was removed (a warning says so; the clips are created without layers, never failed).
 */
export async function templateForNewClips(db: Db, userId: string, templateId: string | null | undefined, log: Logger): Promise<TemplateLayer[] | null> {
  if (!templateId) return null;
  const [row] = await db.select({ layers: schema.layerTemplates.layers, deletedAt: schema.layerTemplates.deletedAt }).from(schema.layerTemplates).where(and(eq(schema.layerTemplates.id, templateId), eq(schema.layerTemplates.userId, userId)));
  if (!row || row.deletedAt) {
    log.warn({ templateId, reason: row ? "removed" : "missing" }, "the project's layer template is not available; new clips get no layers");
    return null;
  }
  return row.layers;
}

/** The stored layers a new clip gets from a template (null = none): resolved against the clip, then cleaned. */
export function layersForNewClip(template: TemplateLayer[] | null, clip: { startSec: number; endSec: number }): ClipLayer[] | null {
  if (!template?.length) return null;
  const { layers } = resolveTemplateLayers(template, clip);
  return cleanLayers(layers, clip);
}
