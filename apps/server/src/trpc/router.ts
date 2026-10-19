import { z } from "zod";
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { TRPCError, tracked } from "@trpc/server";
import { router, protectedProcedure, publicProcedure, signedInProcedure, adminProcedure } from "./context.js";
import { approveUser, banUser, removeUser, setUserLimits, setUserRole, unbanUser } from "../accounts.js";
import { deleteClip, deleteOwnedProject, deletedClips, reanalyzeProject, restoreClip, restoreProject, updateProject, type Actor } from "../projects/service.js";
import { USER_ROLES } from "../db/schema.js";
import { schema, type Db } from "../db/index.js";
import { CLEARABLE_SETTINGS, createProjectInputSchema, projectSettingsSchema, projectSettingsPatchSchema, defaultProjectSettings, userProjectDefaultsSchema, clipBumpersSchema, bumperSecondsSchema, reframeModeSchema, styleOverrideSchema, layoutSectionSchema, styleSchema, type EventsReplayed, type ProjectEvent, type TranscriptFlag, type Word } from "@reelsaw/shared";
import { splitDeleted, archiveDeletedFlags, takeArchivedFlag, changedColumns } from "../transcript-limits.js";
import { QUEUES, type QueueName } from "../queue/boss.js";
import type { Services } from "../services.js";
import type { UnitOfWork } from "../uow.js";
import { lockProjectClips, requestPrepare, requestRender, requestRenders, RenderManyMissing, startRun } from "../pipeline/lifecycle.js";
import { listClips } from "../pipeline/analyze.js";
import { keys } from "../storage/index.js";
import { bumperKind, bumperProblem, ensureBumperThumb, sha256File, BUMPER_IMAGE_SEC } from "../pipeline/bumpers.js";
import { projectBumperSummaries, bumperUsageCounts, bumperNameSchema, updateBumperAsset } from "../bumpers/service.js";
import { applyFlags } from "../pipeline/entities.js";
import { enqueueRefine, REFINE_QUEUE } from "../pipeline/refine.js";
import { REFINE_STEPS, PROJECT_STATUSES } from "@reelsaw/shared";
import { toSentences } from "../pipeline/transcript.js";
import { isProgressNotice, progressEvent } from "../events.js";
import { SEARCH_USERS, setSearchThreshold, userMatch, userScore, words } from "../search.js";
import { failedCounts, recentProjects, searchLibrary, SEARCH_CLIPS } from "../search.js";
import { needsPrepare } from "../pipeline/manual.js";
import { resolveProjectSettings, userDefaults } from "../pipeline/settings.js";
import { listProjectsPage, projectStats, activeProjects } from "../projects-list.js";
import { decodeCursor, pageOf } from "../pagination.js";
import { checkProjectQuota, limitsFor, LIMIT_KEYS, limitUsage, usageByUser } from "../quota.js";
import { defaultFactors, estimateStages, loadHistory, processingTimes, type Models } from "../pipeline/estimates.js";
import { MODEL_KINDS } from "../ai/models.js";
import { settingsPatchSchema, SettingsError } from "../instance-settings.js";
import { logControl } from "../log.js";
import { knownModules, PICKABLE_LEVELS, specFromStructured } from "../log-level.js";
import { providerOf } from "../ai/registry.js";
import { generateText } from "ai";

/** The models a new stage would run with, for expected-time lookups. */
const currentModels = (svc: Services): Models => ({ language: svc.models.get().language, transcription: svc.models.get().transcription });
/** Base URLs in force (environment or entered by an admin), for local-vs-cloud decisions. */
const localConfig = (svc: Services) => ({ OPENAI_BASE_URL: svc.providers.get("openai").baseUrl, OPENAI_COMPATIBLE_BASE_URL: svc.providers.get(svc.config.OPENAI_COMPATIBLE_NAME).baseUrl, OPENAI_COMPATIBLE_NAME: svc.config.OPENAI_COMPATIBLE_NAME });

const modelId = z.string().trim().min(3).max(200).regex(/^[a-z0-9_-]+:[^\s]+$/i, "a model id looks like provider:model, e.g. anthropic:claude-haiku-4.5");

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
    bumpers: c.bumpers ?? null,
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
    sourceVideoUrl: p.sourceKey && !p.sourceExpiredAt ? `/media/source/${p.id}` : null,
    /** retention removed the stored source; Retry downloads it again */
    sourceExpiredAt: p.sourceExpiredAt?.toISOString() ?? null,
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
 * overwritten), then the change, its re-renders and its event commit together. The row is still read
 * whole (words are one jsonb value); writes go through writeTranscript, which sends only changed columns.
 * Chunked transcript storage, so an edit touches only the window it changes, is Phase 2 (docs/specs/scale.md).
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
    deletedFlags: [...deleted.filter((x) => x.id !== id), { ...f, status: f.subkind === "manual" ? "accepted" : f.status, deletedAt: new Date().toISOString() }], // the live list is capped (and the overflow archived) when saved, see saveFlags
  };
}

/**
 * Write back only the transcript columns that changed (rawWords and often words stay as they are), after
 * moving deleted flags beyond the live cap into the archive in the same transaction.
 */
async function writeTranscript(u: UnitOfWork, projectId: string, t: schema.Transcript, next: { words: Word[]; rawWords: Word[]; flags: TranscriptFlag[]; deletedFlags: DeletedFlag[]; segments: ReturnType<typeof toSentences>; text: string }) {
  const { keep, overflow } = splitDeleted(next.deletedFlags);
  await archiveDeletedFlags(u.db, projectId, overflow);
  const patch = changedColumns<Record<string, unknown>>({ words: t.words, rawWords: t.rawWords ?? undefined, flags: t.flags, deletedFlags: t.deletedFlags ?? [], segments: t.segments, text: t.text }, { ...next, deletedFlags: keep });
  if (Object.keys(patch).length) await u.db.update(schema.transcripts).set(patch).where(eq(schema.transcripts.projectId, projectId));
}

/** Persist new flag lists, rebuild the cleaned words, re-render clips whose words changed around `f`. */
async function saveFlags(svc: Services, u: UnitOfWork, p: schema.Project, t: schema.Transcript, flags: TranscriptFlag[], deletedFlags: DeletedFlag[], f: TranscriptFlag, rerender: boolean) {
  const db = u.db;
  const raw = t.rawWords ?? t.words;
  const words = applyFlags(raw, flags);
  const segments = toSentences(words);
  await writeTranscript(u, p.id, t, { words, rawWords: raw, flags, deletedFlags, segments, text: segments.map((x) => x.text).join(" ") });
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
  await lockProjectClips(u, p.id);
  for (const c of await listClips(u.db, p.id)) {
    if (!ranges.some((r) => r.end > c.startSec && r.start < c.endSec)) continue;
    if ((await requestRender(svc, u, p.id, c.id)) !== null) n++;
  }
  return n;
}

/** Re-render the clips matching `which` (default: finished or failed ones) in this unit of work. */
/** Set (or clear) the user's default intro/outro: one atomic JSON merge, ownership and liveness checked in the same unit of work. */
async function setBumperDefault(db: Db, userId: string, slot: "intro" | "outro", assetId: string | null) {
  const key = slot === "intro" ? "introAssetId" : "outroAssetId";
  if (!assetId) {
    await db.execute(sql`update user_settings set project_defaults = project_defaults - ${key}::text, updated_at = now() where user_id = ${userId}`);
    return;
  }
  const [asset] = await db.select({ id: schema.bumperAssets.id }).from(schema.bumperAssets).where(and(eq(schema.bumperAssets.id, assetId), eq(schema.bumperAssets.userId, userId), isNull(schema.bumperAssets.deletedAt)));
  if (!asset) throw new TRPCError({ code: "NOT_FOUND", message: "Intro or outro not found" });
  const patch = { [key]: assetId };
  await db
    .insert(schema.userSettings)
    .values({ userId, projectDefaults: patch })
    .onConflictDoUpdate({ target: schema.userSettings.userId, set: { projectDefaults: sql`${schema.userSettings.projectDefaults} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() } });
}

async function rerenderClips(svc: Services, u: UnitOfWork, projectId: string, which: (c: schema.Clip) => boolean = (c) => c.status === "done" || c.status === "failed") {
  let n = 0;
  await lockProjectClips(u, projectId);
  for (const c of await listClips(u.db, projectId)) if (which(c) && (await requestRender(svc, u, projectId, c.id)) !== null) n++;
  return n;
}

/** Every asset id is one of the user's library (an id the clip already uses stays valid even if it was removed since). */
async function assertOwnedBumpers(db: Db, userId: string, ids: Array<string | null | undefined>, alreadyUsed: Array<string | null | undefined> = []) {
  const want = [...new Set(ids.filter((x): x is string => !!x && !alreadyUsed.includes(x)))];
  if (!want.length) return;
  const rows = await db.select({ id: schema.bumperAssets.id }).from(schema.bumperAssets).where(and(inArray(schema.bumperAssets.id, want), eq(schema.bumperAssets.userId, userId), isNull(schema.bumperAssets.deletedAt)));
  if (rows.length !== want.length) throw new TRPCError({ code: "NOT_FOUND", message: "That intro or outro is not in your library" });
}

/**
 * The user's project, or NOT_FOUND. A mutation calls it with `u.db` inside the unit of work that writes, so ownership
 * is checked in the same transaction as the write (a check made before the transaction can be stale at commit).
 */
async function ownedProject(db: Db, userId: string, projectId: string) {
  // a deleted project is gone for every procedure until it is restored (projects.restore)
  const p = await db.query.projects.findFirst({ where: and(eq(schema.projects.id, projectId), eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt)) });
  if (!p) throw new TRPCError({ code: "NOT_FOUND" });
  return p;
}

/**
 * A clip of one of the user's projects, locked `for update` in the caller's unit of work, with its project (read, not
 * locked: clip before project). NOT_FOUND when the clip is gone, replaced (soft-deleted: it is restored before it is
 * edited), or belongs to someone else (ownedProject also refuses a deleted project).
 */
async function ownedClip(u: UnitOfWork, userId: string, clipId: string): Promise<{ clip: schema.Clip; project: schema.Project }> {
  const [clip] = await u.db
    .select()
    .from(schema.clips)
    .where(and(eq(schema.clips.id, clipId), isNull(schema.clips.deletedAt), sql`exists (select 1 from ${schema.projects} where ${schema.projects.id} = ${schema.clips.projectId} and ${schema.projects.userId} = ${userId})`))
    .for("update");
  if (!clip) throw new TRPCError({ code: "NOT_FOUND" });
  return { clip, project: await ownedProject(u.db, userId, clip.projectId) };
}

const actorOf = (user: { id: string; role?: string | null }): Actor => ({ id: user.id, admin: user.role === "admin" });

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

  /** Public: what the sign-in page and the top bar need before/without an approved account. */
  system: router({
    status: publicProcedure.query(async ({ ctx }) => {
      const r = await ctx.svc.resources.snapshot();
      const paused = !r.ok.memory ? "memory" : !r.ok.cpu ? "CPU" : !r.ok.disk ? "disk" : null;
      const s = ctx.svc.settings.get();
      return {
        version: ctx.svc.config.REELSAW_VERSION,
        signupMode: s.SIGNUP_MODE,
        emailEnabled: ctx.svc.email.enabled,
        termsUrl: s.TERMS_URL ?? null,
        privacyUrl: s.PRIVACY_URL ?? null,
        maxUploadMb: s.MAX_UPLOAD_MB,
        captcha: s.CAPTCHA_PROVIDER && s.CAPTCHA_SITE_KEY && s.CAPTCHA_SECRET_KEY ? { provider: s.CAPTCHA_PROVIDER, siteKey: s.CAPTCHA_SITE_KEY } : null,
        /** heavy jobs wait for the machine; the word says what is short, never the numbers */
        paused,
      };
    }),
  }),

  /** The signed-in account, also while waiting for approval or suspended. */
  me: router({
    get: signedInProcedure.query(async ({ ctx }) => ({
      id: ctx.user.id,
      name: ctx.user.name,
      email: ctx.user.email,
      role: ctx.user.role,
      approved: !!ctx.user.approvedAt,
      blocked: ctx.who.blocked,
      via: ctx.who.via,
      projectDefaults: ctx.who.blocked ? {} : await userDefaults(ctx.svc.database.db, ctx.user.id),
      builtInDefaults: defaultProjectSettings,
    })),
    /** Replace the saved project defaults (the form sends the whole set; {} clears them). */
    updateProjectDefaults: protectedProcedure.input(userProjectDefaultsSchema).mutation(async ({ ctx, input }) => {
      const { introAssetId: _i, outroAssetId: _o,...rest } = input; // intro/outro change only through `bumpers.*`
      const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== ""));
      return ctx.svc.tx(async (u) => {
        const [cur] = await u.db.select({ d: schema.userSettings.projectDefaults }).from(schema.userSettings).where(eq(schema.userSettings.userId, ctx.user.id)).for("update");
        const keep = Object.fromEntries((["introAssetId", "outroAssetId"] as const).filter((k) => cur?.d?.[k]).map((k) => [k, cur!.d[k]]));
        const next = { ...clean, ...keep };
        await u.db
          .insert(schema.userSettings)
          .values({ userId: ctx.user.id, projectDefaults: next })
          .onConflictDoUpdate({ target: schema.userSettings.userId, set: { projectDefaults: next, updatedAt: new Date() } });
        return { ok: true, projectDefaults: next };
      });
    }),
  }),

  /** The user's library of intro/outro videos and images (docs/specs/bumpers.md). Files arrive through POST /api/upload first. */
  bumpers: router({
    /** Live assets with how many projects use each, and the ones removed in the last 30 days (restorable). */
    list: protectedProcedure.query(async ({ ctx }) => {
      const db = ctx.svc.database.db;
      const rows = await db.select().from(schema.bumperAssets).where(eq(schema.bumperAssets.userId, ctx.user.id)).orderBy(desc(schema.bumperAssets.createdAt));
      const usage = await bumperUsageCounts(db, ctx.user.id);
      const pub = (r: (typeof rows)[number]) => ({ id: r.id, kind: r.kind, name: r.name, durationSec: r.durationSec, width: r.width, height: r.height, hasAudio: r.hasAudio, sizeBytes: r.sizeBytes, createdAt: r.createdAt.toISOString(), thumbnailUrl: `/media/bumpers/${r.id}/thumb.jpg`, usedBy: usage.get(r.id)?.projects ?? 0, usedByClips: usage.get(r.id)?.clips ?? 0 });
      // old rows have no content_hash (no backfill; see docs/specs/bumpers.md), so only new uploads are checked for duplicates
      const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
      return {
        assets: rows.filter((r) => !r.deletedAt).map(pub),
        deleted: rows.filter((r) => r.deletedAt && r.deletedAt.getTime() > cutoff).map(pub),
      };
    }),
    /**
     * Every project and clip that uses an asset, and why: the project's default or override, or the clip's own
     * choice. Two queries (projects whose settings name it, clips that name it or sit in such a project).
     */
    usage: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
      const db = ctx.svc.database.db;
      const [asset] = await db.select({ id: schema.bumperAssets.id }).from(schema.bumperAssets).where(and(eq(schema.bumperAssets.id, input.id), eq(schema.bumperAssets.userId, ctx.user.id)));
      if (!asset) throw new TRPCError({ code: "NOT_FOUND", message: "That item is not in your library" });
      const slots = ["intro", "outro"] as const;
      const key = { intro: "introAssetId", outro: "outroAssetId" } as const;
      const projectRows = await db
        .select({ id: schema.projects.id, title: schema.projects.title, settings: schema.projects.settings })
        .from(schema.projects)
        .where(and(eq(schema.projects.userId, ctx.user.id), or(sql`${schema.projects.settings} ->> 'introAssetId' = ${input.id}`, sql`${schema.projects.settings} ->> 'outroAssetId' = ${input.id}`)))
        .limit(500);
      const clipRows = await db
        .select({ id: schema.clips.id, index: schema.clips.index, title: schema.clips.title, bumpers: schema.clips.bumpers, projectId: schema.projects.id, projectTitle: schema.projects.title, settings: schema.projects.settings })
        .from(schema.clips)
        .innerJoin(schema.projects, eq(schema.clips.projectId, schema.projects.id))
        .where(
          and(
            eq(schema.projects.userId, ctx.user.id),
            or(
              sql`${schema.clips.bumpers} ->> 'intro' = ${input.id}`,
              sql`${schema.clips.bumpers} ->> 'outro' = ${input.id}`,
              sql`${schema.projects.settings} ->> 'introAssetId' = ${input.id}`,
              sql`${schema.projects.settings} ->> 'outroAssetId' = ${input.id}`,
            ),
          ),
        )
        .orderBy(schema.clips.index)
        .limit(2000);
      type Clip = { id: string; index: number; title: string; slots: Array<"intro" | "outro">; via: "clip" | "project" };
      const out = new Map<string, { id: string; title: string; slots: Array<"intro" | "outro">; via: "project"; clips: Clip[] }>();
      for (const p of projectRows) out.set(p.id, { id: p.id, title: p.title, via: "project", slots: slots.filter((s) => p.settings[key[s]] === input.id), clips: [] });
      for (const c of clipRows) {
        const own = c.bumpers ?? {};
        const mine = slots.filter((s) => own[s] === input.id);
        // a slot the clip leaves alone follows the project
        const inherited = slots.filter((s) => own[s] === undefined && c.settings[key[s]] === input.id);
        if (!mine.length && !inherited.length) continue;
        const p = out.get(c.projectId) ?? { id: c.projectId, title: c.projectTitle, via: "project" as const, slots: slots.filter((s) => c.settings[key[s]] === input.id), clips: [] };
        out.set(p.id, p);
        p.clips.push({ id: c.id, index: c.index, title: c.title, slots: slots.filter((s) => mine.includes(s) || inherited.includes(s)), via: mine.length ? "clip" : "project" });
      }
      // a project whose settings name the asset only counts when a clip really resolves to it (or it has no clips yet)
      const bare = [...out.values()].filter((p) => !p.clips.length).map((p) => p.id);
      if (bare.length) {
        const withClips = new Set((await db.selectDistinct({ id: schema.clips.projectId }).from(schema.clips).where(inArray(schema.clips.projectId, bare))).map((r) => r.id));
        for (const id of bare) if (withClips.has(id)) out.delete(id);
      }
      return { projects: [...out.values()] };
    }),
    /** Rename a library item and/or change how long an image lasts (updateBumperAsset; also the rename_bumper tool). */
    update: protectedProcedure
      .input(z.object({ id: z.string().min(1).max(100), name: bumperNameSchema.optional(), imageSeconds: bumperSecondsSchema.optional() }))
      .mutation(({ ctx, input }) => updateBumperAsset(ctx.svc, ctx.user.id, input.id, { name: input.name, imageSeconds: input.imageSeconds })),
    /** Validate an uploaded video or image with ffprobe and add it to the library; `setDefault` also makes it the user's intro or outro. */
    create: protectedProcedure
      .input(z.object({ uploadId: z.string().min(1).max(100), imageSeconds: z.number().min(BUMPER_IMAGE_SEC.min).max(BUMPER_IMAGE_SEC.max).optional(), setDefault: z.enum(["intro", "outro"]).optional() }))
      .mutation(async ({ ctx, input }) => {
        const { svc } = ctx;
        const up = await svc.database.db.query.uploads.findFirst({ where: and(eq(schema.uploads.id, input.uploadId), eq(schema.uploads.userId, ctx.user.id)) });
        if (!up) throw new TRPCError({ code: "NOT_FOUND", message: "Upload not found" });
        const ext = path.extname(up.filename).toLowerCase();
        const kind = bumperKind(ext) ?? "video";
        const id = randomUUID();
        const local = path.join(svc.paths.tmp, `bumper-${id}${ext}`);
        try {
          // cheap checks first so a huge file is not pulled out of storage just to be refused
          const early = bumperProblem(input.setDefault, { ext, sizeBytes: up.sizeBytes }, { durationSec: 1, width: 1000, height: 1000 });
          if (early) throw new TRPCError({ code: "BAD_REQUEST", message: early });
          await fs.mkdir(svc.paths.tmp, { recursive: true });
          await svc.storage.ensureLocal(up.storageKey, local);
          const probe = await svc.media.ffprobe(local).catch(() => null);
          if (!probe) throw new TRPCError({ code: "BAD_REQUEST", message: `This file could not be read as ${kind === "image" ? "an image" : "a video"}.` });
          const problem = bumperProblem(input.setDefault, { ext, sizeBytes: up.sizeBytes }, probe);
          if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem });
          const sourceKey = keys.bumper(id, ext);
          const contentHash = await sha256File(local);
          const row = await svc.tx(async (u) => {
            // one upload of a given file at a time per user, so two racing copies cannot both insert
            await u.db.execute(sql`select pg_advisory_xact_lock(hashtext(${`bumper:${ctx.user.id}:${contentHash}`}))`);
            const [same] = await u.db.select().from(schema.bumperAssets).where(and(eq(schema.bumperAssets.userId, ctx.user.id), eq(schema.bumperAssets.contentHash, contentHash))).orderBy(sql`(${schema.bumperAssets.deletedAt} is not null)`).limit(1);
            if (same) {
              const wasRemoved = !!same.deletedAt;
              if (wasRemoved) await u.db.update(schema.bumperAssets).set({ deletedAt: null }).where(eq(schema.bumperAssets.id, same.id));
              if (input.setDefault) await setBumperDefault(u.db, ctx.user.id, input.setDefault, same.id);
              return { asset: same, duplicate: true as const, restored: wasRemoved };
            }
            // ownership is re-checked in the unit of work that writes
            const [still] = await u.db.select({ id: schema.uploads.id }).from(schema.uploads).where(and(eq(schema.uploads.id, up.id), eq(schema.uploads.userId, ctx.user.id)));
            if (!still) throw new TRPCError({ code: "NOT_FOUND", message: "Upload not found" });
            const [asset] = await u.db
              .insert(schema.bumperAssets)
              .values({
                id,
                userId: ctx.user.id,
                kind,
                name: up.filename.replace(/\.[^.]+$/, "").slice(0, 120) || "Untitled",
                durationSec: kind === "image" ? (input.imageSeconds ?? BUMPER_IMAGE_SEC.default) : probe.durationSec,
                width: probe.width!,
                height: probe.height!,
                hasAudio: kind === "video" && probe.hasAudio,
                sourceKey,
                sizeBytes: up.sizeBytes,
                contentHash,
              })
              .returning();
            if (input.setDefault) await setBumperDefault(u.db, ctx.user.id, input.setDefault, id);
            // the file is copied only once the row exists; a render that beats the copy skips the bumper (never fails)
            u.afterCommit(async () => {
              try {
                await svc.storage.putFile(sourceKey, local);
                // the picker thumbnail; if this fails the media route makes it on first request
                const thumbKey = await ensureBumperThumb({ ffmpeg: (a) => svc.media.ffmpeg(a), storage: svc.storage, dir: svc.paths.tmp }, { id, kind, durationSec: probe.durationSec, sourceKey }, local).catch(() => null);
                if (thumbKey) await svc.database.db.update(schema.bumperAssets).set({ thumbnailKey: thumbKey }).where(eq(schema.bumperAssets.id, id)).catch(() => {});
              } finally {
                await fs.rm(local, { force: true }).catch(() => {});
              }
            });
            return { asset: asset!, duplicate: false as const, restored: false };
          });
          if (row.duplicate) await fs.rm(local, { force: true }).catch(() => {}); // nothing was stored, so no afterCommit cleans it
          return { id: row.asset.id, name: row.asset.name, kind: row.asset.kind, durationSec: row.asset.durationSec, duplicate: row.duplicate, restored: row.restored };
        } catch (err) {
          await fs.rm(local, { force: true }).catch(() => {});
          throw err;
        }
      }),
    /** Make a library asset the user's default intro or outro for new projects (assetId null clears it). */
    setDefault: protectedProcedure.input(z.object({ slot: z.enum(["intro", "outro"]), assetId: z.string().min(1).max(100).nullable() })).mutation(async ({ ctx, input }) => {
      return ctx.svc.tx(async (u) => {
        await setBumperDefault(u.db, ctx.user.id, input.slot, input.assetId);
        return { ok: true };
      });
    }),
    /** Soft delete: hidden from the library and cleared from the defaults; projects that use it keep rendering with it. */
    delete: protectedProcedure.input(z.object({ id: z.string().min(1).max(100) })).mutation(async ({ ctx, input }) => {
      return ctx.svc.tx(async (u) => {
        const gone = await u.db
          .update(schema.bumperAssets)
          .set({ deletedAt: new Date() })
          .where(and(eq(schema.bumperAssets.id, input.id), eq(schema.bumperAssets.userId, ctx.user.id), isNull(schema.bumperAssets.deletedAt)))
          .returning({ id: schema.bumperAssets.id });
        if (!gone.length) throw new TRPCError({ code: "NOT_FOUND", message: "Intro or outro not found" });
        for (const key of ["introAssetId", "outroAssetId"]) {
          await u.db.execute(sql`update user_settings set project_defaults = project_defaults - ${key}::text, updated_at = now() where user_id = ${ctx.user.id} and project_defaults ->> ${key}::text = ${input.id}`);
        }
        return { ok: true };
      });
    }),
    restore: protectedProcedure.input(z.object({ id: z.string().min(1).max(100) })).mutation(async ({ ctx, input }) => {
      const r = await ctx.svc.database.db
        .update(schema.bumperAssets)
        .set({ deletedAt: null })
        .where(and(eq(schema.bumperAssets.id, input.id), eq(schema.bumperAssets.userId, ctx.user.id)))
        .returning({ id: schema.bumperAssets.id });
      if (!r.length) throw new TRPCError({ code: "NOT_FOUND", message: "Intro or outro not found" });
      return { ok: true };
    }),
  }),

  admin: router({
    /** Machine-level configuration and live resources. Read from the environment; admins only. */
    system: adminProcedure.query(async ({ ctx }) => ({
      version: { version: ctx.svc.config.REELSAW_VERSION, commit: ctx.svc.config.REELSAW_COMMIT, builtAt: ctx.svc.config.REELSAW_BUILT_AT },
      aiModel: ctx.svc.models.get().language,
      transcriptionModel: ctx.svc.models.get().transcription,
      openaiBaseUrl: ctx.svc.providers.get("openai").baseUrl ?? null,
      compatBaseUrl: ctx.svc.providers.get(ctx.svc.config.OPENAI_COMPATIBLE_NAME).baseUrl ?? null,
      storage: ctx.svc.storage.driver,
      faceDetection: !!ctx.svc.faces,
      signupMode: ctx.svc.settings.get().SIGNUP_MODE,
      email: ctx.svc.config.EMAIL_DRIVER,
      healthDetails: ctx.svc.settings.get().HEALTH_DETAILS,
      mcpUrl: new URL("/api/mcp", ctx.svc.config.APP_URL).toString(),
      maxUploadMb: ctx.svc.settings.get().MAX_UPLOAD_MB,
      renderConcurrency: { ...ctx.svc.resources.renders(), max: ctx.svc.resources.maxRenders() },
      /** the GPU this process sees, the ffmpeg encoder renders use and where each on-device model runs (ONNX_EXECUTION_PROVIDER; the VAD is always cpu) */
      gpu: ctx.svc.resources.gpu(),
      videoEncoder: ctx.svc.media.encoder(),
      onDevice: { requested: ctx.svc.config.ONNX_EXECUTION_PROVIDER, faces: ctx.svc.faces?.provider ?? null, text: ctx.svc.text?.provider ?? null, vad: ctx.svc.vad ? ("cpu" as const) : null, aligner: ctx.svc.aligner?.provider ?? null },
      otel: ctx.svc.otel.enabled,
      defaults: defaultProjectSettings,
      resources: await ctx.svc.resources.snapshot(),
      limits: { maxCpuPercent: ctx.svc.config.MAX_CPU_PERCENT, minFreeMemMB: ctx.svc.config.MIN_FREE_MEM_MB, minFreeDiskMB: ctx.svc.config.MIN_FREE_DISK_MB },
    })),
    /**
     * Is a newer Reelsaw published? (updates.ts). `get` is what is known (and starts the first check
     * when none ran yet; the state then says `checking`); `check` asks GitHub again now.
     */
    updates: router({
      get: adminProcedure.query(({ ctx }) => {
        const s = ctx.svc.updates.state();
        if (s.enabled && !s.checkedAt && !s.checking) void ctx.svc.updates.check();
        return ctx.svc.updates.state();
      }),
      check: adminProcedure.mutation(({ ctx }) => ctx.svc.updates.check({ force: true })),
    }),
    /**
     * Instance settings (instance-settings.ts): sign-up policy, captcha, quotas, retention, … The environment is
     * the default; what is set here overrides it for every process within seconds. `set` validates the result as a
     * whole and writes a `settings.changed` admin event. The same code serves the CLI and the MCP tools.
     */
    settings: router({
      get: adminProcedure.query(({ ctx }) => ctx.svc.settings.state()),
      set: adminProcedure.input(settingsPatchSchema).mutation(async ({ ctx, input }) => {
        try {
          return await ctx.svc.settings.set(input, { id: ctx.user.id, email: ctx.user.email });
        } catch (err) {
          if (err instanceof SettingsError) throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
          throw err;
        }
      }),
    }),
    users: router({
      /**
       * Keyset page of accounts: pending first, then newest first (`approved, created_at desc, id desc`), with each
       * account's all-time usage from one grouped query per metric table (see `usageByUser`).
       */
      list: adminProcedure
        .input(z.object({ q: z.string().max(200).optional(), cursor: z.string().max(300).optional(), limit: z.number().int().min(1).max(100).default(50) }).optional())
        .query(async ({ ctx, input }) => {
          const db = ctx.svc.database.db;
          const limit = input?.limit ?? 50;
          const ws = words(input?.q ?? "");
          const U = schema.user;
          // A search matches like the palette's (typo-tolerant, every word, best first) and returns the best
          // SEARCH_USERS matches in one page: no cursor, the header says when more match. Without a search the
          // list is the keyset-paged one: pending first, then newest.
          const match = userMatch(ws);
          const score = userScore(ws);
          const approved = sql<number>`(case when ${U.approvedAt} is null then 0 else 1 end)`;
          let after: SQL | undefined;
          if (!ws.length && input?.cursor) {
            const c = decodeCursor(input.cursor, 3);
            if (!c) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
            after = sql`(${approved} > ${Number(c[0])} or (${approved} = ${Number(c[0])} and (${U.createdAt}, ${U.id}) < (${String(c[1])}::timestamp, ${String(c[2])})))`;
          }
          const pageSize = ws.length ? SEARCH_USERS : limit;
          const [fetched, [{ total }]] = await db.transaction(async (tx) => {
            await setSearchThreshold(tx);
            return Promise.all([
              tx
                .select({
                  id: U.id,
                  name: U.name,
                  email: U.email,
                  role: U.role,
                  approvedAt: U.approvedAt,
                  banned: U.banned,
                  banReason: U.banReason,
                  createdAt: U.createdAt,
                  approved,
                  ts: sql<string>`${U.createdAt}::text`,
                })
                .from(U)
                .where(and(match, after))
                .orderBy(...(score ? [desc(score)] : []), approved, desc(U.createdAt), desc(U.id))
                .limit(pageSize + 1),
              tx.select({ total: sql<number>`count(*)::int` }).from(U).where(match),
            ]);
          });
          const { items, nextCursor } = ws.length ? { items: fetched.slice(0, pageSize), nextCursor: null } : pageOf(fetched, limit, (r) => [r.approved, r.ts, r.id]);
          const ids = items.map((r) => r.id);
          const [usage, sessions] = await Promise.all([
            usageByUser(db, null, ids),
            ids.length ? db.select({ userId: schema.session.userId, last: sql<Date>`max(${schema.session.updatedAt})` }).from(schema.session).where(inArray(schema.session.userId, ids)).groupBy(schema.session.userId) : [],
          ]);
          const usageOf = new Map(usage.map((u) => [u.id, u]));
          const lastOf = new Map(sessions.map((s) => [s.userId, s.last]));
          return {
            items: items.map(({ approved: _a, ts: _t, ...r }) => {
              const last = lastOf.get(r.id);
              const { id: _id, projectsTotal, ...u } = usageOf.get(r.id)!;
              return {
                ...r,
                projects: projectsTotal,
                usage: u,
                status: r.banned ? ("suspended" as const) : r.approvedAt ? ("active" as const) : ("pending" as const),
                approvedAt: r.approvedAt?.toISOString() ?? null,
                createdAt: r.createdAt.toISOString(),
                lastActive: last ? new Date(last).toISOString() : null,
              };
            }),
            nextCursor,
            total,
          };
        }),
      pendingCount: adminProcedure.query(async ({ ctx }) => {
        const [{ n }] = await ctx.svc.database.db.select({ n: sql<number>`count(*)::int` }).from(schema.user).where(sql`${schema.user.approvedAt} is null and not ${schema.user.banned}`);
        return n;
      }),
      approve: adminProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => approveUser(ctx.svc, ctx.user.id, input.id)),
      setRole: adminProcedure.input(z.object({ id: z.string(), role: z.enum(USER_ROLES) })).mutation(({ ctx, input }) => setUserRole(ctx.svc, ctx.user.id, input.id, input.role)),
      ban: adminProcedure.input(z.object({ id: z.string(), reason: z.string().max(300).optional() })).mutation(({ ctx, input }) => banUser(ctx.svc, ctx.user.id, input.id, input.reason?.trim() || null)),
      unban: adminProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => unbanUser(ctx.svc, ctx.user.id, input.id)),
      remove: adminProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => removeUser(ctx.svc, ctx.user.id, input.id)),
      /** Per-user quota overrides; null = back to the instance setting. */
      limits: adminProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
        const row = await ctx.svc.database.db.query.userSettings.findFirst({ where: eq(schema.userSettings.userId, input.id), columns: { limits: true } });
        return { instance: Object.fromEntries(LIMIT_KEYS.map((k) => [k, ctx.svc.settings.get()[k]])), overrides: row?.limits ?? {}, effective: await limitsFor(ctx.svc.database.db, ctx.svc.settings.get(), input.id), usage: await limitUsage(ctx.svc.database.db, input.id) };
      }),
      setLimits: adminProcedure
        .input(z.object({ id: z.string(), limits: z.partialRecord(z.enum(LIMIT_KEYS), z.number().int().min(0).nullable()) }))
        .mutation(({ ctx, input }) => setUserLimits(ctx.svc, ctx.user.id, input.id, input.limits)),
    }),
    /** Usage per user over the last `days`: projects, minutes of source, clips rendered, model calls and tokens, stored bytes. */
    usage: adminProcedure.input(z.object({ days: z.number().int().min(1).max(365).default(30) }).optional()).query(async ({ ctx, input }) => {
      const days = input?.days ?? 30;
      return { days, users: await usageByUser(ctx.svc.database.db, days) };
    }),
    events: adminProcedure.input(z.object({ limit: z.number().int().min(1).max(500).default(100) }).optional()).query(async ({ ctx, input }) => {
      const rows = await ctx.svc.database.db.query.adminEvents.findMany({ orderBy: desc(schema.adminEvents.id), limit: input?.limit ?? 100 });
      return rows.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() }));
    }),
    /**
     * Provider keys and base URLs, entered by an admin and stored encrypted (ai/providers.ts). A key
     * is never returned; `set` tries the credentials (lists the provider's models) before saving.
     */
    providers: router({
      get: adminProcedure.query(({ ctx }) => ctx.svc.providers.state()),
      set: adminProcedure
        .input(z.object({ provider: z.string().min(1).max(40), apiKey: z.string().trim().min(1).max(500).nullable().optional(), baseUrl: z.string().trim().url().max(500).nullable().optional() }))
        .mutation(async ({ ctx, input }) => {
          const known = ctx.svc.providers.describe().find((d) => d.provider === input.provider);
          if (!known) throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown provider "${input.provider}"` });
          if (input.baseUrl !== undefined && !known.baseUrlEnv) throw new TRPCError({ code: "BAD_REQUEST", message: `${known.title} has no base URL to set` });
          if (input.apiKey && known.keyEnv.length === 0 && input.provider !== ctx.svc.config.OPENAI_COMPATIBLE_NAME) throw new TRPCError({ code: "BAD_REQUEST", message: `${known.title} takes no API key` });
          const now = ctx.svc.providers.get(input.provider);
          const next = { ...now, ...(input.apiKey === undefined ? {} : input.apiKey ? { apiKey: input.apiKey } : { apiKey: undefined }), ...(input.baseUrl === undefined ? {} : input.baseUrl ? { baseUrl: input.baseUrl } : { baseUrl: undefined }) };
          // try before saving, unless this clears everything
          if (next.apiKey || next.baseUrl) {
            const probe = await ctx.svc.catalog.probe(input.provider, next);
            if (!probe.ok) throw new TRPCError({ code: "BAD_REQUEST", message: probe.error ?? "The provider did not answer" });
          }
          await ctx.svc.providers.set(input.provider, input, { id: ctx.user.id, email: ctx.user.email });
          return ctx.svc.providers.state().find((p) => p.provider === input.provider)!;
        }),
      /** Remove what was entered here; the environment (if any) applies again. */
      clear: adminProcedure.input(z.object({ provider: z.string().min(1).max(40) })).mutation(async ({ ctx, input }) => {
        await ctx.svc.providers.set(input.provider, { apiKey: null, baseUrl: null }, { id: ctx.user.id, email: ctx.user.email });
        return ctx.svc.providers.state().find((p) => p.provider === input.provider)!;
      }),
    }),
    /**
     * Which models run, changed without a restart. Keys and base URLs come from the environment or
     * from what an admin entered under `providers`: the
     * picker only offers models the configured providers can reach (ai/catalog.ts), and `set` refuses
     * anything that does not resolve, lacks its key, lacks word timestamps or is not installed on the
     * self-hosted server. Stages that are already running keep their model; new ones use the change.
     */
    /** Log levels in force and a temporary override (every process follows within ~5 s); see log-level.ts. */
    logLevel: router({
      get: adminProcedure.query(async ({ ctx }) => {
        const st = await ctx.svc.logLevel.refresh();
        const ctl = logControl(ctx.svc.log);
        return { ...st, modules: knownModules(ctx.svc.log), levels: PICKABLE_LEVELS, envGlobal: ctl?.base.global ?? "info" };
      }),
      /** `null` removes the override. */
      set: adminProcedure
        .input(z.object({ global: z.enum(PICKABLE_LEVELS), modules: z.array(z.object({ module: z.string().max(40), level: z.enum(PICKABLE_LEVELS) })).max(40), forMinutes: z.union([z.literal(15), z.literal(60), z.literal(240), z.literal(1440)]) }).nullable())
        .mutation(async ({ ctx, input }) => {
          try {
            const spec = input ? specFromStructured(input, knownModules(ctx.svc.log)) : null;
            const st = await ctx.svc.logLevel.set(spec, ctx.user.email, (input?.forMinutes ?? 15) * 60_000);
            ctx.log.info({ spec, minutes: input?.forMinutes ?? null }, "log level changed");
            return st;
          } catch (err) {
            throw new TRPCError({ code: "BAD_REQUEST", message: (err as Error).message });
          }
        }),
    }),
    models: router({
      get: adminProcedure.query(({ ctx }) => ({ ...ctx.svc.models.state(), pulls: ctx.svc.catalog.pulls() })),
      catalog: adminProcedure.input(z.object({ kind: z.enum(["language", "transcription"]), refresh: z.boolean().optional() })).query(({ ctx, input }) => ctx.svc.catalog.list(input.kind, { refresh: input.refresh })),
      set: adminProcedure
        .input(z.object({ language: modelId.nullable().optional(), transcription: modelId.nullable().optional(), align: modelId.nullable().optional() }))
        .mutation(async ({ ctx, input }) => {
          if (!MODEL_KINDS.some((k) => input[k] !== undefined)) throw new TRPCError({ code: "BAD_REQUEST", message: "Nothing to change" });
          try {
            return await ctx.svc.models.set(input, { id: ctx.user.id, email: ctx.user.email });
          } catch (err) {
            throw new TRPCError({ code: "BAD_REQUEST", message: (err as Error).message });
          }
        }),
      /** One tiny real call, so "saved" also means "answers". Transcription is checked statically (word timestamps, installed). */
      test: adminProcedure.input(z.object({ kind: z.enum(["language", "transcription"]), id: modelId })).mutation(async ({ ctx, input }) => {
        const t0 = Date.now();
        try {
          await ctx.svc.ai.verify(input.kind, input.id);
          if (input.kind === "language") {
            const r = await generateText({ model: await ctx.svc.ai.languageModel(input.id), prompt: "Reply with the single word: ready", maxOutputTokens: 8, abortSignal: AbortSignal.timeout(60_000) });
            return { ok: true as const, ms: Date.now() - t0, reply: r.text.trim().slice(0, 40) };
          }
          return { ok: true as const, ms: Date.now() - t0, reply: null };
        } catch (err) {
          return { ok: false as const, ms: Date.now() - t0, error: (err as Error).message };
        }
      }),
      /** Download onto Ollama / Speaches; progress through `get().pulls`. */
      pull: adminProcedure.input(z.object({ id: modelId })).mutation(async ({ ctx, input }) => {
        const provider = providerOf(input.id);
        try {
          return await ctx.svc.catalog.pull(provider, input.id.slice(provider.length + 1));
        } catch (err) {
          throw new TRPCError({ code: "BAD_REQUEST", message: (err as Error).message });
        }
      }),
      cancelPull: adminProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => ({ ok: ctx.svc.catalog.cancelPull(input.id) })),
    }),
    /** Expected vs actual seconds per stage on this machine with the current models (Settings → System → Machine; admins only, so hosted users never see the operator's hardware). */
    processingTimes: adminProcedure.query(async ({ ctx }) => {
      const models = currentModels(ctx.svc);
      return processingTimes(models, await loadHistory(ctx.svc.database.db), defaultFactors(models, localConfig(ctx.svc)));
    }),
  }),

  /** ⌘K palette before anything is typed: the 20 projects changed most recently, with their clip counts. */
  searchIndex: protectedProcedure.query(async ({ ctx }) => ({ projects: await recentProjects(ctx.svc.database.db, ctx.user.id, 20) })),

  /**
   * ⌘K and MCP search in SQL: every word must appear in a project title, or in a clip's title, hook or
   * caption. At most 8 projects and `limit` clips, most recently changed first; `truncated` says more match.
   * `links` instead lists projects whose source link contains one of the needles (a pasted link).
   */
  search: protectedProcedure
    .input(z.object({ q: z.string().max(200), limit: z.number().int().min(1).max(50).default(SEARCH_CLIPS), links: z.array(z.string().min(1).max(300)).max(50).optional() }))
    .query(async ({ ctx, input }) => {
      const res = await searchLibrary(ctx.svc.database.db, ctx.user.id, input);
      ctx.log.debug({ qLength: input.q.length, links: input.links?.length ?? 0, projects: res.projects.length, clips: res.clips.length, truncated: res.truncated }, "search");
      return res;
    }),

  projects: router({
    /** Keyset page of the caller's projects, newest activity first: `(updated_at, id)` descending. */
    list: protectedProcedure
      .input(z.object({ cursor: z.string().max(300).optional(), limit: z.number().int().min(1).max(100).default(24), status: z.enum(PROJECT_STATUSES).optional(), deleted: z.boolean().optional().describe("true = only deleted projects that can still be restored") }).optional())
      .query(async ({ ctx, input }) => {
        const page = await listProjectsPage(ctx.svc.database.db, ctx.user.id, { cursor: input?.cursor, limit: input?.limit ?? 24, status: input?.status, deleted: input?.deleted });
        ctx.log.debug({ limit: input?.limit ?? 24, cursor: !!input?.cursor, status: input?.status ?? null, items: page.rows.length, hasMore: !!page.nextCursor, total: page.total }, "projects page");
        return {
          items: page.rows.map(({ p, ...card }) => ({ ...publicProject(p), ...card })),
          nextCursor: page.nextCursor,
          total: page.total,
        };
      }),
    /** Header numbers: all projects, how many are processing, clips rendered. */
    stats: protectedProcedure.query(({ ctx }) => projectStats(ctx.svc.database.db, ctx.user.id)),
    /** Projects processing right now (id, status, stage, progress): the Projects page polls this, not the list. */
    active: protectedProcedure.query(async ({ ctx }) => (await activeProjects(ctx.svc.database.db, ctx.user.id)).map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() }))),

    get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
      const db = ctx.svc.database.db;
      const p = await ownedProject(db, ctx.user.id, input.id);
      const clips = await listClips(db, p.id);
      // facts only: the words, segments and flags come from transcripts.get, so a clip event never re-sends megabytes
      const t = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, p.id), columns: { language: true, flags: true } });
      const transcript = t ? { language: t.language, flagCount: t.flags.length, pendingFlags: t.flags.filter((f) => f.status === "pending").length } : null;
      // expected seconds per stage once the source length is known (after ingest); learned from this instance's finished projects
      const models = currentModels(ctx.svc);
      const estimates = p.durationSec ? estimateStages(p.durationSec, models, await loadHistory(db), defaultFactors(models, localConfig(ctx.svc))) : null;
      const bumpers = (await projectBumperSummaries(db, ctx.user.id, [{ id: p.id, settings: p.settings, clips }])).get(p.id)!;
      // clips deleted or replaced by a re-analyze, restorable with clips.restore until the purge
      const replacedClips = (await deletedClips(db, p.id)).map((c) => ({ ...c, deletedAt: c.deletedAt!.toISOString() }));
      return { ...publicProject(p), clips: clips.map(publicClip), replacedClips, transcript, estimates, bumpers };
    }),

    create: protectedProcedure.input(createProjectInputSchema).mutation(async ({ ctx, input }) => {
      const { svc } = ctx;
      const db = svc.database.db;
      if (!input.sourceUrl && !input.uploadId) throw new TRPCError({ code: "BAD_REQUEST", message: "Provide a sourceUrl or an uploadId" });
      const quotaReached = (err: unknown) => {
        ctx.log.warn({ reason: (err as Error).message }, "project quota reached");
        throw err;
      };
      // early refusal before the URL peek; the binding check runs again, locked, in the transaction that inserts
      await checkProjectQuota(db, svc.settings.get(), ctx.user.id).catch(quotaReached);
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
        // counted under a per-user lock in the inserting transaction, so concurrent creates can't overshoot the cap
        await checkProjectQuota(u.db, svc.settings.get(), ctx.user.id, { lock: true }).catch(quotaReached);
        // defaults, caller values and the intro/outro ownership + liveness check see one snapshot
        const settings = await resolveProjectSettings(u.db, ctx.user.id, input.settings);
        if (settings.minClipSeconds >= settings.maxClipSeconds) throw new TRPCError({ code: "BAD_REQUEST", message: "minClipSeconds must be below maxClipSeconds" });
        const [row] = await u.db
          .insert(schema.projects)
          .values({ id, userId: ctx.user.id, title, sourceType: input.uploadId ? "upload" : "url", sourceUrl: input.sourceUrl ?? null, sourceMeta, settings, status: "queued" })
          .returning();
        await u.emit(id, "project.created", { title });
        await startRun(u, id, { reason: "created", status: "queued" });
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
        // lock order transcript → clip → project: the refine branch rewrites the transcript, the render branch the clips,
        // and every branch then updates the project row (startRun)
        const [transcript] = await db.select({ projectId: schema.transcripts.projectId, refine: schema.transcripts.refine }).from(schema.transcripts).where(eq(schema.transcripts.projectId, p.id)).for("update");
        await lockProjectClips(u, p.id);
        const clips = await listClips(db, p.id); // read after the lock, so the statuses below are current
        const refineDone = !!transcript && REFINE_STEPS.every((s) => transcript.refine[s] === "done" || transcript.refine[s] === "failed");
        let queue: QueueName = QUEUES.ingest;
        if (clips.length) queue = QUEUES.render;
        else if (transcript && refineDone) queue = QUEUES.analyze;
        else if (transcript) queue = QUEUES.refineEntities; // marker: resume the refine fan-out
        else if (p.sourceKey) queue = QUEUES.transcribe;

        if (queue === QUEUES.render) {
          await startRun(u, p.id, { reason: "retry", status: "rendering", stage: "render", continueActive: true });
          for (const c of clips) {
            if (c.status === "done") continue;
            // a user-made clip whose AI preparation never finished goes back through clip.prepare
            if (needsPrepare(c)) {
              await requestPrepare(svc, u, p.id, c.id);
              continue;
            }
            await requestRender(svc, u, p.id, c.id, {}, "retry");
          }
        } else if (queue === QUEUES.refineEntities) {
          await startRun(u, p.id, { reason: "retry", status: "refining", stage: "refine", continueActive: true });
          for (const q of STAGE_QUEUES) await u.cancelLiveJobs(q, p.id);
          await enqueueRefine(svc, p.id, undefined, u);
        } else {
          for (const q of STAGE_QUEUES) await u.cancelLiveJobs(q, p.id);
          await startRun(u, p.id, { reason: "retry", status: "queued", continueActive: true });
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
        const steps = input.steps?.length ? input.steps : [...REFINE_STEPS];
        await svc.tx(async (u) => {
          const p = await ownedProject(u.db, ctx.user.id, input.id);
          // transcript first, then the project row (vocabulary, startRun)
          const [cur] = await u.db.select({ refine: schema.transcripts.refine }).from(schema.transcripts).where(eq(schema.transcripts.projectId, p.id)).for("update");
          if (!cur) throw new TRPCError({ code: "BAD_REQUEST", message: "Project has no transcript yet" });
          if (input.vocabulary !== undefined) {
            const vocabulary = input.vocabulary || undefined;
            projectSettingsSchema.parse({ ...p.settings, vocabulary }); // validate the result; write only the key (atomic merge)
            const settings = vocabulary ? sql`${schema.projects.settings} || ${JSON.stringify({ vocabulary })}::jsonb` : sql`${schema.projects.settings} - 'vocabulary'`;
            await u.db.update(schema.projects).set({ settings, updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
          }
          for (const s of steps) await u.cancelLiveJobs(REFINE_QUEUE[s], p.id);
          await startRun(u, p.id, { reason: "refine", status: "refining", stage: "refine" });
          const refine = { ...cur.refine };
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
      const rerendered = await svc.tx(async (u) => {
        const p = await ownedProject(u.db, ctx.user.id, input.id);
        // clips first (locked in id order), the project row last; the jobs only start once this commits with the new setting
        const n = await rerenderClips(svc, u, p.id);
        // atomic JSON merge: no read-modify-write, so concurrent settings edits can't drop each other
        await u.db.update(schema.projects).set({ settings: sql`${schema.projects.settings} || ${JSON.stringify({ sourceText: input.sourceText })}::jsonb`, updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
        return n;
      });
      return { ok: true, rerendered };
    }),

    /**
     * Per-project intro/outro: for each slot "default" (the user's current default), "none" (even if the
     * default has one) or a library asset id. Re-renders every finished clip only when `rerender` is set.
     */
    setBumpers: protectedProcedure
      .input(z.object({ id: z.string(), intro: z.string().min(1).max(100).optional(), outro: z.string().min(1).max(100).optional(), introSec: bumperSecondsSchema.optional(), outroSec: bumperSecondsSchema.optional(), rerender: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        const { svc } = ctx;
        const rerendered = await svc.tx(async (u) => {
          const p = await ownedProject(u.db, ctx.user.id, input.id);
          const mine = await userDefaults(u.db, ctx.user.id);
          let expr = sql`${schema.projects.settings}`;
          const patch: Record<string, string | number | null> = {};
          for (const [slot, key, choice, secs] of [["intro", "introAssetId", input.intro, input.introSec], ["outro", "outroAssetId", input.outro, input.outroSec]] as const) {
            if (choice === undefined) continue;
            expr = sql`(${expr}) - ${key}::text - ${`${slot}Sec`}::text`;
            if (secs !== undefined && choice !== "none") patch[`${slot}Sec`] = secs;
            if (choice === "none") patch[key] = null;
            else if (choice === "default") {
              if (mine[key]) patch[key] = mine[key]!;
            } else {
              // a library asset of this user; the one the project already uses stays valid even if it was since removed
              const [asset] = await u.db.select({ id: schema.bumperAssets.id, deletedAt: schema.bumperAssets.deletedAt }).from(schema.bumperAssets).where(and(eq(schema.bumperAssets.id, choice), eq(schema.bumperAssets.userId, ctx.user.id)));
              if (!asset || (asset.deletedAt && p.settings[key] !== choice)) throw new TRPCError({ code: "NOT_FOUND", message: `That ${slot} is not in your library` });
              patch[key] = choice;
            }
          }
          // clips first, the project row last (lock order clip → project)
          const n = input.rerender ? await rerenderClips(svc, u, p.id) : 0;
          await u.db.update(schema.projects).set({ settings: sql`(${expr}) || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
          return n;
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
      .input(z.object({ id: z.string(), style: styleOverrideSchema, keepOverrides: z.boolean().optional(), rerender: z.boolean().default(true) }))
      .mutation(async ({ ctx, input }) => {
        const { svc } = ctx;
        const rerendered = await svc.tx(async (u) => {
          const p = await ownedProject(u.db, ctx.user.id, input.id);
          // validate against the whole settings object, but write only the changed keys (atomic merge)
          const merged = projectSettingsSchema.parse({ ...p.settings, ...input.style });
          const patch = Object.fromEntries(Object.keys(input.style).map((k) => [k, merged[k as keyof typeof merged]]));
          // clips first (locked in id order, then cleared and re-rendered), the project row last
          await lockProjectClips(u, p.id);
          if (!input.keepOverrides) await u.db.update(schema.clips).set({ style: null }).where(eq(schema.clips.projectId, p.id));
          const n = input.rerender ? await rerenderClips(svc, u, p.id) : 0;
          await u.db
            .update(schema.projects)
            .set({ settings: sql`(${schema.projects.settings} - 'captionPosition') || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
            .where(eq(schema.projects.id, p.id));
          return n;
        });
        return { ok: true, rerendered };
      }),

    /** Pick moments again on the same transcript. Clips the user made or edited stay; untouched AI picks are replaced (restorable). */
    reanalyze: protectedProcedure
      .input(z.object({ id: z.string(), settings: projectSettingsPatchSchema.optional() }))
      .mutation(({ ctx, input }) => reanalyzeProject(ctx.svc, { id: ctx.user.id, admin: false }, input.id, input.settings)),

    /** Title and settings without re-running anything (selection settings apply on the next reanalyze, style on the next render). */
    update: protectedProcedure
      .input(z.object({ id: z.string(), title: z.string().trim().min(1).max(200).optional(), settings: projectSettingsPatchSchema.optional(), clear: z.array(z.enum(CLEARABLE_SETTINGS)).max(CLEARABLE_SETTINGS.length).optional() }))
      .mutation(({ ctx, input }) => updateProject(ctx.svc, { id: ctx.user.id, admin: false }, input.id, input)),

    /** Soft delete: hidden everywhere and its work stopped; restorable for DELETED_RETENTION_DAYS. */
    delete: protectedProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => deleteOwnedProject(ctx.svc, { id: ctx.user.id, admin: false }, input.id)),

    /** Undo a delete (the owner, or an admin for anyone's project). */
    restore: protectedProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => restoreProject(ctx.svc, actorOf(ctx.user), input.id)),

    /**
     * SSE stream of project events. It replays the newest `EVENT_REPLAY_LIMIT` non-progress events (after
     * `lastEventId` on a reconnect), then one `events.replayed` message saying how many there are in all, then
     * everything live, progress ticks included (they are never stored for replay).
     */
    events: protectedProcedure.input(z.object({ id: z.string(), lastEventId: z.string().nullish() })).subscription(async function* ({ ctx, input, signal }) {
      const { svc } = ctx;
      await ownedProject(svc.database.db, ctx.user.id, input.id);
      const after = Number(input.lastEventId ?? 0) || 0;
      const live = svc.events.notices(input.id, signal); // subscribe before catch-up so nothing slips through
      const { headId, total } = await svc.events.stats(input.id);
      const history = await svc.events.history(input.id, { limit: svc.config.EVENT_REPLAY_LIMIT, after: after || undefined, upTo: headId });
      for (const e of history.events) yield tracked(String(e.id), e satisfies ProjectEvent);
      const marker: EventsReplayed = { type: "events.replayed", shown: history.events.length, total, oldestId: history.events[0]?.id ?? null, hasMore: history.hasMore };
      let lastId = Math.max(headId, after);
      yield tracked(String(lastId), marker);
      // from here on everything newer than the head, in pages: list() returns at most 500 rows
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
        // a progress tick is forwarded as is; it repeats the last stored id, so a reconnect resumes from a real event
        if (isProgressNotice(notice)) yield tracked(String(lastId), progressEvent(notice));
        else if (notice.id > lastId) yield* flush();
      }
    }),

    /** Older events for the Activity panel: up to `limit` non-progress events with an id below `before`, oldest first. */
    eventsPage: protectedProcedure.input(z.object({ id: z.string(), before: z.number().int().positive(), limit: z.number().int().min(1).max(500).default(200) })).query(async ({ ctx, input }) => {
      await ownedProject(ctx.svc.database.db, ctx.user.id, input.id);
      return ctx.svc.events.history(input.id, { limit: input.limit, before: input.before });
    }),

    /** Failed work across the account, for the palette's "Retry all failed clips / Resume failed projects". */
    counts: protectedProcedure.query(({ ctx }) => failedCounts(ctx.svc.database.db, ctx.user.id)),
  }),

  transcripts: router({
    /** The words, segments, flags and on-screen text of a project (megabytes for a long source), fetched apart from `projects.get`. */
    get: protectedProcedure.input(z.object({ projectId: z.string() })).query(async ({ ctx, input }) => {
      const db = ctx.svc.database.db;
      const p = await ownedProject(db, ctx.user.id, input.projectId);
      const t = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, p.id), columns: { language: true, segments: true, words: true, rawWords: true, flags: true, deletedFlags: true, entities: true, refine: true, sceneCuts: true, overlays: true, textProfile: true } });
      return t ?? null;
    }),
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
        await writeTranscript(u, p.id, t, { words, rawWords: raw, flags: live, deletedFlags, segments, text: segments.map((s) => s.text).join(" ") });
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
        // past the live cap (200) deleted fixes live in the archive (stage_artifacts); taking one from there removes it from there
        const d = t.deletedFlags?.find((x) => x.id === input.flagId) ?? (await takeArchivedFlag<DeletedFlag>(u.db, p.id, input.flagId));
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
          /** This clip's own intro/outro choice, replacing the whole value: a missing key inherits the project, null is none. */
          bumpers: clipBumpersSchema.nullable().optional(),
          startSec: z.number().min(0).optional(),
          endSec: z.number().min(0).optional(),
          rerender: z.boolean().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const { svc } = ctx;
        const updated = await svc.tx(async (u) => {
        // ownership and the row under lock: what changed is decided against the current row, not an earlier snapshot
        const { clip: c, project: p } = await ownedClip(u, ctx.user.id, input.id);
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
        const cleanBumpers = input.bumpers && Object.values(input.bumpers).some((v) => v !== undefined) ? { ...(input.bumpers.intro !== undefined ? { intro: input.bumpers.intro } : {}), ...(input.bumpers.introSec !== undefined ? { introSec: input.bumpers.introSec } : {}), ...(input.bumpers.outro !== undefined ? { outro: input.bumpers.outro } : {}), ...(input.bumpers.outroSec !== undefined ? { outroSec: input.bumpers.outroSec } : {}) } : null;
        const bumpersChanged = input.bumpers !== undefined && JSON.stringify(cleanBumpers) !== JSON.stringify(c.bumpers ?? null);
        const needsRender = bumpersChanged || boundsChanged || hookChanged || layoutChanged || sectionsChanged || styleChanged || emphasisChanged; // these are burned into the video
        const cur = c;
        // ownership of the chosen assets is checked in the unit of work that writes
        if (bumpersChanged) await assertOwnedBumpers(u.db, ctx.user.id, [cleanBumpers?.intro, cleanBumpers?.outro], [cur.bumpers?.intro, cur.bumpers?.outro]);
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
            ...(input.bumpers !== undefined ? { bumpers: cleanBumpers } : {}),
            startSec: Number(startSec.toFixed(2)),
            endSec: Number(endSec.toFixed(2)),
            editedAt: new Date(), // a clip the user touched survives a re-analyze
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
     * Set the intro and/or outro of several clips at once. Per slot: "inherit" (follow the project), "none",
     * or a library asset id; a slot left out is untouched. One atomic JSON merge per slot, in one transaction,
     * with a render request per clip only when `rerender` is set.
     */
    setBumpersMany: protectedProcedure
      .input(z.object({ projectId: z.string(), clipIds: z.array(z.string()).min(1).max(200), intro: z.string().min(1).max(100).optional(), outro: z.string().min(1).max(100).optional(), introSec: bumperSecondsSchema.optional(), outroSec: bumperSecondsSchema.optional(), rerender: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        const { svc } = ctx;
        return svc.tx(async (u) => {
          const p = await ownedProject(u.db, ctx.user.id, input.projectId);
          const clips = await u.db.select({ id: schema.clips.id, status: schema.clips.status }).from(schema.clips).where(and(eq(schema.clips.projectId, p.id), inArray(schema.clips.id, input.clipIds), isNull(schema.clips.deletedAt))).orderBy(schema.clips.id).for("update"); // id order, like lockProjectClips; replaced clips are not edited
          if (clips.length !== new Set(input.clipIds).size) throw new TRPCError({ code: "NOT_FOUND", message: "Some of those clips no longer exist" });
          await assertOwnedBumpers(u.db, ctx.user.id, [input.intro, input.outro].map((x) => (x === "none" || x === "inherit" ? null : x)));
          const ids = clips.map((c) => c.id);
          for (const [slot, choice, secs] of [["intro", input.intro, input.introSec], ["outro", input.outro, input.outroSec]] as const) {
            if (choice === undefined) continue;
            const patch = choice === "inherit" ? {} : { [slot]: choice === "none" ? null : choice, ...(secs !== undefined && choice !== "none" ? { [`${slot}Sec`]: secs } : {}) };
            await u.db
              .update(schema.clips)
              .set({ bumpers: sql`nullif((coalesce(${schema.clips.bumpers}, '{}'::jsonb) - ${slot}::text - ${`${slot}Sec`}::text) || ${JSON.stringify(patch)}::jsonb, '{}'::jsonb)`, updatedAt: new Date() })
              .where(inArray(schema.clips.id, ids));
          }
          let rerendered = 0;
          if (input.rerender) for (const c of clips) if ((c.status === "done" || c.status === "failed") && (await requestRender(svc, u, p.id, c.id)) !== null) rerendered++;
          return { ok: true, updated: ids.length, rerendered };
        });
      }),

    /**
     * New clip from a transcript selection. mode "exact" keeps the bounds; "ai" searches inside them.
     * Metadata (and bounds for "ai") are filled in by the clip.prepare job, then it renders.
     */
    create: protectedProcedure
      .input(z.object({ projectId: z.string(), startSec: z.number().min(0), endSec: z.number().min(0), mode: z.enum(["exact", "ai"]) }))
      .mutation(async ({ ctx, input }) => {
        const { svc } = ctx;
        const len = input.endSec - input.startSec;
        if (len < (input.mode === "ai" ? 8 : 3)) throw new TRPCError({ code: "BAD_REQUEST", message: input.mode === "ai" ? "Select at least 8 seconds for the AI to search" : "A clip must be at least 3 seconds" });
        if (input.mode === "exact" && len > 600) throw new TRPCError({ code: "BAD_REQUEST", message: "A clip can be at most 10 minutes" });
        const row = await svc.tx(async (u) => {
        const db = u.db;
        const p = await ownedProject(db, ctx.user.id, input.projectId);
        if (p.durationSec && input.endSec > p.durationSec + 0.5) throw new TRPCError({ code: "BAD_REQUEST", message: "Selection ends after the video" });
        const transcript = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, p.id), columns: { projectId: true } });
        if (!transcript || !p.sourceKey) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The video must be downloaded and transcribed first" });
        const existing = await db.query.clips.findMany({ where: eq(schema.clips.projectId, p.id), columns: { index: true } });
        const index = existing.reduce((m, c) => Math.max(m, c.index + 1), 0);
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
        // born "preparing": the prepare job and the run start go through the one prepare path
        await requestPrepare(svc, u, p.id, inserted!.id, { mode: input.mode, reason: "clip_added" });
        await u.emit(p.id, "clip.created", { clipId: inserted!.id, index, title: inserted!.title });
        return inserted!;
        });
        return publicClip(row);
      }),

    rerender: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
      const { svc } = ctx;
      return svc.tx(async (u) => {
        const { clip: c, project: p } = await ownedClip(u, ctx.user.id, input.id);
        if (needsPrepare(c)) {
          // never prepared (e.g. the model was down): redo preparation, which renders afterwards
          await requestPrepare(svc, u, p.id, c.id, { reason: "rerender" });
          return { ok: true, step: "prepare" as const };
        }
        await requestRender(svc, u, p.id, c.id);
        return { ok: true, step: "render" as const };
      });
    }),

    /** Soft-delete one clip; restorable with clips.restore until the purge (DELETED_RETENTION_DAYS). */
    delete: protectedProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => deleteClip(ctx.svc, { id: ctx.user.id, admin: false }, input.id)),

    /** Bring back a deleted clip or one a re-analyze replaced (listed as replacedClips on projects.get). */
    restore: protectedProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => restoreClip(ctx.svc, actorOf(ctx.user), input.id)),

    /**
     * Re-render several clips of a project at once (the selection bar, "Retry failed"). One transaction, one run:
     * finished and failed clips are queued; clips still rendering or never prepared are counted as skipped.
     */
    rerenderMany: protectedProcedure.input(z.object({ projectId: z.string(), clipIds: z.array(z.string()).min(1).max(200) })).mutation(async ({ ctx, input }) => {
      const { svc } = ctx;
      return svc.tx(async (u) => {
        const p = await ownedProject(u.db, ctx.user.id, input.projectId);
        try {
          return { ok: true, ...(await requestRenders(svc, u, p.id, input.clipIds)) };
        } catch (e) {
          if (e instanceof RenderManyMissing) throw new TRPCError({ code: "NOT_FOUND", message: e.message });
          throw e;
        }
      });
    }),
  }),
});

export type AppRouter = typeof appRouter;
