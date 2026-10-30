/**
 * Layer templates (docs/specs/layer-templates.md): a named set of layers placed by timing modes (head / tail / fill /
 * relative) instead of absolute seconds, so one template fits a clip of any length. Applying one *materialises*
 * ordinary `clips.layers`: the render path, the editor and `asset_refs` never learn about templates. The tRPC
 * `layerTemplates.*` procedures, the `*_layer_template` MCP tools, `reelsaw templates` and the pipeline (new clips of
 * a project whose settings name a template) all call these functions.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { MAX_CLIP_LAYERS, clipLayers, layerTemplateLayersSchema, layerTemplateNameSchema, mergeTemplateBumpers, resolveTemplateLayers, templateBumperSlots, templateBumpersSchema, templateFromLayers, type ClipBumpers, type ClipLayer, type TemplateBumpers, type TemplateLayer } from "@reelsaw/shared";
import { schema, type Db } from "../db/index.js";
import type { Services } from "../services.js";
import type { Logger } from "../log.js";
import { requestRender } from "../pipeline/lifecycle.js";
import { resolveClipBumpers } from "../pipeline/bumpers.js";
import { assetVisibleTo } from "./visible.js";
import { syncClipsRefs } from "./refs.js";
import { cleanLayers } from "./layers.js";
import { LIST_LIMIT_DEFAULT, pageCursor, pageOf } from "../pagination.js";

/** Removed templates stay restorable this long; after that they drop off the list (the row remains until purge). */
export const TEMPLATE_RESTORE_DAYS = 30;
const RESTORE_DAYS = TEMPLATE_RESTORE_DAYS;

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
  bumpers: templateBumpersSchema.optional().describe("With layers: the intro / outro the template puts on clips ({ intro, introSec, outro, outroSec }; a slot left out = clips keep their own, null = none, an id = that video or image). With clipId the clip's intro and outro are saved too"),
};

export type PublicLayerTemplate = ReturnType<typeof publicTemplate>;
export function publicTemplate(t: schema.LayerTemplate) {
  return {
    id: t.id,
    name: t.name,
    layers: t.layers,
    layerCount: t.layers.length,
    /** intro / outro the template sets on clips (a missing slot = clips keep their own); null = it sets neither */
    bumpers: t.bumpers ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    deletedAt: t.deletedAt?.toISOString() ?? null,
  };
}

const notFound = () => new TRPCError({ code: "NOT_FOUND", message: `No such layer template. A removed template can be restored for ${RESTORE_DAYS} days (restore_layer_template).` });

/**
 * One keyset page of the account's templates, newest change first (`items`, `nextCursor`, `total` of all live ones), and
 * the ones removed in the last 30 days (restorable; at most 200, newest first).
 */
export async function listLayerTemplates(db: Db, userId: string, opts: { limit?: number; cursor?: string | undefined } = {}) {
  const T = schema.layerTemplates;
  const limit = opts.limit ?? LIST_LIMIT_DEFAULT;
  const cur = pageCursor(opts.cursor, 2);
  const live = and(eq(T.userId, userId), isNull(T.deletedAt));
  const cutoff = new Date(Date.now() - RESTORE_DAYS * 86_400_000);
  const [fetched, [counted], removed] = await Promise.all([
    db
      .select({ row: T, ts: sql<string>`${T.updatedAt}::text` })
      .from(T)
      .where(and(live, cur ? sql`(${T.updatedAt}, ${T.id}) < (${String(cur[0])}::timestamptz, ${String(cur[1])})` : undefined))
      .orderBy(desc(T.updatedAt), desc(T.id))
      .limit(limit + 1),
    db.select({ total: sql<number>`count(*)::int` }).from(T).where(live),
    db.select().from(T).where(and(eq(T.userId, userId), isNotNull(T.deletedAt), gt(T.deletedAt, cutoff))).orderBy(desc(T.updatedAt), desc(T.id)).limit(200),
  ]);
  const { items, nextCursor } = pageOf(fetched, limit, (r) => [r.ts, r.row.id]);
  return { items: items.map((r) => publicTemplate(r.row)), nextCursor, total: counted?.total ?? 0, deleted: removed.map(publicTemplate) };
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

/**
 * Every asset a template names is one the account may use (own upload or instance-shared) and still in the library;
 * an intro / outro is a video or an image, never a sound.
 */
async function assertTemplateAssets(db: Db, userId: string, layers: TemplateLayer[], bumpers?: TemplateBumpers | null) {
  const slots = templateBumperSlots(bumpers).flatMap((s) => {
    const id = bumpers?.[s];
    return id ? [[s, id] as const] : [];
  });
  const want = [...new Set([...layers.flatMap((l) => (l.kind === "text" ? [] : [l.assetId])), ...slots.map(([, id]) => id)])];
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
  for (const [slot, id] of slots) {
    const kind = kinds.get(id);
    if (!kind) throw new TRPCError({ code: "NOT_FOUND", message: `That ${slot} is not in your library` });
    if (kind === "audio") throw new TRPCError({ code: "BAD_REQUEST", message: `An ${slot} is a video or an image, not a sound` });
  }
}

/** The stored form: a value that sets no slot is null, so "sets neither" has one spelling. */
const storedBumpers = (b: TemplateBumpers | null | undefined): ClipBumpers | null => (templateBumperSlots(b).length ? mergeTemplateBumpers(null, b) : null);

/** Ids unique; nothing else to normalise here (windows are resolved per clip and cleaned there). */
function checkTemplateLayers(layers: TemplateLayer[]) {
  const seen = new Set<string>();
  for (const l of layers) {
    if (seen.has(l.id)) throw new TRPCError({ code: "BAD_REQUEST", message: `Layer id “${l.id}” is used twice` });
    seen.add(l.id);
  }
}

export async function createLayerTemplate(svc: Services, userId: string, input: { name: string; layers: TemplateLayer[]; bumpers?: TemplateBumpers | null | undefined }) {
  checkTemplateLayers(input.layers);
  const bumpers = storedBumpers(input.bumpers);
  return svc.tx(async (u) => {
    await assertTemplateAssets(u.db, userId, input.layers, bumpers);
    const [row] = await u.db.insert(schema.layerTemplates).values({ id: randomUUID(), userId, name: input.name.trim(), layers: input.layers, bumpers }).returning();
    svc.log.child({ module: "templates", userId }).info({ templateId: row!.id, layers: input.layers.length, bumpers: templateBumperSlots(bumpers) }, "layer template created");
    return publicTemplate(row!);
  });
}

/** `bumpers`: undefined = unchanged, null = the template sets no intro / outro, an object replaces the template's choice. */
export async function updateLayerTemplate(svc: Services, userId: string, id: string, patch: { name?: string | undefined; layers?: TemplateLayer[] | undefined; bumpers?: TemplateBumpers | null | undefined }) {
  if (patch.layers) checkTemplateLayers(patch.layers);
  const bumpers = patch.bumpers === undefined ? undefined : storedBumpers(patch.bumpers);
  return svc.tx(async (u) => {
    await getLayerTemplate(u.db, userId, id, { lock: true });
    if (patch.layers || bumpers) await assertTemplateAssets(u.db, userId, patch.layers ?? [], bumpers);
    const [row] = await u.db
      .update(schema.layerTemplates)
      .set({ ...(patch.name !== undefined ? { name: patch.name.trim() } : {}), ...(patch.layers !== undefined ? { layers: patch.layers } : {}), ...(bumpers !== undefined ? { bumpers } : {}), updatedAt: new Date() })
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

/** Hard-delete a removed template. Templates hold no media files; this only drops the row. */
export async function purgeLayerTemplate(svc: Services, userId: string, id: string) {
  return svc.tx(async (u) => {
    const [row] = await u.db
      .select({ id: schema.layerTemplates.id, name: schema.layerTemplates.name, deletedAt: schema.layerTemplates.deletedAt })
      .from(schema.layerTemplates)
      .where(and(eq(schema.layerTemplates.id, id), eq(schema.layerTemplates.userId, userId)))
      .for("update");
    if (!row) throw notFound();
    if (!row.deletedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Remove it first. Only templates already in Deleted can be deleted forever." });
    await u.db.delete(schema.layerTemplates).where(eq(schema.layerTemplates.id, id));
    return { ok: true as const, message: `Deleted “${row.name}” forever.` };
  });
}

/**
 * A template from one clip's current look: its layers (templateFromLayers decides each layer's timing) and the intro /
 * outro it renders with, whether its own or the project's. A slot with neither is left unset, so applying the template
 * never takes an intro away.
 */
export async function layerTemplateFromClip(svc: Services, userId: string, input: { clipId: string; name: string }) {
  const [row] = await svc.database.db
    .select({ id: schema.clips.id, startSec: schema.clips.startSec, endSec: schema.clips.endSec, layers: schema.clips.layers, overlays: schema.clips.overlays, audio: schema.clips.audio, bumpers: schema.clips.bumpers, settings: schema.projects.settings })
    .from(schema.clips)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.clips.projectId))
    .where(and(eq(schema.clips.id, input.clipId), isNull(schema.clips.deletedAt), eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt)));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "No such clip" });
  const layers = templateFromLayers(clipLayers(row), row);
  const r = resolveClipBumpers(row.settings ?? {}, row);
  const bumpers: ClipBumpers = {
    ...(r.introId ? { intro: r.introId, ...(r.introSec !== undefined ? { introSec: r.introSec } : {}) } : {}),
    ...(r.outroId ? { outro: r.outroId, ...(r.outroSec !== undefined ? { outroSec: r.outroSec } : {}) } : {}),
  };
  if (!layers.length && !templateBumperSlots(bumpers).length) throw new TRPCError({ code: "BAD_REQUEST", message: "This clip has no layers, intro or outro to save as a template" });
  return createLayerTemplate(svc, userId, { name: input.name, layers, bumpers });
}

export interface ApplyResult {
  updated: number;
  rerendered: number;
  /** clips left alone, with why (still being prepared) */
  skipped: Array<{ clipId: string; reason: string }>;
  /** template layers that had no room on some clip (a tail longer than the clip, a relative window under its minimum) */
  layersSkipped: number;
  /** the intro / outro slots the template set on the updated clips (empty = it sets neither) */
  bumpers: Array<"intro" | "outro">;
}

/**
 * Materialise a template on clips of one project: each clip gets the template's layers resolved against its own
 * length (replacing its layers, or added to them) and the intro / outro slots the template sets (in both modes: a clip
 * has one intro and one outro; slots the template leaves unset keep the clip's own), is marked edited (so a re-analyze keeps it) and, with `rerender`,
 * re-rendered when finished. One transaction: clips locked in id order (like lockProjectClips), asset refs rewritten
 * with the layers. A clip still being prepared has no final bounds and is skipped with a reason.
 */
export async function applyLayerTemplate(svc: Services, userId: string, input: { templateId: string; projectId: string; clipIds?: string[] | undefined; mode: "replace" | "add"; rerender: boolean }): Promise<ApplyResult> {
  const log = svc.log.child({ module: "templates", userId, projectId: input.projectId, templateId: input.templateId });
  return svc.tx(async (u) => {
    const [p] = await u.db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.id, input.projectId), eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt)));
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "No such project" });
    const t = await getLayerTemplate(u.db, userId, input.templateId);
    await assertTemplateAssets(u.db, userId, t.layers, t.bumpers);
    const slots = templateBumperSlots(t.bumpers);
    const ids = input.clipIds ? [...new Set(input.clipIds)] : undefined;
    const clips = await u.db
      .select({ id: schema.clips.id, status: schema.clips.status, startSec: schema.clips.startSec, endSec: schema.clips.endSec, layers: schema.clips.layers, overlays: schema.clips.overlays, audio: schema.clips.audio, bumpers: schema.clips.bumpers })
      .from(schema.clips)
      .where(and(eq(schema.clips.projectId, p.id), isNull(schema.clips.deletedAt), ids ? inArray(schema.clips.id, ids) : undefined))
      .orderBy(schema.clips.id)
      .for("update");
    if (ids && clips.length !== ids.length) throw new TRPCError({ code: "NOT_FOUND", message: "Some of those clips no longer exist" });
    const result: ApplyResult = { updated: 0, rerendered: 0, skipped: [], layersSkipped: 0, bumpers: slots };
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
      const bumpers = slots.length ? { bumpers: mergeTemplateBumpers(c.bumpers, t.bumpers) } : {};
      await u.db.update(schema.clips).set({ layers: cleaned, overlays: null, audio: null, ...bumpers, editedAt: now, updatedAt: now }).where(eq(schema.clips.id, c.id));
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
    log.info({ mode: input.mode, bumpers: slots, clips: clips.length, updated: result.updated, rerendered: result.rerendered, skipped: result.skipped.length, layersSkipped: result.layersSkipped }, "layer template applied");
    return result;
  });
}

/** What a project's new clips take from its template. */
export interface NewClipTemplate {
  layers: TemplateLayer[];
  bumpers: TemplateBumpers | null;
}

/**
 * The template a project's new clips get, read when the pipeline creates them: null when the project names none, or
 * names one that was removed (a warning says so; the clips are created without its layers or intro / outro, never failed).
 */
export async function templateForNewClips(db: Db, userId: string, templateId: string | null | undefined, log: Logger): Promise<NewClipTemplate | null> {
  if (!templateId) return null;
  const [row] = await db.select({ layers: schema.layerTemplates.layers, bumpers: schema.layerTemplates.bumpers, deletedAt: schema.layerTemplates.deletedAt }).from(schema.layerTemplates).where(and(eq(schema.layerTemplates.id, templateId), eq(schema.layerTemplates.userId, userId)));
  if (!row || row.deletedAt) {
    log.warn({ templateId, reason: row ? "removed" : "missing" }, "the project's layer template is not available; new clips get no layers");
    return null;
  }
  return { layers: row.layers, bumpers: row.bumpers ?? null };
}

/** The stored layers a new clip gets from a template (null = none): resolved against the clip, then cleaned. */
export function layersForNewClip(template: NewClipTemplate | null, clip: { startSec: number; endSec: number }): ClipLayer[] | null {
  if (!template?.layers.length) return null;
  const { layers } = resolveTemplateLayers(template.layers, clip);
  return cleanLayers(layers, clip);
}

/**
 * The intro / outro a new clip gets from a template, over what the clip already chose (`own`: a manual clip the user
 * gave an intro while it was being prepared keeps it). Null = follow the project for both.
 */
export function bumpersForNewClip(template: NewClipTemplate | null, own: ClipBumpers | null = null): ClipBumpers | null {
  return mergeTemplateBumpers(own, template?.bumpers, { onlyUnset: true });
}

/**
 * A template's intro / outro after a CLI-style change: per slot "keep" = the template leaves clips' own choice alone,
 * "none" = no intro / outro, an id = that asset; a slot not mentioned stays as it is. Seconds go with the slot.
 */
export function templateBumpersWith(cur: TemplateBumpers | null, change: { intro?: string | undefined; outro?: string | undefined; introSec?: number | undefined; outroSec?: number | undefined }): TemplateBumpers | null {
  const next: TemplateBumpers = { ...(cur ?? {}) };
  for (const s of ["intro", "outro"] as const) {
    const choice = change[s];
    if (choice !== undefined) {
      delete next[s];
      delete next[`${s}Sec`];
      if (choice !== "keep") next[s] = choice === "none" ? null : choice;
    }
    const sec = change[`${s}Sec`];
    if (sec !== undefined && next[s]) next[`${s}Sec`] = sec;
  }
  return templateBumperSlots(next).length ? next : null;
}

/** "; intro <id>, outro none" for listings; "" when the template sets neither. */
export function templateBumpersText(b: TemplateBumpers | null): string {
  const parts = templateBumperSlots(b).map((s) => `${s} ${b![s] ?? "none"}${b![`${s}Sec`] ? ` ${b![`${s}Sec`]} s` : ""}`);
  return parts.length ? `; ${parts.join(", ")}` : "";
}
