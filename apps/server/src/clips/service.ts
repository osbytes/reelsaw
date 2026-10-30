/**
 * Clip edits: one implementation behind tRPC `clips.*`, the MCP clip tools and the operator CLI. Each function takes
 * the actor, does its own unit of work (ownership checked in the same transaction as the write), validates, moves
 * state through `pipeline/lifecycle.ts` and returns a structured result that says what changed and whether a render
 * was queued. Project-level edits are in `projects/service.ts`.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  MAX_CLIP_LAYERS,
  MAX_CLIP_SECONDS,
  MIN_CLIP_SECONDS,
  bumperSecondsSchema,
  clipBumpersSchema,
  clipLayerSchema,
  clipLayers,
  layoutSectionSchema,
  reframeModeSchema,
  styleOverrideSchema,
  type ClipLayer,
} from "@reelsaw/shared";
import { schema, type Db } from "../db/index.js";
import type { Services } from "../services.js";
import type { UnitOfWork } from "../uow.js";
import { RenderManyMissing, requestPrepare, requestRender, requestRenders } from "../pipeline/lifecycle.js";
import { needsPrepare } from "../pipeline/manual.js";
import { cleanLayers } from "../library/layers.js";
import { syncClipRefs, syncClipsRefs } from "../library/refs.js";
import { assetVisibleTo } from "../library/visible.js";
import { byOwner, findProject, NO_CLIP, type Actor } from "../projects/service.js";
import { clipEditDecision, rangeTexts, recordDecisions } from "../decisions/service.js";

/** Every asset id is one of the owner's library (an id the clip already uses stays valid even if it was removed since). */
export async function assertOwnedBumpers(
  db: Db,
  userId: string,
  ids: Array<string | null | undefined>,
  alreadyUsed: Array<string | null | undefined> = [],
  what = "intro or outro",
) {
  const want = [...new Set(ids.filter((x): x is string => !!x && !alreadyUsed.includes(x)))];
  if (!want.length) return;
  const rows = await db
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(and(inArray(schema.assets.id, want), assetVisibleTo(userId), isNull(schema.assets.deletedAt)));
  if (rows.length !== want.length) throw new TRPCError({ code: "NOT_FOUND", message: `That ${what} is not in your library` });
}

/**
 * A clip of a project the actor may edit, locked `for update` in the caller's unit of work, with its project (read, not
 * locked: clip before project). NOT_FOUND when the clip is gone, replaced (soft-deleted: restore it before editing it) or
 * belongs to someone else.
 */
export async function findClip(u: UnitOfWork, actor: Actor, clipId: string): Promise<{ clip: schema.Clip; project: schema.Project }> {
  const mine =
    actor && !actor.admin
      ? sql`exists (select 1 from ${schema.projects} where ${schema.projects.id} = ${schema.clips.projectId} and ${schema.projects.userId} = ${actor.id})`
      : undefined;
  const [clip] = await u.db
    .select()
    .from(schema.clips)
    .where(and(eq(schema.clips.id, clipId), isNull(schema.clips.deletedAt), mine))
    .for("update");
  if (!clip) throw new TRPCError({ code: "NOT_FOUND", message: NO_CLIP });
  return { clip, project: await findProject(u.db, actor, clip.projectId, { deleted: false }) };
}

/**
 * A clip row (deleted ones too, so a caller can say it was deleted) of a project the actor may see; NOT_FOUND otherwise.
 * The owner filter is part of the lookup, so a clip of someone else's project is indistinguishable from a missing one.
 */
export async function readClip(db: Db, actor: Actor, clipId: string): Promise<schema.Clip> {
  const mine =
    actor && !actor.admin
      ? sql`exists (select 1 from ${schema.projects} where ${schema.projects.id} = ${schema.clips.projectId} and ${schema.projects.userId} = ${actor.id})`
      : undefined;
  const [clip] = await db
    .select()
    .from(schema.clips)
    .where(and(eq(schema.clips.id, clipId), mine));
  if (!clip) throw new TRPCError({ code: "NOT_FOUND", message: NO_CLIP });
  return clip;
}

// ── update ─────────────────────────────────────────────────────────────────

export const updateClipInput = z.object({
  id: z.string(),
  title: z.string().min(1).max(120).optional(),
  hook: z.string().max(80).optional(),
  caption: z.string().max(300).optional(),
  hashtags: z.array(z.string().min(1).max(40)).max(20).optional(),
  layoutOverride: reframeModeSchema.nullable().optional(),
  /** Forced framing per section, absolute source seconds; [] or null = all auto. */
  layoutSections: z.array(layoutSectionSchema).max(50).nullable().optional(),
  /** Per-clip caption/hook style; null = follow the project. */
  style: styleOverrideSchema.nullable().optional(),
  /** Words the captions emphasise. */
  emphasis: z.array(z.string().min(1).max(40)).max(30).optional(),
  /** This clip's own intro/outro choice, replacing the whole value: a missing key inherits the project, null is none. */
  bumpers: clipBumpersSchema.nullable().optional(),
  /** Everything laid over or played under the clip (assets, text, sounds), replacing the whole list; null or [] = none. */
  layers: z.array(clipLayerSchema).max(MAX_CLIP_LAYERS).nullable().optional(),
  startSec: z.number().min(0).optional(),
  endSec: z.number().min(0).optional(),
  rerender: z.boolean().optional().describe("Re-render when a burned-in field changed (default true); false keeps the old video until the clip is re-rendered"),
});
export type UpdateClipInput = z.input<typeof updateClipInput>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Edit title / hook / caption / bounds / framing / style / emphasis / intro-outro / layers of one clip; only the fields
 * given change. Bounds, hook, framing, style, emphasis, bumpers and layers are burned into the video, so when one of them
 * changed the clip is queued for a re-render in the same transaction unless `rerender` is explicitly false. Title,
 * caption and hashtags are post metadata and apply at once. Returns the clip, which fields changed, whether a
 * re-render is needed and whether it was queued.
 */
export async function updateClip(svc: Services, actor: Actor, input: UpdateClipInput) {
  return svc.tx(async (u) => {
    // ownership and the row under lock: what changed is decided against the current row, not an earlier snapshot
    const { clip: c, project: p } = await findClip(u, actor, input.id);
    const startSec = input.startSec ?? c.startSec;
    const endSec = input.endSec ?? c.endSec;
    const boundsChanged = startSec !== c.startSec || endSec !== c.endSec;
    if (boundsChanged) {
      if (endSec - startSec < MIN_CLIP_SECONDS) throw new TRPCError({ code: "BAD_REQUEST", message: `A clip must be at least ${MIN_CLIP_SECONDS} seconds` });
      if (endSec - startSec > MAX_CLIP_SECONDS) throw new TRPCError({ code: "BAD_REQUEST", message: `A clip can be at most ${MAX_CLIP_SECONDS / 60} minutes` });
      if (p.durationSec && endSec > p.durationSec + 0.5) throw new TRPCError({ code: "BAD_REQUEST", message: "Clip ends after the video" });
    }
    const titleChanged = input.title !== undefined && input.title !== c.title;
    const captionChanged = input.caption !== undefined && input.caption !== c.caption;
    const hashtags = input.hashtags?.map((h) => h.replace(/^#+/, "")).filter(Boolean);
    const hashtagsChanged = hashtags !== undefined && !same(hashtags, c.hashtags);
    const hookChanged = input.hook !== undefined && input.hook !== c.hook;
    const layoutChanged = input.layoutOverride !== undefined && input.layoutOverride !== c.layoutOverride;
    const sectionsChanged = input.layoutSections !== undefined && !same(input.layoutSections ?? [], c.layoutSections ?? []);
    const styleChanged = input.style !== undefined && !same(input.style ?? null, c.style ?? null);
    const emphasisChanged = input.emphasis !== undefined && !same(input.emphasis, c.emphasis ?? []);
    const cleanBumpers =
      input.bumpers && Object.values(input.bumpers).some((v) => v !== undefined)
        ? {
            ...(input.bumpers.intro !== undefined ? { intro: input.bumpers.intro } : {}),
            ...(input.bumpers.introSec !== undefined ? { introSec: input.bumpers.introSec } : {}),
            ...(input.bumpers.outro !== undefined ? { outro: input.bumpers.outro } : {}),
            ...(input.bumpers.outroSec !== undefined ? { outroSec: input.bumpers.outroSec } : {}),
          }
        : null;
    const bumpersChanged = input.bumpers !== undefined && !same(cleanBumpers, c.bumpers ?? null);
    // layers replace the whole list
    const currentLayers = clipLayers(c);
    const nextLayers: ClipLayer[] | undefined = input.layers !== undefined ? (input.layers ?? []) : undefined;
    const cleanedLayers = nextLayers !== undefined ? cleanLayers(nextLayers, { startSec, endSec }) : undefined;
    const layersChanged =
      cleanedLayers !== undefined && !same(cleanedLayers, currentLayers.length ? cleanLayers(currentLayers, { startSec: c.startSec, endSec: c.endSec }) : null);
    const burned = {
      bounds: boundsChanged,
      hook: hookChanged,
      layoutOverride: layoutChanged,
      layoutSections: sectionsChanged,
      style: styleChanged,
      emphasis: emphasisChanged,
      bumpers: bumpersChanged,
      layers: layersChanged,
    };
    const changed = [
      ...(titleChanged ? ["title"] : []),
      ...(captionChanged ? ["caption"] : []),
      ...(hashtagsChanged ? ["hashtags"] : []),
      ...Object.entries(burned)
        .filter(([, v]) => v)
        .map(([k]) => k),
    ];
    const needsRerender = Object.values(burned).some(Boolean); // these are burned into the video
    // ownership of the chosen assets is checked in the unit of work that writes (the project owner's library)
    if (bumpersChanged) await assertOwnedBumpers(u.db, p.userId, [cleanBumpers?.intro, cleanBumpers?.outro], [c.bumpers?.intro, c.bumpers?.outro]);
    if (layersChanged)
      await assertOwnedBumpers(
        u.db,
        p.userId,
        (cleanedLayers ?? []).flatMap((l) => (l.kind === "text" ? [] : [l.assetId])),
        currentLayers.flatMap((l) => (l.kind === "text" ? [] : [l.assetId])),
        "library item",
      );
    const [row] = await u.db
      .update(schema.clips)
      .set({
        title: input.title ?? c.title,
        hook: input.hook ?? c.hook,
        caption: input.caption ?? c.caption,
        ...(hashtags !== undefined ? { hashtags } : {}),
        ...(input.layoutOverride !== undefined ? { layoutOverride: input.layoutOverride } : {}),
        ...(input.layoutSections !== undefined ? { layoutSections: input.layoutSections?.length ? input.layoutSections : null } : {}),
        ...(input.emphasis !== undefined ? { emphasis: input.emphasis.length ? input.emphasis : null } : {}),
        ...(input.style !== undefined ? { style: input.style && Object.keys(input.style).length ? input.style : null } : {}),
        ...(input.bumpers !== undefined ? { bumpers: cleanBumpers } : {}),
        // a clip saved with layers no longer carries the two old lists (clipLayers reads either)
        ...(cleanedLayers !== undefined ? { layers: cleanedLayers, overlays: null, audio: null } : {}),
        startSec: Number(startSec.toFixed(2)),
        endSec: Number(endSec.toFixed(2)),
        editedAt: new Date(), // a clip the user touched survives a re-analyze
        updatedAt: new Date(),
      })
      .where(eq(schema.clips.id, c.id))
      .returning();
    // the edit and its re-render (generation bump, job, project reopened) commit together
    const rerendered = needsRerender && input.rerender !== false && (await requestRender(svc, u, p.id, c.id)) !== null;
    const [fresh] = await u.db.select().from(schema.clips).where(eq(schema.clips.id, c.id));
    const clip = fresh ?? row;
    if (!clip) throw new TRPCError({ code: "NOT_FOUND", message: NO_CLIP });
    if (bumpersChanged || cleanedLayers !== undefined) await syncClipRefs(u.db, p.id, clip);
    if (byOwner(actor, p)) await recordDecisions(svc, u.db, p, async () => [await clipEditDecision(u.db, p.id, c, clip, changed)].filter((d) => d !== null));
    return { clip, changed, needsRerender, rerendered };
  });
}

// ── create ─────────────────────────────────────────────────────────────────

export const createClipInput = z.object({ projectId: z.string(), startSec: z.number().min(0), endSec: z.number().min(0), mode: z.enum(["exact", "ai"]) });
export type CreateClipInput = z.input<typeof createClipInput>;

/**
 * New clip from a transcript selection. mode "exact" keeps the bounds; "ai" searches inside them. The clip is born
 * "preparing": the clip.prepare job fills in its metadata (and bounds for "ai"), then it renders.
 */
export async function createClip(svc: Services, actor: Actor, input: CreateClipInput) {
  const len = input.endSec - input.startSec;
  const ai = input.mode === "ai";
  if (len < (ai ? 8 : MIN_CLIP_SECONDS))
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: ai ? "Select at least 8 seconds for the AI to search" : `A clip must be at least ${MIN_CLIP_SECONDS} seconds`,
    });
  if (!ai && len > MAX_CLIP_SECONDS) throw new TRPCError({ code: "BAD_REQUEST", message: `A clip can be at most ${MAX_CLIP_SECONDS / 60} minutes` });
  return svc.tx(async (u) => {
    const p = await findProject(u.db, actor, input.projectId, { deleted: false });
    if (p.durationSec && input.endSec > p.durationSec + 0.5) throw new TRPCError({ code: "BAD_REQUEST", message: "Selection ends after the video" });
    const transcript = await u.db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, p.id), columns: { projectId: true } });
    if (!transcript || !p.sourceKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The video must be downloaded and transcribed first" });
    const existing = await u.db.query.clips.findMany({ where: eq(schema.clips.projectId, p.id), columns: { index: true } });
    const index = existing.reduce((m, c) => Math.max(m, c.index + 1), 0);
    const [inserted] = await u.db
      .insert(schema.clips)
      .values({
        id: randomUUID(),
        projectId: p.id,
        index,
        title: ai ? "Finding the best moment…" : "New clip",
        hook: "",
        startSec: Number(input.startSec.toFixed(2)),
        endSec: Number(input.endSec.toFixed(2)),
        score: 0,
        reasoning: "",
        hashtags: [],
        status: "preparing",
        origin: ai ? "manual-ai" : "manual",
      })
      .returning();
    if (!inserted) throw new Error("the clip row was not returned");
    // born "preparing": the prepare job and the run start go through the one prepare path
    await requestPrepare(svc, u, p.id, inserted.id, { mode: input.mode, reason: "clip_added" });
    await u.emit(p.id, "clip.created", { clipId: inserted.id, index, title: inserted.title });
    if (byOwner(actor, p)) {
      await recordDecisions(svc, u.db, p, async () => {
        const [text] = await rangeTexts(u.db, p.id, [inserted]);
        return [
          {
            kind: "clip.create",
            clipId: inserted.id,
            before: null,
            after: { startSec: inserted.startSec, endSec: inserted.endSec, mode: input.mode },
            context: { text: text ?? "", startSec: inserted.startSec, endSec: inserted.endSec, origin: inserted.origin },
          },
        ];
      });
    }
    return { clip: inserted, queued: "prepare" as const };
  });
}

// ── intro / outro on several clips ─────────────────────────────────────────

export const clipBumpersManyInput = z.object({
  projectId: z.string(),
  clipIds: z.array(z.string()).min(1).max(200),
  intro: z.string().min(1).max(100).optional(),
  outro: z.string().min(1).max(100).optional(),
  introSec: bumperSecondsSchema.optional(),
  outroSec: bumperSecondsSchema.optional(),
  rerender: z.boolean().default(false),
});
export type ClipBumpersManyInput = z.input<typeof clipBumpersManyInput>;

/**
 * Set the intro and/or outro of several clips at once. Per slot: "inherit" (follow the project), "none", or a library
 * asset id; a slot left out is untouched. One atomic JSON merge per slot, in one transaction, with a render request per
 * finished clip only when `rerender` is set.
 */
export async function setClipBumpers(svc: Services, actor: Actor, input: ClipBumpersManyInput) {
  return svc.tx(async (u) => {
    const p = await findProject(u.db, actor, input.projectId, { deleted: false });
    const clips = await u.db
      .select({ id: schema.clips.id, status: schema.clips.status })
      .from(schema.clips)
      .where(and(eq(schema.clips.projectId, p.id), inArray(schema.clips.id, input.clipIds), isNull(schema.clips.deletedAt)))
      .orderBy(schema.clips.id)
      .for("update"); // id order, like lockProjectClips; replaced clips are not edited
    if (clips.length !== new Set(input.clipIds).size) throw new TRPCError({ code: "NOT_FOUND", message: "Some of those clips no longer exist" });
    await assertOwnedBumpers(
      u.db,
      p.userId,
      [input.intro, input.outro].map((x) => (x === "none" || x === "inherit" ? null : x)),
    );
    const ids = clips.map((c) => c.id);
    for (const [slot, choice, secs] of [
      ["intro", input.intro, input.introSec],
      ["outro", input.outro, input.outroSec],
    ] as const) {
      if (choice === undefined) continue;
      const patch =
        choice === "inherit" ? {} : { [slot]: choice === "none" ? null : choice, ...(secs !== undefined && choice !== "none" ? { [`${slot}Sec`]: secs } : {}) };
      await u.db
        .update(schema.clips)
        .set({
          bumpers: sql`nullif((coalesce(${schema.clips.bumpers}, '{}'::jsonb) - ${slot}::text - ${`${slot}Sec`}::text) || ${JSON.stringify(patch)}::jsonb, '{}'::jsonb)`,
          updatedAt: new Date(),
        })
        .where(inArray(schema.clips.id, ids));
    }
    await syncClipsRefs(
      u.db,
      p.id,
      await u.db
        .select({ id: schema.clips.id, bumpers: schema.clips.bumpers, layers: schema.clips.layers, overlays: schema.clips.overlays, audio: schema.clips.audio })
        .from(schema.clips)
        .where(inArray(schema.clips.id, ids)),
    );
    let rerendered = 0;
    if (input.rerender)
      for (const c of clips) if ((c.status === "done" || c.status === "failed") && (await requestRender(svc, u, p.id, c.id)) !== null) rerendered++;
    return { ok: true as const, updated: ids.length, rerendered };
  });
}

// ── re-render ──────────────────────────────────────────────────────────────

/**
 * Queue one clip to render again. A clip that was never prepared (the model was down) goes through preparation first,
 * which renders afterwards: `step` says which. `renderQueued` is true when a job was queued.
 */
export async function rerenderClip(svc: Services, actor: Actor, clipId: string) {
  return svc.tx(async (u) => {
    const { clip: c, project: p } = await findClip(u, actor, clipId);
    if (needsPrepare(c)) {
      const queued = await requestPrepare(svc, u, p.id, c.id, { reason: "rerender" });
      return { ok: true as const, step: "prepare" as const, renderQueued: queued };
    }
    const gen = await requestRender(svc, u, p.id, c.id);
    return { ok: true as const, step: "render" as const, renderQueued: gen !== null };
  });
}

export const rerenderManyInput = z.object({ projectId: z.string(), clipIds: z.array(z.string()).min(1).max(200) });
export type RerenderManyInput = z.input<typeof rerenderManyInput>;

/**
 * Re-render several clips of a project at once (the selection bar, "Retry failed"). One transaction, one run: finished
 * and failed clips are queued; clips still rendering or never prepared are counted as skipped.
 */
export async function rerenderClips(svc: Services, actor: Actor, input: RerenderManyInput) {
  return svc.tx(async (u) => {
    const p = await findProject(u.db, actor, input.projectId, { deleted: false });
    try {
      const r = await requestRenders(svc, u, p.id, input.clipIds);
      return { ok: true as const, ...r, renderQueued: r.rerendered > 0 };
    } catch (e) {
      if (e instanceof RenderManyMissing) throw new TRPCError({ code: "NOT_FOUND", message: e.message });
      throw e;
    }
  });
}
