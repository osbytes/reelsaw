import { z } from "zod";
import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { TRPCError, tracked } from "@trpc/server";
import { router, mergeRouters, protectedProcedure, publicProcedure, signedInProcedure, adminProcedure } from "./context.js";
import { approveUser, banUser, removeUser, setUserLimits, setUserPassword, setUserRole, setUserWatermark, unbanUser } from "../accounts.js";
import { decisionSummary, EXPORT_MAX, exportDecisions, fixDecisions, forgetDecisions, LIST_MAX, listDecisions, recordDecisions, setLearning } from "../decisions/service.js";
import { DECISION_KINDS } from "@reelsaw/shared";
import { applyProjectFraming, createProject, deleteClip, deleteClips, deleteOwnedProject, deletedClips, findProject, projectBumpersInput, projectStyleInput, purgeOwnedClip, purgeOwnedProject, reanalyzeProject, refineInput, refineProject, restoreClip, restoreProject, retryOwnedProject, setProjectBumpers, setProjectSourceText, updateProject, updateProjectStyle } from "../projects/service.js";
import { clipBumpersManyInput, createClip, createClipInput, rerenderClip, rerenderClips, rerenderManyInput, setClipBumpers, updateClip, updateClipInput } from "../clips/service.js";
import { peekUrlMeta } from "../projects/peek.js";
import { deletedItemRefSchema, listDeleted, purgeDeleted, restoreDeleted } from "../deleted.js";
import { USER_ROLES } from "../db/schema.js";
import { listWorkers } from "../ops/workers.js";
import { summarizeQueue } from "../ops/queue.js";
import { FAILURE_STAGES, getFailure, listFailures, retryFailures } from "../ops/failures.js";
import { schema, type Db } from "../db/index.js";
import { CLEARABLE_SETTINGS, createProjectInputSchema, projectSettingsPatchSchema, defaultProjectSettings, PASSWORD_MAX_LENGTH, userProjectDefaultsSchema, bumperSecondsSchema, sectionModeSchema, sectionAdjustSchema, overlayKind, TEXT_OVERLAY_DEFAULTS, ASSET_OVERLAY_DEFAULT_W, CLIP_AUDIO_DEFAULTS, clipAudioList, TEXT_FONTS, styleSchema, clipLayers, layersToLegacy, assetTagsSchema, assetProvenanceSchema, SFX_MAX_SEC, layerTemplateNameSchema, layerTemplateLayersSchema, type ClipLayer, type ClipOverlay, type ClipAudio, type EventsReplayed, type ProjectEvent, type TranscriptFlag, type Word } from "@reelsaw/shared";
import { splitDeleted, archiveDeletedFlags, takeArchivedFlag, changedColumns } from "../transcript-limits.js";
import { QUEUES, type QueueName } from "../queue/boss.js";
import type { Services } from "../services.js";
import type { UnitOfWork } from "../uow.js";
import { lockProjectClips, requestRender } from "../pipeline/lifecycle.js";
import { listClips } from "../pipeline/analyze.js";
import { keys } from "../storage/index.js";
import { svgSize, svgHasExternalRefs } from "../pipeline/raster.js";
import { bumperKind, assetKind, bumperProblem, ensureBumperThumb, sha256File, assetMime, BUMPER_IMAGE_SEC } from "../pipeline/bumpers.js";
import { projectBumperSummaries, bumperUsageCounts, bumperAssetUsage, bumperNameSchema, updateBumperAsset, createAsset, setBumperDefault, requireOneSource, downloadAsUpload, restoreOwnedAsset, purgeOwnedAsset } from "../library/service.js";
import { applyLayerTemplate, applyLayerTemplateInput, createLayerTemplate, getLayerTemplate, layerTemplateFromClip, listLayerTemplates, publicTemplate, purgeLayerTemplate, removeLayerTemplate, restoreLayerTemplate, templateIdSchema, updateLayerTemplate } from "../library/templates.js";
import { asTrpc, catalogSearch, importAsset, libraryProviders, type ImportedAsset } from "../library/import.js";
import { applyFlags } from "../pipeline/entities.js";
import { userDefaults } from "../pipeline/settings.js";
import { assetVisibleTo } from "../library/visible.js";
import { PROJECT_STATUSES } from "@reelsaw/shared";
import { toSentences } from "../pipeline/transcript.js";
import { isProgressNotice, progressEvent } from "../events.js";
import { SEARCH_USERS, setSearchThreshold, userMatch, userScore, words } from "../search.js";
import { failedCounts, recentProjects, searchLibrary, SEARCH_CLIPS } from "../search.js";
import { listProjectsPage, projectStats, activeProjects } from "../projects-list.js";
import { decodeCursor, LIST_LIMIT_DEFAULT, listPageInput, pageCursor, pageOf } from "../pagination.js";
import { limitsDetail, LIMIT_KEYS, limitUsage, periodFor, usageByUser, watermarkFor } from "../quota.js";
import { defaultFactors, estimateStages, loadHistory, processingTimes, type Models } from "../pipeline/estimates.js";
import { MODEL_KINDS } from "../ai/models.js";
import { settingsPatchSchema, SettingsError } from "../instance-settings.js";
import { reportCapabilities } from "../report/capabilities.js";
import { logControl } from "../log.js";
import { knownModules, PICKABLE_LEVELS, specFromStructured } from "../log-level.js";
import { providerOf } from "../ai/registry.js";
import { generateText } from "ai";
import { takeTxLock, txLock } from "../locks.js";
import { clipCaptionsFile, importTranscript, projectTranscriptFile, MAX_SUBTITLE_BYTES } from "../transcript-files.js";

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
    /** everything laid over or played under the clip: assets, text and sounds */
    layers: clipLayers(c),
    scores: c.scores ?? null,
    emphasis: c.emphasis ?? [],
    status: c.status,
    origin: c.origin,
    diagnostics: c.diagnostics ?? null,
    error: c.error,
    layout: c.layout,
    layoutInfo: c.layoutInfo,
    /** the last render burned the watermark in; a re-render after an upgrade drops it */
    watermark: c.watermark,
    /** the last render stored its captions, so SRT / VTT can be downloaded */
    hasCaptions: !!c.captions,
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
    /** checkpointed stages: { done, total, etaSec, unitMs } (13 of 43 parts, seconds left), else null */
    stageDetail: p.stageDetail,
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
  // a cut drawn over the detector's unreviewed cuts implies they were right, but only implies it: the user may have cut a
  // whole passage without looking at them, so each gets an inferred fix.accept (kept, never an eval label) next to the fix.manual
  const confirmed = what.kind === "disfluency" ? merged.filter((f) => f.kind === "disfluency" && f.subkind !== "manual" && (f.status === "pending" || f.status === "auto")) : [];
  await recordDecisions(svc, u.db, p, () =>
    fixDecisions(u.db, p.id, raw, [
      ...confirmed.map((f) => ({ kind: "fix.accept" as const, flag: f, before: f, after: { ...f, status: "accepted" as const }, explicit: false })),
      { kind: "fix.manual", flag, before: null, after: flag },
    ]),
  );
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

/**
 * The user's project, or NOT_FOUND with a sentence. Services check ownership themselves (`findProject`); this is for the
 * reads that stay in this file.
 */
function ownedProject(db: Db, userId: string, projectId: string) {
  // a deleted project is gone for every procedure until it is restored (projects.restore)
  return findProject(db, { id: userId, admin: false }, projectId, { deleted: false });
}

const actorOf = (user: { id: string; role?: string | null }): { id: string; admin: boolean } => ({ id: user.id, admin: user.role === "admin" });
/** The billing service, or the sentence a self-hosted instance answers with. */
function billingOf(svc: Services) {
  if (!svc.ee) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Billing is not enabled on this Reelsaw (REELSAW_EE is off)." });
  return svc.ee.billing;
}
const periodOf = (g: Parameters<typeof periodFor>[0]) => {
  const p = periodFor(g);
  return { start: p.start.toISOString(), end: p.end.toISOString(), source: p.source };
};

const STAGE_QUEUES = [QUEUES.ingest, QUEUES.transcribe, QUEUES.refineEntities, QUEUES.refineDisfluency, QUEUES.refineScenes, QUEUES.analyze] as const;

// appRouter is three routers merged (head, bumpers, rest) so the library router can be mounted under two names
// (`bumpers` and `library`) without moving its code.
const headRouter = router({
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
        emailVerification: s.REQUIRE_EMAIL_VERIFICATION && ctx.svc.email.enabled,
        termsUrl: s.TERMS_URL ?? null,
        privacyUrl: s.PRIVACY_URL ?? null,
        maxUploadMb: s.MAX_UPLOAD_MB,
        captcha: s.CAPTCHA_PROVIDER && s.CAPTCHA_SITE_KEY && s.CAPTCHA_SECRET_KEY ? { provider: s.CAPTCHA_PROVIDER, siteKey: s.CAPTCHA_SITE_KEY } : null,
        /** heavy jobs wait for the machine; the word says what is short, never the numbers */
        paused,
        /** public keys for the browser's Sentry / PostHog (telemetry.ts); null = off */
        telemetry: ctx.svc.telemetry.public,
        /** browser OTLP (otel-config.ts); null when OTEL is off or headers are not public */
        otel: ctx.svc.otel.public,
      };
    }),
  }),

  /**
   * GitHub releases and the 90-day commit heatmap (releases.ts). Signed-in; `list_releases` and
   * `reelsaw releases` share this. The app UI links to reelsaw.com/releases. Cached for an hour.
   */
  releases: router({
    get: protectedProcedure.query(({ ctx }) => ctx.svc.releases.get()),
  }),

  /** The signed-in account, also while waiting for approval or suspended. */
  me: router({
    get: signedInProcedure.query(async ({ ctx }) => {
      const s = ctx.svc.settings.get();
      return {
        id: ctx.user.id,
        name: ctx.user.name,
        email: ctx.user.email,
        role: ctx.user.role,
        approved: !!ctx.user.approvedAt,
        blocked: ctx.who.blocked,
        mustChangePassword: ctx.user.mustChangePassword,
        via: ctx.who.via,
        projectDefaults: ctx.who.blocked ? {} : await userDefaults(ctx.svc.database.db, ctx.user.id),
        builtInDefaults: defaultProjectSettings,
        /** Instance ceilings for refine steps (env → Settings → System → Pipeline). Off means the project toggle cannot turn the step on. */
        refineGates: {
          entities: s.TRANSCRIPT_CORRECTION,
          disfluency: s.DISFLUENCY_REMOVAL,
          disfluencyLlm: s.DISFLUENCY_LLM,
          scenes: s.REFINE_SCENES,
        },
        /** which enterprise features this instance runs (ee/); the web shows the Billing tab from this */
        ee: { billing: !!ctx.svc.ee },
        /** zip vs Sentry/PostHog feedback for "Report an issue" (report/capabilities.ts) */
        report: reportCapabilities(ctx.svc, ctx.user),
        /** whether this account's next render carries the watermark, and why (instance, plan, an admin's choice) */
        watermark: ctx.who.blocked ? null : await watermarkFor(ctx.svc.database.db, s, ctx.user, ctx.svc.entitlements),
      };
    }),
    /**
     * After `reelsaw set-password --must-change`: pick a new password without the current one.
     * The session is the proof they knew the temporary password. Other devices stay signed out.
     */
    completePasswordChange: signedInProcedure
      .input(z.object({ password: z.string().min(1).max(PASSWORD_MAX_LENGTH) }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.who.via !== "session" || !ctx.who.session) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Choose the new password in the browser after signing in." });
        }
        return setUserPassword(ctx.svc, ctx.user.id, ctx.user.id, input.password, {
          mustChange: false,
          keepSessionId: ctx.who.session.session.id,
          rejectReuse: true,
        });
      }),
    /** Replace the saved project defaults (the form sends the whole set; {} clears them). */
    updateProjectDefaults: protectedProcedure.input(userProjectDefaultsSchema).mutation(async ({ ctx, input }) => {
      const { introAssetId: _i, outroAssetId: _o,...rest } = input; // intro/outro change only through `bumpers.*`
      const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined && v !== ""));
      return ctx.svc.tx(async (u) => {
        // the default layer template must be one of the user's live templates
        if (typeof clean.layerTemplateId === "string") await getLayerTemplate(u.db, ctx.user.id, clean.layerTemplateId);
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
    /**
     * A new API key for this account (Settings → API keys). Permissions can only be set on the server, so the
     * Settings page asks here instead of calling the auth client. A key can administer the instance only when an
     * admin ticked it; a key cannot mint keys.
     */
    createApiKey: protectedProcedure
      .input(z.object({ name: z.string().trim().min(1).max(32), admin: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.who.via !== "session") throw new TRPCError({ code: "FORBIDDEN", message: "Create keys from the Settings page after signing in." });
        if (input.admin && ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Only admins can create a key that administers the instance." });
        const created = await ctx.svc.auth.api.createApiKey({ body: { name: input.name, userId: ctx.user.id, permissions: { admin: input.admin ? ["write"] : [] } } });
        ctx.log.info({ keyId: created.id, admin: input.admin }, "api key created");
        return { id: created.id, key: created.key, name: input.name };
      }),
    /** Apps (MCP connectors) this account has allowed through the OAuth consent screen. Empty unless MCP_OAUTH is on. */
    oauthGrants: protectedProcedure.query(async ({ ctx }) => {
      const rows = await ctx.svc.database.db
        .select({
          clientId: schema.oauthConsent.clientId,
          grantedAt: schema.oauthConsent.createdAt,
          scopes: schema.oauthConsent.scopes,
          name: schema.oauthClient.name,
          uri: schema.oauthClient.uri,
          redirectUris: schema.oauthClient.redirectUris,
        })
        .from(schema.oauthConsent)
        .innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.oauthConsent.clientId))
        .where(eq(schema.oauthConsent.userId, ctx.user.id))
        .orderBy(desc(schema.oauthConsent.createdAt));
      return rows.map(({ redirectUris, ...r }) => ({ ...r, redirectHosts: redirectHosts(redirectUris) }));
    }),
    /** Take an app's access away: its consent and every token it holds for this account. Its next request fails. */
    revokeOauthGrant: protectedProcedure.input(z.object({ clientId: z.string().min(1).max(200) })).mutation(({ ctx, input }) =>
      ctx.svc.tx(async (u) => {
        const mine = (table: { userId: AnyPgColumn; clientId: AnyPgColumn }) => and(eq(table.userId, ctx.user.id), eq(table.clientId, input.clientId));
        await u.db.delete(schema.oauthAccessToken).where(mine(schema.oauthAccessToken));
        await u.db.delete(schema.oauthRefreshToken).where(mine(schema.oauthRefreshToken));
        const gone = await u.db.delete(schema.oauthConsent).where(mine(schema.oauthConsent)).returning({ id: schema.oauthConsent.id });
        ctx.log.info({ clientId: input.clientId, consents: gone.length }, "oauth grant revoked");
        return { ok: true };
      }),
    ),
  }),

  /**
   * Billing (enterprise edition). On an instance without it every procedure answers PRECONDITION_FAILED with a
   * sentence; the web never shows the tab (me.get `ee.billing`). Money moves only on Stripe-hosted pages: the
   * procedures hand back URLs.
   */
  billing: router({
    /** Your plan, subscription, period, the limits in force and what you have used, the watermark decision, and the plan list. */
    get: protectedProcedure.query(({ ctx }) => billingOf(ctx.svc).stateFor(ctx.user)),
    /** A Stripe Checkout URL for a plan (or, with a live subscription, the Billing Portal's confirm-change page). Open it in a browser. */
    checkout: protectedProcedure.input(z.object({ plan: z.string().min(1).max(40), interval: z.enum(["month", "year"]).default("month") })).mutation(({ ctx, input }) => billingOf(ctx.svc).checkout(ctx.user, input.plan, input.interval)),
    /** The Stripe Billing Portal (invoices, card, cancel at period end). */
    portal: protectedProcedure.mutation(({ ctx }) => billingOf(ctx.svc).portal(ctx.user)),
  }),
});

type UsageCounts = Awaited<ReturnType<typeof bumperUsageCounts>>;

/** One library row as the screens read it. `owner` is "shared" for catalog / provider imports (`user_id` null). */
/** The hosts an OAuth app sends people back to: what the consent screen and the connected-apps list show. */
function redirectHosts(uris: string[]): string[] {
  const hosts = uris.flatMap((u) => (URL.canParse(u) ? [new URL(u).host] : []));
  return [...new Set(hosts)];
}

function toLibraryItem(r: typeof schema.assets.$inferSelect, usage: UsageCounts, me: string) {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    durationSec: r.durationSec,
    width: r.width,
    height: r.height,
    hasAudio: r.hasAudio,
    sizeBytes: r.sizeBytes,
    createdAt: r.createdAt.toISOString(),
    thumbnailUrl: r.kind === "audio" ? "" : `/media/assets/${r.id}/thumb.jpg`,
    usedBy: usage.get(r.id)?.projects ?? 0,
    usedByClips: usage.get(r.id)?.clips ?? 0,
    /** live layer templates with a layer that names it (a removal keeps the template's layer; it is skipped at apply) */
    usedByTemplates: usage.get(r.id)?.templates ?? 0,
    mime: r.mime,
    tags: r.tags,
    provenance: r.provenance,
    system: r.system,
    owner: (r.userId === me ? "me" : "shared") as "me" | "shared",
  };
}

/**
 * One keyset page of the library, newest upload first: the account's own live uploads with usage (`items`, `nextCursor`,
 * `total` of all live ones) and the removals of the last 30 days (`deleted`, at most 200). Catalog / provider files are
 * instance-shared and listed by search, not here.
 */
async function libraryPage(svc: Services, userId: string, opts: { limit?: number; cursor?: string }) {
  const db = svc.database.db;
  const A = schema.assets;
  const limit = opts.limit ?? LIST_LIMIT_DEFAULT;
  const cur = pageCursor(opts.cursor, 2);
  const live = and(eq(A.userId, userId), isNull(A.deletedAt));
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const [fetched, [counted], removed, usage] = await Promise.all([
    db
      .select({ row: A, ts: sql<string>`${A.createdAt}::text` })
      .from(A)
      .where(and(live, cur ? sql`(${A.createdAt}, ${A.id}) < (${String(cur[0])}::timestamptz, ${String(cur[1])})` : undefined))
      .orderBy(desc(A.createdAt), desc(A.id))
      .limit(limit + 1),
    db.select({ total: sql<number>`count(*)::int` }).from(A).where(live),
    db.select().from(A).where(and(eq(A.userId, userId), isNotNull(A.deletedAt), gt(A.deletedAt, cutoff))).orderBy(desc(A.createdAt), desc(A.id)).limit(200),
    bumperUsageCounts(db, userId),
  ]);
  const { items, nextCursor } = pageOf(fetched, limit, (r) => [r.ts, r.row.id]);
  return {
    items: items.map((r) => toLibraryItem(r.row, usage, userId)),
    nextCursor,
    total: counted?.total ?? 0,
    deleted: removed.map((r) => toLibraryItem(r, usage, userId)),
  };
}

/** The whole library, for the search that filters in memory: the account's own uploads, with usage, and the removals of the last 30 days. Catalog / provider files are instance-shared and listed by search, not here. */
async function listLibrary(svc: Services, userId: string) {
    const db = svc.database.db;
    const rows = await db.select().from(schema.assets).where(eq(schema.assets.userId, userId)).orderBy(desc(schema.assets.createdAt));
    const usage = await bumperUsageCounts(db, userId);
    const pub = (r: (typeof rows)[number]) => toLibraryItem(r, usage, userId);
    // old rows have no content_hash (no backfill; see docs/specs/bumpers.md), so only new uploads are checked for duplicates
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    return {
      assets: rows.filter((r) => !r.deletedAt).map(pub),
      deleted: rows.filter((r) => r.deletedAt && r.deletedAt.getTime() > cutoff).map(pub),
    };
}
type LibraryRow = ReturnType<typeof toLibraryItem>;

const LIBRARY_GET_MAX = 40;

/** Own uploads (removed ones too, so a clip that still names them has a name), plus instance-shared catalog / provider rows. Missing or foreign ids are omitted. */
async function getLibraryAssets(svc: Services, userId: string, ids: string[]) {
  const want = [...new Set(ids.filter(Boolean))].slice(0, LIBRARY_GET_MAX);
  if (!want.length) return { assets: [] as LibraryRow[] };
  const db = svc.database.db;
  const rows = await db.select().from(schema.assets).where(and(inArray(schema.assets.id, want), assetVisibleTo(userId)));
  const usage = await bumperUsageCounts(db, userId);
  return { assets: rows.map((r) => toLibraryItem(r, usage, userId)) };
}

/** A library row in the shape of a search hit, so one picker lists catalog, provider and own items alike. */
function libraryHit(r: LibraryRow) {
  return {
    provider: "library",
    externalId: r.id,
    kind: r.kind,
    mime: r.mime ?? undefined,
    name: r.name,
    previewUrl: `/media/assets/${r.id}`,
    thumbUrl: r.thumbnailUrl,
    durationSec: r.durationSec,
    width: r.width || undefined,
    height: r.height || undefined,
    license: r.provenance?.license ?? { id: "own", name: "Your upload" },
    attribution: r.provenance?.attribution,
    url: r.provenance?.url,
  };
}

/** What `library.add` answers for every source. */
interface AddedAsset extends ImportedAsset {
  mime: string | null;
  owner: "me" | "shared";
  thumbnailUrl: string;
}

function addedAsset(r: ImportedAsset, owner: "me" | "shared"): AddedAsset {
  return { ...r, mime: r.mime ?? null, owner, thumbnailUrl: r.kind === "audio" ? "" : `/media/assets/${r.id}/thumb.jpg` };
}

/** The user's library (docs/specs/library.md; started as intro/outro videos and images). Files arrive through POST /api/upload first. */
const libraryRouter = router({
    /** A page of live assets with how many projects use each (`items`, `nextCursor`, `total`), and the ones removed in the last 30 days (`deleted`, restorable). */
    list: protectedProcedure.input(listPageInput).query(({ ctx, input }) => libraryPage(ctx.svc, ctx.user.id, input ?? {})),
    /**
     * Rows these ids name that this account may read: its own uploads (removed ones included, so a clip that still
     * uses them has a name), and instance-shared catalog / provider imports. `library.list` does not include shared
     * rows; the editor looks them up here. Missing or foreign ids are omitted. At most 40 ids.
     */
    get: protectedProcedure.input(z.object({ ids: z.array(z.string().min(1).max(100)).max(LIBRARY_GET_MAX) })).query(({ ctx, input }) => getLibraryAssets(ctx.svc, ctx.user.id, input.ids)),
    /**
     * Every project and clip that uses an asset, and why: the project's default or override, or the clip's own
     * choice or layer. Reads `asset_refs` (indexed), then the few matched clips; clips a re-analyze replaced are skipped.
     */
    usage: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
      const db = ctx.svc.database.db;
      // an instance-shared row is readable by everyone; bumperAssetUsage only ever reports the caller's own projects
      const [asset] = await db.select({ id: schema.assets.id }).from(schema.assets).where(and(eq(schema.assets.id, input.id), assetVisibleTo(ctx.user.id)));
      if (!asset) throw new TRPCError({ code: "NOT_FOUND", message: "That item is not in your library" });
      return bumperAssetUsage(db, ctx.user.id, input.id);
    }),
    /** Rename a library item and/or change how long an image lasts (updateBumperAsset; also the rename_bumper tool). */
    update: protectedProcedure
      .input(z.object({ id: z.string().min(1).max(100), name: bumperNameSchema.optional(), imageSeconds: bumperSecondsSchema.optional(), tags: assetTagsSchema.optional() }))
      .mutation(({ ctx, input }) => updateBumperAsset(ctx.svc, ctx.user.id, input.id, { name: input.name, imageSeconds: input.imageSeconds, tags: input.tags })),
    /**
     * Add from exactly one source: an `uploadId` (POST /api/upload) or a public `url` (downloaded server-side) becomes
     * this account's library row; a catalog / provider result (`provider` + `externalId`) materializes one instance-shared
     * copy (not listed in this library). The file is probed and limited like every upload; `setDefault` also makes an
     * own upload the intro or outro.
     */
    add: protectedProcedure
      .input(
        z.object({
          uploadId: z.string().min(1).max(100).optional(),
          url: z.url().optional(),
          provider: z.string().min(1).max(40).optional(),
          externalId: z.string().min(1).max(200).optional(),
          color: z.string().max(9).optional(),
          imageSeconds: z.number().min(BUMPER_IMAGE_SEC.min).max(BUMPER_IMAGE_SEC.max).optional(),
          setDefault: z.enum(["intro", "outro"]).optional(),
          name: bumperNameSchema.optional(),
          tags: assetTagsSchema.optional(),
        }),
      )
      .mutation(async ({ ctx, input }): Promise<AddedAsset> => {
        try {
          requireOneSource(input);
        } catch (err) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : String(err) });
        }
        if (input.provider) {
          if (input.setDefault || input.imageSeconds) throw new TRPCError({ code: "BAD_REQUEST", message: "setDefault and imageSeconds apply to your own files; add the item first, then use setDefault" });
          const r = await importAsset(ctx.svc, ctx.user.id, { provider: input.provider, externalId: input.externalId!, color: input.color, tags: input.tags });
          return addedAsset(r, "shared");
        }
        const uploadId = input.uploadId ?? (await downloadAsUpload(ctx.svc, ctx.user.id, input.url!, { name: input.name }).then((d) => d.uploadId, (err) => asTrpc(err)));
        const created = await createAsset(ctx.svc, { uploadId, imageSeconds: input.imageSeconds, setDefault: input.setDefault, name: input.name, tags: input.tags, userId: ctx.user.id, actorId: ctx.user.id });
        return addedAsset(created, "me");
      }),
    /**
     * Find things to add or use. `source` "library" = your own library (name and tags, empty q = everything); omitted or
     * "catalog" = the Reelsaw catalog; otherwise a provider an admin enabled (see `providers`). Same hit shape for all.
     */
    search: protectedProcedure
      .input(
        z.object({
          q: z.string().max(200).default(""),
          source: z.string().min(1).max(40).optional().describe('"library", "catalog" (default) or a provider id'),
          kind: z.enum(["video", "image", "audio"]).optional(),
          cursor: z.string().max(200).optional(),
          limit: z.number().int().min(1).max(60).default(24),
          license: z.enum(["cc0", "by"]).optional(),
          /** library only: your deleted items (restorable with `restore`) instead of the live ones */
          deleted: z.boolean().optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const { source, deleted: _deleted, ...rest } = input;
        if (source !== "library") return catalogSearch(ctx.svc, { ...rest, provider: !source || source === "catalog" ? undefined : source });
        const q = input.q.trim().toLowerCase();
        const lib = await listLibrary(ctx.svc, ctx.user.id);
        const hits = (input.deleted ? lib.deleted : lib.assets).filter((r) => (!input.kind || r.kind === input.kind) && (!q || r.name.toLowerCase().includes(q) || r.tags.some((t) => t.toLowerCase().includes(q))));
        const from = input.cursor ? Math.max(0, Number(input.cursor) || 0) : 0;
        const page = hits.slice(from, from + input.limit);
        return { provider: "library", items: page.map(libraryHit), nextCursor: from + input.limit < hits.length ? String(from + input.limit) : undefined, unavailable: undefined as string | undefined };
      }),
    /** The sources search and add accept besides "library": the catalog and the providers an admin switched on. */
    providers: protectedProcedure.query(({ ctx }) => libraryProviders(ctx.svc).registry.list()),
    /** Make a library asset the user's default intro or outro for new projects (assetId null clears it). */
    setDefault: protectedProcedure.input(z.object({ slot: z.enum(["intro", "outro"]), assetId: z.string().min(1).max(100).nullable() })).mutation(async ({ ctx, input }) => {
      return ctx.svc.tx(async (u) => {
        await setBumperDefault(u.db, ctx.user.id, input.slot, input.assetId);
        return { ok: true };
      });
    }),
    /** Soft delete one of your uploads: hidden from the library and cleared from the defaults; projects that use it keep rendering with it. */
    delete: protectedProcedure.input(z.object({ id: z.string().min(1).max(100) })).mutation(async ({ ctx, input }) => {
      return ctx.svc.tx(async (u) => {
        const gone = await u.db
          .update(schema.assets)
          .set({ deletedAt: new Date() })
          .where(and(eq(schema.assets.id, input.id), eq(schema.assets.userId, ctx.user.id), isNull(schema.assets.deletedAt)))
          .returning({ id: schema.assets.id });
        if (!gone.length) throw new TRPCError({ code: "NOT_FOUND", message: "That item is not in your library" });
        for (const key of ["introAssetId", "outroAssetId"]) {
          await u.db.execute(sql`update user_settings set project_defaults = project_defaults - ${key}::text, updated_at = now() where user_id = ${ctx.user.id} and project_defaults ->> ${key}::text = ${input.id}`);
        }
        return { ok: true };
      });
    }),
    /** Undo a removal of one of your uploads. */
    restore: protectedProcedure.input(z.object({ id: z.string().min(1).max(100) })).mutation(({ ctx, input }) => restoreOwnedAsset(ctx.svc, ctx.user.id, input.id)),
    /** Remove an already-deleted library upload for good so its storage is freed. Refused while something still names it. */
    purge: protectedProcedure.input(z.object({ id: z.string().min(1).max(100) })).mutation(({ ctx, input }) => purgeOwnedAsset(ctx.svc, ctx.user.id, input.id)),
});

const restRouter = router({
  /** The Reelsaw catalog manifest (admins); search, providers and import are `library.*`. */
  catalog: router({
    status: adminProcedure.query(async ({ ctx }) => ({ ...(await libraryProviders(ctx.svc).catalog.status()), providers: libraryProviders(ctx.svc).registry.list() })),
    refresh: adminProcedure.mutation(async ({ ctx }) => {
      try {
        return (await libraryProviders(ctx.svc).catalog.refresh({ force: true })).status;
      } catch (err) {
        return asTrpc(err);
      }
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
        .input(z.object({ q: z.string().max(200).optional(), flagged: z.boolean().optional(), cursor: z.string().max(300).optional(), limit: z.number().int().min(1).max(100).default(50) }).optional())
        .query(async ({ ctx, input }) => {
          const db = ctx.svc.database.db;
          const limit = input?.limit ?? 50;
          const ws = words(input?.q ?? "");
          const U = schema.user;
          // flagged only: accounts the hourly abuse pass marked (abuse.ts)
          const onlyFlagged = input?.flagged ? sql`jsonb_array_length(${U.flags}) > 0` : undefined;
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
                  flags: U.flags,
                  signupIp: U.signupIp,
                  mustChangePassword: U.mustChangePassword,
                  createdAt: U.createdAt,
                  approved,
                  ts: sql<string>`${U.createdAt}::text`,
                })
                .from(U)
                .where(and(match, onlyFlagged, after))
                .orderBy(...(score ? [desc(score)] : []), approved, desc(U.createdAt), desc(U.id))
                .limit(pageSize + 1),
              tx.select({ total: sql<number>`count(*)::int` }).from(U).where(and(match, onlyFlagged)),
            ]);
          });
          const { items, nextCursor } = ws.length ? { items: fetched.slice(0, pageSize), nextCursor: null } : pageOf(fetched, limit, (r) => [r.approved, r.ts, r.id]);
          const ids = items.map((r) => r.id);
          const [usage, sessions, plans] = await Promise.all([
            usageByUser(db, null, ids),
            ids.length ? db.select({ userId: schema.session.userId, last: sql<Date>`max(${schema.session.updatedAt})` }).from(schema.session).where(inArray(schema.session.userId, ids)).groupBy(schema.session.userId) : [],
            ctx.svc.ee ? ctx.svc.ee.billing.plansOf(ids) : new Map<string, { plan: string; status: string }>(),
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
                /** the plan in force (ee); null when this instance has no plans */
                plan: ctx.svc.ee ? (plans.get(r.id)?.plan ?? "free") : null,
                approvedAt: r.approvedAt?.toISOString() ?? null,
                createdAt: r.createdAt.toISOString(),
                lastActive: last ? new Date(last).toISOString() : null,
              };
            }),
            nextCursor,
            total,
          };
        }),
      flaggedCount: adminProcedure.query(async ({ ctx }) => {
        const [{ n }] = await ctx.svc.database.db.select({ n: sql<number>`count(*)::int` }).from(schema.user).where(sql`jsonb_array_length(${schema.user.flags}) > 0 and not ${schema.user.banned}`);
        return n;
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
      /** One account's numbers: the instance values, the plan's, the overrides, what is in force and why, what is used now; plus the watermark decision. */
      limits: adminProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
        const db = ctx.svc.database.db;
        const [row, user] = await Promise.all([db.query.userSettings.findFirst({ where: eq(schema.userSettings.userId, input.id), columns: { limits: true, watermark: true } }), db.query.user.findFirst({ where: eq(schema.user.id, input.id), columns: { id: true, role: true } })]);
        if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "No such user" });
        const d = await limitsDetail(db, ctx.svc.settings.get(), input.id, ctx.svc.entitlements);
        const wm = await watermarkFor(db, ctx.svc.settings.get(), user, ctx.svc.entitlements);
        return {
          instance: Object.fromEntries(LIMIT_KEYS.map((k) => [k, ctx.svc.settings.get()[k]])) as Record<(typeof LIMIT_KEYS)[number], number>,
          plan: d.plan,
          planLimits: d.grants?.limits ?? {},
          overrides: row?.limits ?? {},
          effective: d.limits,
          source: d.source,
          usage: await limitUsage(db, input.id, d.grants),
          period: periodOf(d.grants),
          watermark: { override: row?.watermark ?? null, effective: wm.on, source: wm.source },
        };
      }),
      setLimits: adminProcedure
        .input(z.object({ id: z.string(), limits: z.partialRecord(z.enum(LIMIT_KEYS), z.number().int().min(0).nullable()) }))
        .mutation(({ ctx, input }) => setUserLimits(ctx.svc, ctx.user.id, input.id, input.limits)),
      /** true = always watermark, false = never, null = follow the plan and the instance setting */
      setWatermark: adminProcedure.input(z.object({ id: z.string(), watermark: z.boolean().nullable() })).mutation(({ ctx, input }) => setUserWatermark(ctx.svc, ctx.user.id, input.id, input.watermark)),
    }),
    /** Billing administration (ee): complimentary grants, and a re-read of Stripe for one account. */
    billing: router({
      setPlan: adminProcedure.input(z.object({ id: z.string(), plan: z.string().min(1).max(40).nullable() })).mutation(({ ctx, input }) => billingOf(ctx.svc).setComplimentary(ctx.user.id, input.id, input.plan)),
      sync: adminProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => billingOf(ctx.svc).reconcile({ userId: input.id })),
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
    /** Live processes (API / worker / combined) with specs and what they reported last. Same as Settings → System → Workers. */
    workers: router({
      list: adminProcedure.query(({ ctx }) => listWorkers(ctx.svc)),
    }),
    /** Waiting / running / retrying counts from pg-boss, plus the jobs in flight. Same as Settings → System → Queue. */
    queue: router({
      summary: adminProcedure.query(({ ctx }) => summarizeQueue(ctx.svc)),
    }),
    /** Failed projects and clips across the instance (durable app state). Retry goes through the same lifecycle as the owner Retry button. */
    failures: router({
      list: adminProcedure
        .input(
          z
            .object({
              q: z.string().max(200).optional(),
              stage: z.enum(FAILURE_STAGES).optional(),
              since: z.string().max(40).optional(),
              cursor: z.string().max(300).optional(),
              limit: z.number().int().min(1).max(50).optional(),
            })
            .optional(),
        )
        .query(({ ctx, input }) => listFailures(ctx.svc, input ?? {})),
      get: adminProcedure
        .input(z.object({ kind: z.enum(["project", "clip"]), id: z.string().min(1).max(80) }))
        .query(({ ctx, input }) => getFailure(ctx.svc, input.kind, input.id)),
      retry: adminProcedure
        .input(
          z.object({
            q: z.string().max(200).optional(),
            stage: z.enum(FAILURE_STAGES).optional(),
            since: z.string().max(40).optional(),
            ids: z.array(z.object({ kind: z.enum(["project", "clip"]), id: z.string().min(1).max(80) })).max(50).optional(),
            limit: z.number().int().min(1).max(50).optional(),
          }).optional(),
        )
        .mutation(({ ctx, input }) =>
          retryFailures(ctx.svc, { q: input?.q, stage: input?.stage, since: input?.since }, { id: ctx.user.id, email: ctx.user.email }, { ids: input?.ids, limit: input?.limit }),
        ),
    }),
  }),

  /**
   * Restorable deletes for the Deleted page: one newest-first list of projects, clips of live
   * projects, library items and templates, with auto-remove dates and stored bytes. Same payload as
   * MCP `list_deleted`. Restore / purge of a selection call the same services as the per-kind tools.
   */
  deleted: router({
    list: protectedProcedure.query(({ ctx }) => listDeleted(ctx.svc, ctx.user.id)),
    restore: protectedProcedure
      .input(z.object({ items: z.array(deletedItemRefSchema).min(1).max(200) }))
      .mutation(({ ctx, input }) => restoreDeleted(ctx.svc, actorOf(ctx.user), input.items)),
    purge: protectedProcedure
      .input(z.object({ items: z.array(deletedItemRefSchema).min(1).max(200), forgetDecisions: z.boolean().default(false) }))
      .mutation(({ ctx, input }) => purgeDeleted(ctx.svc, actorOf(ctx.user), input.items, { forgetDecisions: input.forgetDecisions })),
  }),

  /**
   * The decision log (docs/specs/decision-log.md): what the user accepted, rejected, cut and edited, kept after the
   * project is deleted so Reelsaw can learn from it. Settings → Learning, MCP list_decisions / export_decisions /
   * forget_decisions and `reelsaw decisions` call the same service.
   */
  decisions: router({
    summary: protectedProcedure.query(({ ctx }) => decisionSummary(ctx.svc.database.db, ctx.user.id)),
    list: protectedProcedure
      .input(z.object({ kind: z.enum(DECISION_KINDS).optional(), projectId: z.string().max(100).optional(), cursor: z.number().int().positive().optional(), limit: z.number().int().min(1).max(LIST_MAX).default(50) }))
      .query(({ ctx, input }) => listDecisions(ctx.svc.database.db, ctx.user.id, input)),
    export: protectedProcedure
      .input(z.object({ kind: z.enum(DECISION_KINDS).optional(), since: z.string().datetime({ offset: true }).optional(), cursor: z.number().int().positive().optional(), limit: z.number().int().min(1).max(EXPORT_MAX).default(200) }))
      .query(({ ctx, input }) => exportDecisions(ctx.svc.database.db, ctx.user.id, { ...input, since: input.since ? new Date(input.since) : undefined })),
    /** Forget one project's decisions (`projectId`, live or purged) or all of them. */
    forget: protectedProcedure.input(z.object({ projectId: z.string().min(1).max(100).optional() })).mutation(async ({ ctx, input }) => {
      const forgotten = await ctx.svc.tx((u) => forgetDecisions(u.db, ctx.user.id, input));
      ctx.log.info({ projectId: input.projectId ?? null, forgotten }, "decisions forgotten");
      return { ok: true as const, forgotten, message: forgotten ? `Forgot ${forgotten} decision${forgotten === 1 ? "" : "s"}.` : "Nothing to forget." };
    }),
    /** Turn recording on or off; what is already kept stays until forgotten. */
    setLearning: protectedProcedure.input(z.object({ enabled: z.boolean() })).mutation(({ ctx, input }) => setLearning(ctx.svc.database.db, ctx.user.id, input.enabled)),
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
        const keepDays = ctx.svc.settings.get().DELETED_RETENTION_DAYS;
        ctx.log.debug({ limit: input?.limit ?? 24, cursor: !!input?.cursor, status: input?.status ?? null, items: page.rows.length, hasMore: !!page.nextCursor, total: page.total }, "projects page");
        return {
          items: page.rows.map(({ p, ...card }) => ({
            ...publicProject(p),
            ...card,
            purgeAt: p.deletedAt && keepDays > 0 ? new Date(p.deletedAt.getTime() + keepDays * 86_400_000).toISOString() : null,
          })),
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
      const t = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, p.id), columns: { language: true, flags: true, refine: true } });
      // a refine step that gave up (optional work, the project went on without it) with the plain reason from its final stage.failed event
      const refineFailed: Array<{ step: string; error: string }> = [];
      for (const [step, status] of Object.entries(t?.refine ?? {})) {
        if (status !== "failed") continue;
        const [ev] = await db.select({ error: sql<string | null>`${schema.projectEvents.payload}->>'error'` }).from(schema.projectEvents).where(and(eq(schema.projectEvents.projectId, p.id), eq(schema.projectEvents.type, "stage.failed"), sql`${schema.projectEvents.payload}->>'step' = ${step}`)).orderBy(desc(schema.projectEvents.id)).limit(1);
        refineFailed.push({ step, error: ev?.error ?? "The step gave up after its retries." });
      }
      const transcript = t ? { language: t.language, flagCount: t.flags.length, pendingFlags: t.flags.filter((f) => f.status === "pending").length, refine: t.refine, refineFailed } : null;
      // expected seconds per stage once the source length is known (after ingest); learned from this instance's finished projects
      const models = currentModels(ctx.svc);
      const estimates = p.durationSec ? estimateStages(p.durationSec, models, await loadHistory(db), defaultFactors(models, localConfig(ctx.svc))) : null;
      const bumpers = (await projectBumperSummaries(db, ctx.user.id, [{ id: p.id, settings: p.settings, clips }])).get(p.id)!;
      // clips deleted or replaced by a re-analyze, restorable with clips.restore until the purge
      const replacedClips = (await deletedClips(db, p.id)).map((c) => ({ ...c, deletedAt: c.deletedAt!.toISOString() }));
      return { ...publicProject(p), clips: clips.map(publicClip), replacedClips, transcript, estimates, bumpers };
    }),

    create: protectedProcedure.input(createProjectInputSchema).mutation(async ({ ctx, input }) => publicProject(await createProject(ctx.svc, ctx.user.id, input))),

    /** The project transcript as an SRT / VTT file (one cue per segment; VTT can carry word times). */
    transcriptFile: protectedProcedure
      .input(z.object({ id: z.string(), format: z.enum(["srt", "vtt"]).default("srt"), words: z.boolean().optional() }))
      .query(({ ctx, input }) => projectTranscriptFile(ctx.svc, { id: ctx.user.id, admin: false }, input.id, input)),

    /** Use an SRT / VTT file as the transcript instead of transcribing; the project must be idle or just created. */
    importTranscript: protectedProcedure
      .input(z.object({ id: z.string(), uploadId: z.string().optional(), text: z.string().max(MAX_SUBTITLE_BYTES).optional(), format: z.enum(["auto", "srt", "vtt"]).default("auto"), language: z.string().trim().min(2).max(12).optional() }))
      .mutation(({ ctx, input }) => importTranscript(ctx.svc, { id: ctx.user.id, admin: false }, input.id, input)),

    /** Resume from the furthest completed stage; each stage skips work that already exists. */
    retry: protectedProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => retryOwnedProject(ctx.svc, { id: ctx.user.id, admin: false }, input.id)),

    /** Re-run some or all refine steps (names, disfluencies, scene cuts) on the existing transcript. */
    refine: protectedProcedure
      .input(z.object({ id: z.string(), ...refineInput }))
      .mutation(({ ctx, input }) => refineProject(ctx.svc, { id: ctx.user.id, admin: false }, input.id, input)),

    /** Hide or keep text burned into the source (captions, logos); re-renders finished clips. */
    setSourceText: protectedProcedure
      .input(z.object({ id: z.string(), sourceText: z.enum(["hide", "keep", "always"]) }))
      .mutation(({ ctx, input }) => setProjectSourceText(ctx.svc, { id: ctx.user.id, admin: false }, input.id, input.sourceText)),

    /**
     * Per-project intro/outro: for each slot "default" (the user's current default), "none" (even if the
     * default has one) or a library asset id. Re-renders every finished clip only when `rerender` is set.
     */
    setBumpers: protectedProcedure
      .input(projectBumpersInput.extend({ id: z.string() }))
      .mutation(({ ctx, input }) => setProjectBumpers(ctx.svc, { id: ctx.user.id, admin: false }, input.id, input)),

    /** oEmbed title/thumbnail for the new-project preview, before anything is created. */
    peek: protectedProcedure.input(z.object({ url: z.url() })).query(async ({ input }) => peekUrlMeta(input.url)),

    /**
     * Change the project-wide caption/hook style. Clears per-clip style overrides unless keepOverrides,
     * and re-renders every finished clip so the whole set stays consistent.
     */
    updateStyle: protectedProcedure
      .input(projectStyleInput.extend({ id: z.string() }))
      .mutation(({ ctx, input }) => updateProjectStyle(ctx.svc, { id: ctx.user.id, admin: false }, input.id, input)),

    /** Pick moments again on the same transcript. Clips the user made or edited stay; untouched AI picks are replaced (restorable). */
    reanalyze: protectedProcedure
      .input(z.object({ id: z.string(), settings: projectSettingsPatchSchema.optional() }))
      .mutation(({ ctx, input }) => reanalyzeProject(ctx.svc, { id: ctx.user.id, admin: false }, input.id, input.settings)),

    /** Title and settings without re-running anything (selection settings apply on the next reanalyze, style on the next render). */
    update: protectedProcedure
      .input(z.object({ id: z.string(), title: z.string().trim().min(1).max(200).optional(), settings: projectSettingsPatchSchema.optional(), clear: z.array(z.enum(CLEARABLE_SETTINGS)).max(CLEARABLE_SETTINGS.length).optional() }))
      .mutation(({ ctx, input }) => updateProject(ctx.svc, { id: ctx.user.id, admin: false }, input.id, input)),

    /** One framing (a section's mode and adjustment) for the whole project: set as the project's default, clips' own sections cleared, finished clips re-rendered. */
    applyFraming: protectedProcedure
      .input(z.object({ id: z.string(), reframe: sectionModeSchema, adjust: sectionAdjustSchema.optional(), keepOverrides: z.boolean().optional(), rerender: z.boolean().default(true) }))
      .mutation(({ ctx, input }) => applyProjectFraming(ctx.svc, { id: ctx.user.id, admin: false }, input.id, input)),

    /** Soft delete: hidden everywhere and its work stopped; restorable for DELETED_RETENTION_DAYS. Storage still counts until purge. */
    delete: protectedProcedure
      .input(z.object({ id: z.string(), forgetDecisions: z.boolean().default(false) }))
      .mutation(({ ctx, input }) => deleteOwnedProject(ctx.svc, { id: ctx.user.id, admin: false }, input.id, { forgetDecisions: input.forgetDecisions })),

    /** Undo a delete (the owner, or an admin for anyone's project). */
    restore: protectedProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => restoreProject(ctx.svc, actorOf(ctx.user), input.id)),

    /** Remove a deleted project for good: files go, storage is freed. Minutes already used stay counted. */
    purge: protectedProcedure
      .input(z.object({ id: z.string(), forgetDecisions: z.boolean().default(false) }))
      .mutation(({ ctx, input }) => purgeOwnedProject(ctx.svc, { id: ctx.user.id, admin: false }, input.id, { forgetDecisions: input.forgetDecisions })),

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

    /** Older events for the Activity panel: up to `limit` non-progress events with an id below `before` (omitted = the newest), oldest first. Same read as MCP get_project_events. */
    eventsPage: protectedProcedure.input(z.object({ id: z.string(), before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(500).default(200) })).query(async ({ ctx, input }) => {
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
        const decided: Array<{ before: TranscriptFlag; after: TranscriptFlag }> = [];
        const flags = t.flags.map((f) => {
          const d = input.decisions.find((x) => x.id === f.id);
          if (!d) return f;
          const replacement = d.replacement?.trim() || undefined;
          const wasApplied = f.status === "auto" || f.status === "accepted";
          const willApply = d.status === "accepted";
          const textChanged = willApply && (replacement ?? f.suggested) !== (f.replacement ?? f.suggested);
          if (d.status === f.status && !textChanged) return f;
          if (wasApplied !== willApply || textChanged) changed.push({ start: f.start, end: f.end });
          const next = { ...f, status: d.status, replacement };
          decided.push({ before: f, after: next });
          return next;
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
        // rejecting your own fix is deleting it: one fix.delete, like deleteFlag
        await recordDecisions(
          svc,
          db,
          p,
          () => fixDecisions(
            db,
            p.id,
            raw,
            decided.map(({ before, after }) =>
              before.subkind === "manual" && after.status === "rejected" ? { kind: "fix.delete" as const, flag: before, before, after: null } : { kind: after.status === "accepted" ? ("fix.accept" as const) : ("fix.reject" as const), flag: before, before, after },
            ),
          ),
        );
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
          await recordDecisions(ctx.svc, u.db, p, () => fixDecisions(u.db, p.id, t.rawWords ?? t.words, [{ kind: "fix.delete", flag: f, before: f, after: null }]));
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
        await recordDecisions(svc, u.db, p, () => fixDecisions(u.db, p.id, t.rawWords ?? t.words, [{ kind: "fix.restore", flag, before: null, after: flag }]));
        return { ok: true, rerendered };
        }),
      ),
  }),

  clips: router({
    /** The captions of the clip's last render as an SRT / VTT file (what was burned in; VTT can carry word times). */
    captions: protectedProcedure
      .input(z.object({ id: z.string(), format: z.enum(["srt", "vtt"]).default("srt"), words: z.boolean().optional() }))
      .query(({ ctx, input }) => clipCaptionsFile(ctx.svc, { id: ctx.user.id, admin: false }, input.id, input)),

    /**
     * Edit title/hook/caption/bounds/framing/style/emphasis/bumpers/layers. A burned-in change re-renders the clip unless
     * `rerender` is false. Answers the clip plus what changed and whether a re-render was needed and queued.
     */
    update: protectedProcedure
      .input(updateClipInput)
      .mutation(async ({ ctx, input }) => {
        const r = await updateClip(ctx.svc, { id: ctx.user.id, admin: false }, input);
        return { ...publicClip(r.clip), changed: r.changed, needsRerender: r.needsRerender, rerendered: r.rerendered };
      }),

    /**
     * Set the intro and/or outro of several clips at once. Per slot: "inherit" (follow the project), "none",
     * or a library asset id; a slot left out is untouched. One atomic JSON merge per slot, in one transaction,
     * with a render request per clip only when `rerender` is set.
     */
    setBumpersMany: protectedProcedure.input(clipBumpersManyInput).mutation(({ ctx, input }) => setClipBumpers(ctx.svc, { id: ctx.user.id, admin: false }, input)),

    /**
     * New clip from a transcript selection. mode "exact" keeps the bounds; "ai" searches inside them.
     * Metadata (and bounds for "ai") are filled in by the clip.prepare job, then it renders.
     */
    create: protectedProcedure.input(createClipInput).mutation(async ({ ctx, input }) => {
      const r = await createClip(ctx.svc, { id: ctx.user.id, admin: false }, input);
      return { ...publicClip(r.clip), queued: r.queued };
    }),

    /** Queue one clip to render again (a never-prepared clip is prepared first). */
    rerender: protectedProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => rerenderClip(ctx.svc, { id: ctx.user.id, admin: false }, input.id)),

    /** Soft-delete one clip; restorable with clips.restore until the purge (DELETED_RETENTION_DAYS). */
    delete: protectedProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => deleteClip(ctx.svc, { id: ctx.user.id, admin: false }, input.id)),

    /** Soft-delete several clips of one live project (the selection bar). Already-deleted ids are skipped. */
    deleteMany: protectedProcedure
      .input(z.object({ projectId: z.string(), clipIds: z.array(z.string()).min(1).max(200) }))
      .mutation(({ ctx, input }) => deleteClips(ctx.svc, { id: ctx.user.id, admin: false }, input.projectId, input.clipIds)),

    /** Bring back a deleted clip or one a re-analyze replaced (listed as replacedClips on projects.get). */
    restore: protectedProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => restoreClip(ctx.svc, actorOf(ctx.user), input.id)),

    /** Remove an already-deleted clip of a live project for good so its render is freed. */
    purge: protectedProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => purgeOwnedClip(ctx.svc, actorOf(ctx.user), input.id)),

    /**
     * Re-render several clips of a project at once (the selection bar, "Retry failed"). One transaction, one run:
     * finished and failed clips are queued; clips still rendering or never prepared are counted as skipped.
     */
    rerenderMany: protectedProcedure.input(rerenderManyInput).mutation(({ ctx, input }) => rerenderClips(ctx.svc, { id: ctx.user.id, admin: false }, input)),
  }),
});

/**
 * Layer templates (docs/specs/layer-templates.md): sets of layers placed by timing (head / tail / fill / relative) so one
 * template fits a clip of any length. `apply` materialises them into `clips.layers`; `fromClip` builds one from a clip.
 * Same service functions as the `*_layer_template` MCP tools and `reelsaw templates`.
 */
const layerTemplatesRouter = router({
  /** A page of the account's templates (`items`, `nextCursor`, `total`) plus the ones removed in the last 30 days (`deleted`). */
  list: protectedProcedure.input(listPageInput).query(({ ctx, input }) => listLayerTemplates(ctx.svc.database.db, ctx.user.id, input ?? {})),
  get: protectedProcedure.input(z.object({ id: templateIdSchema })).query(async ({ ctx, input }) => publicTemplate(await getLayerTemplate(ctx.svc.database.db, ctx.user.id, input.id))),
  create: protectedProcedure.input(z.object({ name: layerTemplateNameSchema, layers: layerTemplateLayersSchema })).mutation(({ ctx, input }) => createLayerTemplate(ctx.svc, ctx.user.id, input)),
  update: protectedProcedure.input(z.object({ id: templateIdSchema, name: layerTemplateNameSchema.optional(), layers: layerTemplateLayersSchema.optional() })).mutation(({ ctx, input }) => updateLayerTemplate(ctx.svc, ctx.user.id, input.id, { name: input.name, layers: input.layers })),
  delete: protectedProcedure.input(z.object({ id: templateIdSchema })).mutation(({ ctx, input }) => removeLayerTemplate(ctx.svc, ctx.user.id, input.id)),
  restore: protectedProcedure.input(z.object({ id: templateIdSchema })).mutation(({ ctx, input }) => restoreLayerTemplate(ctx.svc, ctx.user.id, input.id)),
  /** Hard-delete a removed template (no media files). */
  purge: protectedProcedure.input(z.object({ id: templateIdSchema })).mutation(({ ctx, input }) => purgeLayerTemplate(ctx.svc, ctx.user.id, input.id)),
  /** A new template from one clip's layers: a layer that spans the clip fills, the rest anchor to the nearer edge with their length. */
  fromClip: protectedProcedure.input(z.object({ clipId: z.string(), name: layerTemplateNameSchema })).mutation(({ ctx, input }) => layerTemplateFromClip(ctx.svc, ctx.user.id, input)),
  /** Materialise a template on clips of one project (all of them, or `clipIds`), replacing or adding to their layers. (`apply` is a word tRPC reserves.) */
  applyToClips: protectedProcedure.input(z.object(applyLayerTemplateInput)).mutation(({ ctx, input }) => applyLayerTemplate(ctx.svc, ctx.user.id, input)),
});

export const appRouter = mergeRouters(headRouter, router({ library: libraryRouter, layerTemplates: layerTemplatesRouter }), restRouter);
export type AppRouter = typeof appRouter;
