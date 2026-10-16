import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { TRPCError, tracked } from "@trpc/server";
import { router, protectedProcedure, publicProcedure } from "./context.js";
import { schema, type Db } from "../db/index.js";
import { createProjectInputSchema, projectSettingsSchema, defaultProjectSettings, reframeModeSchema, styleOverrideSchema, layoutSectionSchema, styleSchema, type ProjectEvent, type TranscriptFlag } from "@reelsaw/shared";
import { QUEUES, type QueueName } from "../queue/boss.js";
import type { Services } from "../services.js";
import type { UnitOfWork } from "../uow.js";
import { requestRender, reopenProject } from "../pipeline/lifecycle.js";
import { listClips } from "../pipeline/analyze.js";
import { keys } from "../storage/index.js";
import { applyFlags } from "../pipeline/entities.js";
import { enqueueRefine, REFINE_QUEUE } from "../pipeline/refine.js";
import { REFINE_STEPS } from "@reelsaw/shared";
import { toSentences } from "../pipeline/transcript.js";
import { needsPrepare, prepareModeOf } from "../pipeline/manual.js";

function publicClip(c: schema.Clip) {
  return {
    id: c.id,
    projectId: c.projectId,
    index: c.index,
    title: c.title,
    hook: c.hook,
    startSec: c.startSec,
    endSec: c.endSec,
    score: c.score,
    reasoning: c.reasoning,
    caption: c.caption,
    hashtags: c.hashtags,
    layoutOverride: c.layoutOverride,
    layoutSections: c.layoutSections ?? [],
    layoutSegments: c.layoutSegments ?? [],
    style: c.style ?? null,
    scores: c.scores ?? null,
    emphasis: c.emphasis ?? [],
    status: c.status,
    origin: c.origin,
    diagnostics: c.diagnostics ?? null,
    error: c.error,
    layout: c.layout,
    layoutInfo: c.layoutInfo,
    videoUrl: c.outputKey ? `/media/clips/${c.projectId}/${c.id}.mp4` : null,
    thumbnailUrl: c.thumbnailKey ? `/media/clips/${c.projectId}/${c.id}.jpg` : null,
    createdAt: c.createdAt.toISOString(),
  };
}

function publicProject(p: schema.Project) {
  return {
    id: p.id,
    title: p.title,
    sourceType: p.sourceType,
    sourceUrl: p.sourceUrl,
    sourceMeta: p.sourceMeta,
    durationSec: p.durationSec,
    width: p.width,
    height: p.height,
    status: p.status,
    stage: p.stage,
    stageProgress: p.stageProgress,
    error: p.error,
    settings: p.settings,
    sourceVideoUrl: p.sourceKey ? `/media/source/${p.id}` : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/**
 * A fix the user made by hand over the raw words in [start, end]: a cut (kind disfluency, empty
 * text) or a correction (kind entity, replacement text). Overlapping fixes are absorbed into it and
 * come back if it is deleted. Cuts refuse to swallow name fixes; corrections replace anything.
 */
async function addManualFix(svc: Services, userId: string, input: { projectId: string; start: number; end: number; rerender: boolean }, what: { kind: "disfluency" | "entity"; text: string }) {
  return withTranscript(svc, userId, input.projectId, async (u, p, t) => {
  const raw = t.rawWords ?? t.words;
  const idx = raw.map((w, i) => ({ w, i })).filter(({ w }) => w.start >= input.start - 0.02 && w.end <= input.end + 0.02);
  if (!idx.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Select at least one whole word" });
  let from = idx[0]!.i;
  let to = idx.at(-1)!.i;
  const hits = (f: TranscriptFlag) => f.wordIndex <= to && f.wordIndex + f.span - 1 >= from;
  if (what.kind === "disfluency" && t.flags.some((f) => f.kind === "entity" && hits(f))) throw new TRPCError({ code: "BAD_REQUEST", message: "The selection overlaps a correction. Delete that first, or select around it." });
  // cuts grow to cover overlapping cuts; a correction replaces exactly the words you selected
  const merged = t.flags.filter(hits);
  if (what.kind === "disfluency")
    for (const f of merged) {
      from = Math.min(from, f.wordIndex);
      to = Math.max(to, f.wordIndex + f.span - 1);
    }
  else if (merged.some((f) => f.wordIndex < from || f.wordIndex + f.span - 1 > to))
    throw new TRPCError({ code: "BAD_REQUEST", message: "The selection cuts through another fix. Select all of its words, or delete it first." });
  const span = raw.slice(from, to + 1);
  const flag: TranscriptFlag = {
    id: randomUUID(),
    kind: what.kind,
    subkind: "manual",
    wordIndex: from,
    span: span.length,
    start: span[0]!.start,
    end: span.at(-1)!.end,
    heard: span.map((w) => w.text).join(" "),
    suggested: what.text,
    ...(what.text ? { replacement: what.text } : {}),
    confidence: 1,
    status: "accepted",
    // a growing cut swallows other cuts' contents; a correction keeps each fix whole so deleting it restores them as they were
    absorbed: merged.flatMap((f) => (what.kind === "disfluency" && f.subkind === "manual" ? (f.absorbed ?? []) : [f as Record<string, unknown>])),
  };
  const flags = [...t.flags.filter((f) => !merged.includes(f)), flag].sort((a, b) => a.wordIndex - b.wordIndex);
  const rerendered = await saveFlags(svc, u, p, t, flags, t.deletedFlags ?? [], flag, input.rerender);
  return { ok: true, flagId: flag.id, rerendered };
  });
}

/**
 * Read-modify-write on a project's transcript flags, as one unit of work: ownership check, the
 * transcript row locked FOR UPDATE (so a concurrent edit or refine merge waits instead of being
 * overwritten), then the change, its re-renders and its event commit together.
 */
async function withTranscript<T>(svc: Services, userId: string, projectId: string, fn: (u: UnitOfWork, p: schema.Project, t: schema.Transcript) => Promise<T>): Promise<T> {
  return svc.tx(async (u) => {
    const p = await ownedProject(u.db, userId, projectId);
    const [t] = await u.db.select().from(schema.transcripts).where(eq(schema.transcripts.projectId, p.id)).for("update");
    if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "No transcript" });
    return fn(u, p, t);
  });
}

type DeletedFlag = TranscriptFlag & { deletedAt: string };
/** Move a live flag to the deleted list; a manual cut hands back the flags it absorbed. */
function softDelete(flags: TranscriptFlag[], deleted: DeletedFlag[], id: string): { flags: TranscriptFlag[]; deletedFlags: DeletedFlag[] } {
  const f = flags.find((x) => x.id === id);
  if (!f) return { flags, deletedFlags: deleted };
  return {
    flags: flags.flatMap((x) => (x.id === id ? restoreAbsorbed(x) : [x])).sort((a, b) => a.wordIndex - b.wordIndex),
    deletedFlags: [...deleted.filter((x) => x.id !== id), { ...f, status: f.subkind === "manual" ? "accepted" : f.status, deletedAt: new Date().toISOString() }].slice(-500),
  };
}

/** Persist new flag lists, rebuild the cleaned words, re-render clips whose words changed around `f`. */
async function saveFlags(svc: Services, u: UnitOfWork, p: schema.Project, t: schema.Transcript, flags: TranscriptFlag[], deletedFlags: DeletedFlag[], f: TranscriptFlag, rerender: boolean) {
  const db = u.db;
  const raw = t.rawWords ?? t.words;
  const words = applyFlags(raw, flags);
  const segments = toSentences(words);
  await db.update(schema.transcripts).set({ words, rawWords: raw, flags, deletedFlags, segments, text: segments.map((x) => x.text).join(" ") }).where(eq(schema.transcripts.projectId, p.id));
  const near = (ws: typeof words) => JSON.stringify(ws.filter((w) => w.end > f.start - 0.05 && w.start < f.end + 0.05));
  const changed = near(applyFlags(raw, t.flags)) !== near(words);
  const rerendered = rerender && changed ? await rerenderOverlapping(svc, u, p, [{ start: f.start, end: f.end }]) : 0;
  await u.emit(p.id, "stage.started", { stage: "review", changed: changed ? 1 : 0, rerendered });
  return rerendered;
}

/** Deleting a flag: a manual cut is replaced by the detector flags it absorbed (with their decisions). */
function restoreAbsorbed(f: TranscriptFlag): TranscriptFlag[] {
  if (f.subkind !== "manual") return [];
  return (f.absorbed ?? []).map((a) => a as unknown as TranscriptFlag);
}

/** Re-render every clip overlapping one of the ranges (absolute seconds). Returns how many. */
async function rerenderOverlapping(svc: Services, u: UnitOfWork, p: schema.Project, ranges: Array<{ start: number; end: number }>) {
  if (!ranges.length) return 0;
  let n = 0;
  for (const c of await listClips(u.db, p.id)) {
    if (!ranges.some((r) => r.end > c.startSec && r.start < c.endSec)) continue;
    if ((await requestRender(svc, u, p.id, c.id)) !== null) n++;
  }
  return n;
}

/** Re-render the clips matching `which` (default: finished or failed ones) in this unit of work. */
async function rerenderClips(svc: Services, u: UnitOfWork, projectId: string, which: (c: schema.Clip) => boolean = (c) => c.status === "done" || c.status === "failed") {
  let n = 0;
  for (const c of await listClips(u.db, projectId)) if (which(c) && (await requestRender(svc, u, projectId, c.id)) !== null) n++;
  return n;
}

async function ownedProject(db: Db, userId: string, projectId: string) {
  const p = await db.query.projects.findFirst({ where: and(eq(schema.projects.id, projectId), eq(schema.projects.userId, userId)) });
  if (!p) throw new TRPCError({ code: "NOT_FOUND" });
  return p;
}

const STAGE_QUEUES = [QUEUES.ingest, QUEUES.transcribe, QUEUES.refineEntities, QUEUES.refineDisfluency, QUEUES.refineScenes, QUEUES.analyze] as const;

/** Best-effort title + thumbnail for a URL before ingest runs (YouTube/Vimeo oEmbed, 4 s budget). */
async function peekUrlMeta(url: string): Promise<{ title?: string; thumbnail?: string; uploader?: string }> {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return {};
  }
  const oembed = /(^|\.)(youtube\.com|youtu\.be)$/.test(host)
    ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`
    : /(^|\.)vimeo\.com$/.test(host)
      ? `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`
      : null;
  if (!oembed) return { title: host };
  try {
    const res = await fetch(oembed, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { title: host };
    const j = (await res.json()) as { title?: string; thumbnail_url?: string; author_name?: string };
    return { title: j.title, thumbnail: j.thumbnail_url, uploader: j.author_name };
  } catch {
    return { title: host };
  }
}

export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, time: new Date().toISOString() })),

  settings: router({
    get: protectedProcedure.query(async ({ ctx }) => ({
      aiModel: ctx.svc.config.AI_MODEL,
      transcriptionModel: ctx.svc.config.TRANSCRIPTION_MODEL,
      openaiBaseUrl: ctx.svc.config.OPENAI_BASE_URL ?? null,
      compatBaseUrl: ctx.svc.config.OPENAI_COMPATIBLE_BASE_URL ?? null,
      storage: ctx.svc.storage.driver,
      faceDetection: !!ctx.svc.faces,
      allowSignup: ctx.svc.config.ALLOW_SIGNUP,
      maxUploadMb: ctx.svc.config.MAX_UPLOAD_MB,
      renderConcurrency: ctx.svc.config.RENDER_CONCURRENCY,
      otel: ctx.svc.otel.enabled,
      defaults: defaultProjectSettings,
      resources: await ctx.svc.resources.snapshot(),
      limits: { maxCpuPercent: ctx.svc.config.MAX_CPU_PERCENT, minFreeMemMB: ctx.svc.config.MIN_FREE_MEM_MB, minFreeDiskMB: ctx.svc.config.MIN_FREE_DISK_MB },
    })),
  }),

  /** ⌘K palette: everything searchable, small enough to fuzzy-match on the client. */
  searchIndex: protectedProcedure.query(async ({ ctx }) => {
    const db = ctx.svc.database.db;
    const projects = await db.query.projects.findMany({ where: eq(schema.projects.userId, ctx.user.id), columns: { id: true, title: true, status: true, durationSec: true, sourceMeta: true }, orderBy: desc(schema.projects.updatedAt), limit: 500 });
    const ids = projects.map((p) => p.id);
    const clips = ids.length
      ? await db.query.clips.findMany({ where: inArray(schema.clips.projectId, ids), columns: { id: true, projectId: true, title: true, hook: true, caption: true, index: true, status: true, startSec: true, thumbnailKey: true }, limit: 5000 })
      : [];
    const titleOf = new Map(projects.map((p) => [p.id, p.title]));
    return {
      projects: projects.map((p) => ({ id: p.id, title: p.title, status: p.status, durationSec: p.durationSec, thumbnailUrl: (p.sourceMeta?.thumbnail as string | undefined) ?? null })),
      clips: clips.map((c) => ({ id: c.id, projectId: c.projectId, projectTitle: titleOf.get(c.projectId) ?? "", title: c.title, hook: c.hook, caption: c.caption, index: c.index, status: c.status, startSec: c.startSec, thumbnailUrl: c.thumbnailKey ? `/media/clips/${c.projectId}/${c.id}.jpg` : null })),
    };
  }),

  projects: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const db = ctx.svc.database.db;
      const rows = await db.query.projects.findMany({ where: eq(schema.projects.userId, ctx.user.id), orderBy: desc(schema.projects.createdAt), limit: 200 });
      const clipRows = rows.length
        ? await db.query.clips.findMany({
            where: inArray(schema.clips.projectId, rows.map((r) => r.id)),
            columns: { projectId: true, status: true, thumbnailKey: true, id: true, index: true },
          })
        : [];
      return rows.map((p) => {
        const mine = clipRows.filter((c) => c.projectId === p.id);
        const firstThumb = mine.find((c) => c.thumbnailKey);
        const clipThumbs = mine
          .filter((c) => c.thumbnailKey && c.status === "done")
          .sort((a, b) => a.index - b.index)
          .slice(0, 3)
          .map((c) => `/media/clips/${p.id}/${c.id}.jpg`);
        return {
          ...publicProject(p),
          clipCount: mine.length,
          clipsDone: mine.filter((c) => c.status === "done").length,
          // the source's own thumbnail stays the card image; clip thumbnails stack on top of it
          sourceThumbnailUrl: (p.sourceMeta?.thumbnail as string | undefined) ?? null,
          clipThumbs,
          thumbnailUrl: firstThumb ? `/media/clips/${p.id}/${firstThumb.id}.jpg` : ((p.sourceMeta?.thumbnail as string | undefined) ?? null),
        };
      });
    }),

    get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
      const db = ctx.svc.database.db;
      const p = await ownedProject(db, ctx.user.id, input.id);
      const clips = await listClips(db, p.id);
      const transcript = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, p.id), columns: { language: true, text: true, segments: true, words: true, rawWords: true, flags: true, entities: true, refine: true, sceneCuts: true, overlays: true, textProfile: true, deletedFlags: true } });
      return { ...publicProject(p), clips: clips.map(publicClip), transcript: transcript ?? null };
    }),

    create: protectedProcedure.input(createProjectInputSchema).mutation(async ({ ctx, input }) => {
      const { svc } = ctx;
      const db = svc.database.db;
      if (!input.sourceUrl && !input.uploadId) throw new TRPCError({ code: "BAD_REQUEST", message: "Provide a sourceUrl or an uploadId" });
      const settings = projectSettingsSchema.parse({ ...defaultProjectSettings, ...(input.settings ?? {}) });
      if (settings.minClipSeconds >= settings.maxClipSeconds) throw new TRPCError({ code: "BAD_REQUEST", message: "minClipSeconds must be below maxClipSeconds" });

      let sourceMeta: schema.Project["sourceMeta"] = null;
      let title = input.title?.trim() || "";
      if (input.uploadId) {
        const u = await db.query.uploads.findFirst({ where: and(eq(schema.uploads.id, input.uploadId), eq(schema.uploads.userId, ctx.user.id)) });
        if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "Upload not found" });
        sourceMeta = { uploadId: u.id, filename: u.filename };
        title ||= u.filename.replace(/\.[^.]+$/, "");
      } else if (input.sourceUrl) {
        const peek = await peekUrlMeta(input.sourceUrl);
        sourceMeta = { ...(peek.thumbnail ? { thumbnail: peek.thumbnail } : {}), ...(peek.uploader ? { uploader: peek.uploader } : {}) };
        title ||= peek.title ?? "";
      }
      title ||= "Untitled";
      const id = randomUUID();
      // row, event and first job together: never a "queued" project with no job behind it
      const p = await svc.tx(async (u) => {
        const [row] = await u.db
          .insert(schema.projects)
          .values({ id, userId: ctx.user.id, title, sourceType: input.uploadId ? "upload" : "url", sourceUrl: input.sourceUrl ?? null, sourceMeta, settings, status: "queued" })
          .returning();
        await u.emit(id, "project.created", { title });
        await u.enqueue(QUEUES.ingest, { projectId: id });
        return row!;
      });
      return publicProject(p);
    }),

    /** Resume from the furthest completed stage; each stage skips work that already exists. */
    retry: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
      const { svc } = ctx;
      return svc.tx(async (u) => {
        const db = u.db;
        const p = await ownedProject(db, ctx.user.id, input.id);
        const clips = await listClips(db, p.id);
        const transcript = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, p.id), columns: { projectId: true, refine: true } });
        const refineDone = !!transcript && REFINE_STEPS.every((s) => transcript.refine[s] === "done" || transcript.refine[s] === "failed");
        let queue: QueueName = QUEUES.ingest;
        if (clips.length) queue = QUEUES.render;
        else if (transcript && refineDone) queue = QUEUES.analyze;
        else if (transcript) queue = QUEUES.refineEntities; // marker: resume the refine fan-out
        else if (p.sourceKey) queue = QUEUES.transcribe;

        if (queue === QUEUES.render) {
          await db.update(schema.projects).set({ status: "rendering", stage: "render", error: null, updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
          for (const c of clips) {
            if (c.status === "done") continue;
            // a user-made clip whose AI preparation never finished goes back through clip.prepare
            if (needsPrepare(c)) {
              await u.cancelLiveJobs(QUEUES.prepare, c.id);
              await db.update(schema.clips).set({ status: "preparing", error: null }).where(eq(schema.clips.id, c.id));
              await u.enqueue(QUEUES.prepare, { projectId: p.id, clipId: c.id, mode: prepareModeOf(c) });
              continue;
            }
            await requestRender(svc, u, p.id, c.id);
          }
        } else if (queue === QUEUES.refineEntities) {
          for (const q of STAGE_QUEUES) await u.cancelLiveJobs(q, p.id);
          await enqueueRefine(svc, p.id, undefined, u);
        } else {
          for (const q of STAGE_QUEUES) await u.cancelLiveJobs(q, p.id);
          await db.update(schema.projects).set({ status: "queued", error: null, updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
          await u.enqueue(queue, { projectId: p.id });
        }
        await u.emit(p.id, "stage.started", { stage: queue, retried: true });
        return { ok: true, queue };
      });
    }),

    /** Re-run some or all refine steps (names, disfluencies, scene cuts) on the existing transcript. */
    refine: protectedProcedure
      .input(z.object({ id: z.string(), steps: z.array(z.enum(REFINE_STEPS)).optional(), vocabulary: z.string().max(1000).optional() }))
      .mutation(async ({ ctx, input }) => {
        const { svc } = ctx;
        const db = svc.database.db;
        const p = await ownedProject(db, ctx.user.id, input.id);
        const t = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, p.id), columns: { refine: true } });
        if (!t) throw new TRPCError({ code: "BAD_REQUEST", message: "Project has no transcript yet" });
        const steps = input.steps?.length ? input.steps : [...REFINE_STEPS];
        if (input.vocabulary !== undefined) {
          const settings = projectSettingsSchema.parse({ ...p.settings, vocabulary: input.vocabulary || undefined });
          await db.update(schema.projects).set({ settings }).where(eq(schema.projects.id, p.id));
        }
        await svc.tx(async (u) => {
          for (const s of steps) await u.cancelLiveJobs(REFINE_QUEUE[s], p.id);
          const [cur] = await u.db.select({ refine: schema.transcripts.refine }).from(schema.transcripts).where(eq(schema.transcripts.projectId, p.id)).for("update");
          const refine = { ...(cur?.refine ?? t.refine) };
          for (const s of steps) delete refine[s];
          await u.db.update(schema.transcripts).set({ refine }).where(eq(schema.transcripts.projectId, p.id));
          await enqueueRefine(svc, p.id, steps, u);
        });
        return { ok: true, steps };
      }),

    /** Keep the transcript, discard clips, pick new moments (optionally with new settings). */
    /** Hide or keep text burned into the source (captions, logos); re-renders finished clips. */
    setSourceText: protectedProcedure.input(z.object({ id: z.string(), sourceText: z.enum(["hide", "keep", "always"]) })).mutation(async ({ ctx, input }) => {
      const { svc } = ctx;
      const db = svc.database.db;
      void db;
      const rerendered = await svc.tx(async (u) => {
        const p = await ownedProject(u.db, ctx.user.id, input.id);
        // atomic JSON merge: no read-modify-write, so concurrent settings edits can't drop each other
        await u.db.update(schema.projects).set({ settings: sql`${schema.projects.settings} || ${JSON.stringify({ sourceText: input.sourceText })}::jsonb`, updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
        return rerenderClips(svc, u, p.id);
      });
      return { ok: true, rerendered };
    }),

    /** oEmbed title/thumbnail for the new-project preview, before anything is created. */
    peek: protectedProcedure.input(z.object({ url: z.url() })).query(async ({ input }) => peekUrlMeta(input.url)),

    /**
     * Change the project-wide caption/hook style. Clears per-clip style overrides unless keepOverrides,
     * and re-renders every finished clip so the whole set stays consistent.
     */
    updateStyle: protectedProcedure
      .input(z.object({ id: z.string(), style: styleSchema.partial(), keepOverrides: z.boolean().optional(), rerender: z.boolean().default(true) }))
      .mutation(async ({ ctx, input }) => {
        const { svc } = ctx;
        const db = svc.database.db;
        void db;
        const rerendered = await svc.tx(async (u) => {
          const p = await ownedProject(u.db, ctx.user.id, input.id);
          // validate against the whole settings object, but write only the changed keys (atomic merge)
          const merged = projectSettingsSchema.parse({ ...p.settings, ...input.style });
          const patch = Object.fromEntries(Object.keys(input.style).map((k) => [k, merged[k as keyof typeof merged]]));
          await u.db
            .update(schema.projects)
            .set({ settings: sql`(${schema.projects.settings} - 'captionPosition') || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
            .where(eq(schema.projects.id, p.id));
          if (!input.keepOverrides) await u.db.update(schema.clips).set({ style: null }).where(eq(schema.clips.projectId, p.id));
          return input.rerender ? rerenderClips(svc, u, p.id) : 0;
        });
        return { ok: true, rerendered };
      }),

    reanalyze: protectedProcedure.input(z.object({ id: z.string(), settings: projectSettingsSchema.partial().optional() })).mutation(async ({ ctx, input }) => {
      const { svc } = ctx;
      const db = svc.database.db;
      const p = await ownedProject(db, ctx.user.id, input.id);
      const transcript = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, p.id), columns: { projectId: true } });
      if (!transcript) throw new TRPCError({ code: "BAD_REQUEST", message: "Project has no transcript yet" });
      const settings = projectSettingsSchema.parse({ ...p.settings, ...(input.settings ?? {}) });
      await svc.tx(async (u) => {
        for (const c of await listClips(u.db, p.id)) {
          await u.cancelLiveJobs(QUEUES.render, c.id);
          await u.cancelLiveJobs(QUEUES.prepare, c.id);
        }
        await u.cancelLiveJobs(QUEUES.analyze, p.id);
        await u.db.delete(schema.clips).where(eq(schema.clips.projectId, p.id));
        await u.db.update(schema.projects).set({ settings, status: "analyzing", stage: "analyze", error: null, updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
        await u.emit(p.id, "stage.started", { stage: "analyze", status: "analyzing", repick: true });
        await u.enqueue(QUEUES.analyze, { projectId: p.id });
        // files go only once the rows that point at them are gone for good
        u.afterCommit(async () => {
          await fs.rm(`${svc.paths.project(p.id)}/clips`, { recursive: true, force: true });
          await svc.storage.deletePrefix(`${keys.projectPrefix(p.id)}/clips`);
        });
      });
      return { ok: true };
    }),

    delete: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
      const { svc } = ctx;
      const db = svc.database.db;
      const p = await ownedProject(db, ctx.user.id, input.id);
      await svc.tx(async (u) => {
        for (const c of await listClips(u.db, p.id)) {
          await u.cancelLiveJobs(QUEUES.render, c.id);
          await u.cancelLiveJobs(QUEUES.prepare, c.id);
        }
        for (const q of STAGE_QUEUES) await u.cancelLiveJobs(q, p.id);
        await u.db.delete(schema.projects).where(eq(schema.projects.id, p.id));
        u.afterCommit(async () => {
          await fs.rm(svc.paths.project(p.id), { recursive: true, force: true });
          await svc.storage.deletePrefix(keys.projectPrefix(p.id));
        });
      });
      return { ok: true };
    }),

    /** SSE stream of project events; resumes from lastEventId after a reconnect. */
    events: protectedProcedure.input(z.object({ id: z.string(), lastEventId: z.string().nullish() })).subscription(async function* ({ ctx, input, signal }) {
      const { svc } = ctx;
      await ownedProject(svc.database.db, ctx.user.id, input.id);
      let lastId = Number(input.lastEventId ?? 0) || 0;
      const live = svc.events.notices(input.id, signal); // subscribe before catch-up so nothing slips through
      // page through everything after lastId: list() returns at most 500 rows, and a project's
      // history (progress ticks included) is often much longer than that
      const flush = async function* () {
        for (;;) {
          const page = await svc.events.list(input.id, lastId, 500);
          for (const e of page) {
            lastId = e.id;
            yield tracked(String(e.id), e satisfies ProjectEvent);
          }
          if (page.length < 500) return;
        }
      };
      yield* flush();
      for await (const notice of live) {
        if (notice.id > lastId) yield* flush();
      }
    }),
  }),

  transcripts: router({
    /**
     * Accept or reject flagged corrections. Rebuilds the transcript from the as-heard words and,
     * with rerender=true, re-renders every clip whose captions overlap a changed span.
     */
    review: protectedProcedure
      .input(
        z.object({
          projectId: z.string(),
          decisions: z.array(z.object({ id: z.string(), status: z.enum(["accepted", "rejected"]), replacement: z.string().max(80).optional() })),
          rerender: z.boolean().default(true),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        withTranscript(ctx.svc, ctx.user.id, input.projectId, async (u, p, t) => {
        const svc = ctx.svc;
        const db = u.db;
        const raw = t.rawWords ?? t.words;
        const changed: Array<{ start: number; end: number }> = [];
        const flags = t.flags.map((f) => {
          const d = input.decisions.find((x) => x.id === f.id);
          if (!d) return f;
          const replacement = d.replacement?.trim() || undefined;
          const wasApplied = f.status === "auto" || f.status === "accepted";
          const willApply = d.status === "accepted";
          const textChanged = willApply && (replacement ?? f.suggested) !== (f.replacement ?? f.suggested);
          if (d.status === f.status && !textChanged) return f;
          if (wasApplied !== willApply || textChanged) changed.push({ start: f.start, end: f.end });
          return { ...f, status: d.status, replacement };
        });
        // rejecting your own cut deletes it (soft): it moves to deletedFlags and gives back what it replaced
        let live = flags;
        let deletedFlags = t.deletedFlags ?? [];
        for (const f of flags.filter((x) => x.subkind === "manual" && x.status === "rejected")) ({ flags: live, deletedFlags } = softDelete(live, deletedFlags, f.id));
        const words = applyFlags(raw, live);
        const segments = toSentences(words);
        await db
          .update(schema.transcripts)
          .set({ words, rawWords: raw, flags: live, deletedFlags, segments, text: segments.map((s) => s.text).join(" ") })
          .where(eq(schema.transcripts.projectId, p.id));
        const rerendered = input.rerender ? await rerenderOverlapping(svc, u, p, changed) : 0;
        await u.emit(p.id, "stage.started", { stage: "review", changed: changed.length, rerendered });
        return { ok: true, changed: changed.length, rerendered };
        }),
      ),
    /** Mark a span of the transcript to cut from the video (a manual disfluency flag, already accepted). */
    addCut: protectedProcedure
      .input(z.object({ projectId: z.string(), start: z.number().min(0), end: z.number().min(0), rerender: z.boolean().default(true) }))
      .mutation(({ ctx, input }) => addManualFix(ctx.svc, ctx.user.id, input, { kind: "disfluency", text: "" })),
    /** Correct mistranscribed words: captions use `text` for the selected span (a manual entity flag, already accepted). */
    addCorrection: protectedProcedure
      .input(z.object({ projectId: z.string(), start: z.number().min(0), end: z.number().min(0), text: z.string().trim().min(1).max(200), rerender: z.boolean().default(true) }))
      .mutation(({ ctx, input }) => addManualFix(ctx.svc, ctx.user.id, input, { kind: "entity", text: input.text })),
    /** Soft-delete a fix: it moves to deletedFlags (restorable). A manual cut gives back the detector fixes it replaced. */
    deleteFlag: protectedProcedure
      .input(z.object({ projectId: z.string(), flagId: z.string(), rerender: z.boolean().default(true) }))
      .mutation(async ({ ctx, input }) =>
        withTranscript(ctx.svc, ctx.user.id, input.projectId, async (u, p, t) => {
          const f = t.flags.find((x) => x.id === input.flagId);
          if (!f) throw new TRPCError({ code: "NOT_FOUND", message: "Fix not found" });
          const next = softDelete(t.flags, t.deletedFlags ?? [], f.id);
          const rerendered = await saveFlags(ctx.svc, u, p, t, next.flags, next.deletedFlags, f, input.rerender);
          return { ok: true, rerendered };
        }),
      ),
    /** Bring back a soft-deleted fix. A manual cut re-absorbs overlapping cuts; overlapping a name fix is refused. */
    restoreFlag: protectedProcedure
      .input(z.object({ projectId: z.string(), flagId: z.string(), rerender: z.boolean().default(true) }))
      .mutation(async ({ ctx, input }) =>
        withTranscript(ctx.svc, ctx.user.id, input.projectId, async (u, p, t) => {
        const svc = ctx.svc;
        const d = t.deletedFlags?.find((x) => x.id === input.flagId);
        if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "Deleted fix not found" });
        const { deletedAt: _deletedAt, ...flag } = d;
        void _deletedAt;
        const hits = (x: TranscriptFlag) => x.wordIndex <= flag.wordIndex + flag.span - 1 && x.wordIndex + x.span - 1 >= flag.wordIndex;
        const overlapping = t.flags.filter(hits);
        let live = t.flags;
        if (flag.subkind === "manual") {
          if (overlapping.some((x) => x.kind === "entity")) throw new TRPCError({ code: "BAD_REQUEST", message: "A name fix now overlaps this cut. Delete it first." });
          if (overlapping.some((x) => x.subkind === "manual")) throw new TRPCError({ code: "BAD_REQUEST", message: "Another of your cuts now overlaps this one." });
          flag.absorbed = overlapping as unknown as Array<Record<string, unknown>>;
          live = t.flags.filter((x) => !overlapping.includes(x));
        } else if (overlapping.length) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `It overlaps ${overlapping[0]!.subkind === "manual" ? "one of your cuts" : "another fix"} (“${overlapping[0]!.heard}”). Delete that first.` });
        }
        live = [...live, flag].sort((a, b) => a.wordIndex - b.wordIndex);
        const rerendered = await saveFlags(svc, u, p, t, live, (t.deletedFlags ?? []).filter((x) => x.id !== d.id), flag, input.rerender);
        return { ok: true, rerendered };
        }),
      ),
  }),

  clips: router({
    /** Edit title/hook/bounds. Changing bounds invalidates the render; pass rerender=true to queue it. */
    update: protectedProcedure
      .input(
        z.object({
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
          startSec: z.number().min(0).optional(),
          endSec: z.number().min(0).optional(),
          rerender: z.boolean().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const { svc } = ctx;
        const db = svc.database.db;
        const c = await db.query.clips.findFirst({ where: eq(schema.clips.id, input.id) });
        if (!c) throw new TRPCError({ code: "NOT_FOUND" });
        const p = await ownedProject(db, ctx.user.id, c.projectId);
        const startSec = input.startSec ?? c.startSec;
        const endSec = input.endSec ?? c.endSec;
        const boundsChanged = startSec !== c.startSec || endSec !== c.endSec;
        if (boundsChanged) {
          if (endSec - startSec < 3) throw new TRPCError({ code: "BAD_REQUEST", message: "Clip must be at least 3 seconds" });
          if (p.durationSec && endSec > p.durationSec + 0.5) throw new TRPCError({ code: "BAD_REQUEST", message: "Clip ends after the video" });
        }
        const hookChanged = input.hook !== undefined && input.hook !== c.hook;
        const layoutChanged = input.layoutOverride !== undefined && input.layoutOverride !== c.layoutOverride;
        const sectionsChanged = input.layoutSections !== undefined && JSON.stringify(input.layoutSections ?? []) !== JSON.stringify(c.layoutSections ?? []);
        const styleChanged = input.style !== undefined && JSON.stringify(input.style ?? null) !== JSON.stringify(c.style ?? null);
        const emphasisChanged = input.emphasis !== undefined && JSON.stringify(input.emphasis) !== JSON.stringify(c.emphasis ?? []);
        const needsRender = boundsChanged || hookChanged || layoutChanged || sectionsChanged || styleChanged || emphasisChanged; // these are burned into the video
        const updated = await svc.tx(async (u) => {
        // re-read under lock: unchanged fields come from the current row, not a snapshot taken before
        const [cur] = await u.db.select().from(schema.clips).where(eq(schema.clips.id, c.id)).for("update");
        if (!cur) throw new TRPCError({ code: "NOT_FOUND" });
        const [row] = await u.db
          .update(schema.clips)
          .set({
            title: input.title ?? cur.title,
            hook: input.hook ?? cur.hook,
            caption: input.caption ?? cur.caption,
            ...(input.hashtags !== undefined ? { hashtags: input.hashtags.map((h) => h.replace(/^#+/, "")).filter(Boolean) } : {}),
            ...(input.layoutOverride !== undefined ? { layoutOverride: input.layoutOverride } : {}),
            ...(input.layoutSections !== undefined ? { layoutSections: input.layoutSections?.length ? input.layoutSections : null } : {}),
            ...(input.emphasis !== undefined ? { emphasis: input.emphasis.length ? input.emphasis : null } : {}),
            ...(input.style !== undefined ? { style: input.style && Object.keys(input.style).length ? input.style : null } : {}),
            startSec: Number(startSec.toFixed(2)),
            endSec: Number(endSec.toFixed(2)),
            updatedAt: new Date(),
          })
          .where(eq(schema.clips.id, c.id))
          .returning();
        // the edit and its re-render (generation bump, job, project reopened) commit together
        if (needsRender && input.rerender) await requestRender(svc, u, p.id, c.id);
        const [fresh] = await u.db.select().from(schema.clips).where(eq(schema.clips.id, c.id));
        return fresh ?? row!;
        });
        return publicClip(updated);
      }),

    /**
     * New clip from a transcript selection. mode "exact" keeps the bounds; "ai" searches inside them.
     * Metadata (and bounds for "ai") are filled in by the clip.prepare job, then it renders.
     */
    create: protectedProcedure
      .input(z.object({ projectId: z.string(), startSec: z.number().min(0), endSec: z.number().min(0), mode: z.enum(["exact", "ai"]) }))
      .mutation(async ({ ctx, input }) => {
        const { svc } = ctx;
        const db = svc.database.db;
        const p = await ownedProject(db, ctx.user.id, input.projectId);
        const len = input.endSec - input.startSec;
        if (len < (input.mode === "ai" ? 8 : 3)) throw new TRPCError({ code: "BAD_REQUEST", message: input.mode === "ai" ? "Select at least 8 seconds for the AI to search" : "A clip must be at least 3 seconds" });
        if (input.mode === "exact" && len > 600) throw new TRPCError({ code: "BAD_REQUEST", message: "A clip can be at most 10 minutes" });
        if (p.durationSec && input.endSec > p.durationSec + 0.5) throw new TRPCError({ code: "BAD_REQUEST", message: "Selection ends after the video" });
        const transcript = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, p.id), columns: { projectId: true } });
        if (!transcript || !p.sourceKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The video must be downloaded and transcribed first" });
        const existing = await db.query.clips.findMany({ where: eq(schema.clips.projectId, p.id), columns: { index: true } });
        const index = existing.reduce((m, c) => Math.max(m, c.index + 1), 0);
        const row = await svc.tx(async (u) => {
        const [inserted] = await u.db
          .insert(schema.clips)
          .values({
            id: randomUUID(),
            projectId: p.id,
            index,
            title: input.mode === "ai" ? "Finding the best moment…" : "New clip",
            hook: "",
            startSec: Number(input.startSec.toFixed(2)),
            endSec: Number(input.endSec.toFixed(2)),
            score: 0,
            reasoning: "",
            hashtags: [],
            status: "preparing",
            origin: input.mode === "ai" ? "manual-ai" : "manual",
          })
          .returning();
        await reopenProject(u, p.id);
        await u.emit(p.id, "clip.created", { clipId: inserted!.id, index, title: inserted!.title });
        await u.enqueue(QUEUES.prepare, { projectId: p.id, clipId: inserted!.id, mode: input.mode });
        return inserted!;
        });
        return publicClip(row);
      }),

    rerender: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
      const { svc } = ctx;
      const db = svc.database.db;
      const c = await db.query.clips.findFirst({ where: eq(schema.clips.id, input.id) });
      if (!c) throw new TRPCError({ code: "NOT_FOUND" });
      const p = await ownedProject(db, ctx.user.id, c.projectId);
      return svc.tx(async (u) => {
        if (needsPrepare(c)) {
          // never prepared (e.g. the model was down): redo preparation, which renders afterwards
          await u.cancelLiveJobs(QUEUES.render, c.id);
          await u.cancelLiveJobs(QUEUES.prepare, c.id);
          await u.db.update(schema.clips).set({ status: "preparing", error: null, updatedAt: new Date() }).where(eq(schema.clips.id, c.id));
          await u.enqueue(QUEUES.prepare, { projectId: p.id, clipId: c.id, mode: prepareModeOf(c) });
          await reopenProject(u, p.id);
          return { ok: true, step: "prepare" as const };
        }
        await requestRender(svc, u, p.id, c.id);
        return { ok: true, step: "render" as const };
      });
    }),
  }),
});

export type AppRouter = typeof appRouter;
