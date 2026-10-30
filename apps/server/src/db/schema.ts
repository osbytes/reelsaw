import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, boolean, integer, real, jsonb, bigserial, bigint, numeric, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";
import type {
  ProjectSettings,
  UserProjectDefaults,
  ProjectStatus,
  RunReason,
  ClipStatus,
  Word,
  TranscriptSegment,
  ProjectEventType,
  ReframeMode,
  TranscriptFlag,
  RefineStatus,
  LayoutSection,
  DetectedSegment,
  StyleOverride,
  ClipScores,
  ClipOrigin,
  ClipDiagnostics,
  ClipBumpers,
  ClipOverlay,
  ClipAudio,
  ClipLayer,
  TemplateLayer,
  AssetProvenance,
  RenderedCaptions,
  SourceOverlay,
  TextProfile,
  DecisionKind,
  SourceRef,
} from "@reelsaw/shared";

export const USER_ROLES = ["user", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

// ---------- Better Auth core tables ----------

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    /** admin: sees system settings and manages users. The first account is admin. */
    role: text("role").$type<UserRole>().default("user").notNull(),
    /** null = waiting for an admin (SIGNUP_MODE=approval). */
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    banned: boolean("banned").default(false).notNull(),
    banReason: text("ban_reason"),
    /** one key per real mailbox (abuse.ts `emailKey`); unique, so `a.b+x@gmail.com` cannot register twice */
    emailKey: text("email_key"),
    /** the address the sign-up came from (behind the proxy's headers); null when unknown */
    signupIp: text("signup_ip"),
    /** abuse flags computed hourly (abuse.ts); shown on the Users page, never acted on automatically */
    flags: jsonb("flags").$type<string[]>().notNull().default([]),
    /** operator set a temporary password (`reelsaw set-password --must-change`); the account must choose theirs before using the app */
    mustChangePassword: boolean("must_change_password").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    // admin Users search: ILIKE '%q%' and word similarity on name and email
    index("user_name_trgm_idx").using("gin", t.name.op("gin_trgm_ops")),
    index("user_email_trgm_idx").using("gin", t.email.op("gin_trgm_ops")),
    uniqueIndex("user_email_key_idx").on(t.emailKey),
    index("user_signup_ip_idx").on(t.signupIp, t.createdAt),
  ],
);

/** Per-account request counter for the mutation rate limit (abuse.ts `checkRequestRate`): one row per user and minute, pruned hourly. */
export const userRate = pgTable(
  "user_rate",
  {
    userId: text("user_id").notNull(),
    bucket: timestamp("bucket", { withTimezone: true }).notNull(),
    n: integer("n").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.bucket] })],
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// ---------- App tables ----------

/** Better Auth api-key plugin (@better-auth/api-key): bearer tokens for the MCP server and the HTTP API. */
export const apikey = pgTable(
  "apikey",
  {
    id: text("id").primaryKey(),
    configId: text("config_id").notNull().default("default"),
    name: text("name"),
    start: text("start"),
    prefix: text("prefix"),
    key: text("key").notNull(),
    referenceId: text("reference_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: timestamp("last_refill_at"),
    enabled: boolean("enabled").default(true).notNull(),
    rateLimitEnabled: boolean("rate_limit_enabled").default(true).notNull(),
    rateLimitTimeWindow: integer("rate_limit_time_window"),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count").default(0).notNull(),
    remaining: integer("remaining"),
    lastRequest: timestamp("last_request"),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (t) => [index("apikey_reference_id_idx").on(t.referenceId), index("apikey_key_idx").on(t.key)],
);

/** Account-level audit trail: sign-ups, approvals, role changes, bans, model changes (admin page, email). */
export const ADMIN_EVENT_TYPES = [
  "user.signed_up",
  "user.approved",
  "user.role_changed",
  "user.limits_changed",
  "user.watermark_changed",
  "user.flagged",
  "user.banned",
  "user.unbanned",
  "user.removed",
  "user.password_set",
  "models.changed",
  "provider.changed",
  "settings.changed",
  "failures.retried",
  // billing (ee/): written by the subscription sync, never by a webhook handler directly
  "billing.subscribed",
  "billing.changed",
  "billing.payment_failed",
  "billing.canceled",
  "billing.complimentary",
  "billing.unknown_price",
] as const;
export type AdminEventType = (typeof ADMIN_EVENT_TYPES)[number];
export const adminEvents = pgTable(
  "admin_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    type: text("type").$type<AdminEventType>().notNull(),
    /** who did it; null = the system (sign-up, auto-approval) */
    actorId: text("actor_id"),
    /** the account it concerns; kept after the user row is deleted */
    userId: text("user_id").notNull(),
    email: text("email").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("admin_events_user_id_idx").on(t.userId, t.id)],
);
export type AdminEventRow = typeof adminEvents.$inferSelect;

/** One row per language-model call, for usage per user (tokens, latency). Written by the LLM middleware. */
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id"),
    projectId: text("project_id"),
    stage: text("stage"),
    call: text("call"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    ms: integer("ms").notNull().default(0),
    ok: boolean("ok").notNull().default(true),
    /** USD the provider reported for the call (AI Gateway does); null when it did not say */
    costUsd: numeric("cost_usd", { precision: 14, scale: 8, mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("llm_usage_user_id_idx").on(t.userId, t.createdAt)],
);

/**
 * One row per project that used minutes: written at create, duration filled at ingest. Survives project
 * delete and purge so monthly minutes, first-video-free and admin usage cannot be reset by deleting.
 * Not pruned by time: first-video-free reads the account's earliest row, so a retention cut would hand out a
 * second free video (and a cut shorter than a billing period would undercount minutes). One small row per
 * project ever created; the rows go with the account (`removeUser`).
 */
export const sourceUsage = pgTable(
  "source_usage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id").notNull(),
    /** the project that consumed the minutes; no FK, so a purge of the project keeps this row */
    projectId: text("project_id").notNull(),
    /** null until ingest knows the length; minutes only count once it is set */
    durationSec: real("duration_sec"),
    /** when the project was created (the window minutes and hourly creates count in) */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("source_usage_project_idx").on(t.projectId), index("source_usage_user_id_idx").on(t.userId, t.createdAt)],
);

/**
 * One row per speech-to-text call that reached a provider (cache hits are free and not written), for usage per
 * user: seconds of audio transcribed. Written by the asr hook in services.ts; pruned with llm_usage.
 */
export const sttUsage = pgTable(
  "stt_usage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id"),
    projectId: text("project_id"),
    stage: text("stage"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    audioSec: real("audio_sec").notNull().default(0),
    ms: integer("ms").notNull().default(0),
    ok: boolean("ok").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("stt_usage_user_id_idx").on(t.userId, t.createdAt)],
);

/**
 * Instance-wide settings an admin changes at runtime, one row per key; absent = the environment.
 * `models`: `{ language?, transcription?, align? }` model ids that override AI_MODEL,
 * TRANSCRIPTION_MODEL and TRANSCRIPT_ALIGN_MODEL (see ai/models.ts). Keys never live here.
 */
export const instanceSettings = pgTable("instance_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type InstanceSettingsRow = typeof instanceSettings.$inferSelect;

/**
 * Provider credentials an admin entered in Settings (ai/providers.ts). The key is encrypted with a
 * key derived from BETTER_AUTH_SECRET (ai/crypto.ts) and never leaves the server; the UI only sees
 * its last characters. A row overrides the environment for that provider; absent = the environment.
 */
export const providerSettings = pgTable("provider_settings", {
  provider: text("provider").primaryKey(),
  apiKeyEnc: text("api_key_enc"),
  /** last 4 characters, for the UI */
  apiKeyHint: text("api_key_hint"),
  baseUrl: text("base_url"),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type ProviderSettingsRow = typeof providerSettings.$inferSelect;

/** Per-user settings. One row per user, created on first write; absent = defaults. */
export const userSettings = pgTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** applied under the built-in defaults and over-ridden by what the new-project form sends */
  projectDefaults: jsonb("project_defaults").$type<UserProjectDefaults>().notNull().default({}),
  /** admin-set overrides of the instance quotas (hosted); keys match the MAX_* settings */
  limits: jsonb("limits").$type<Record<string, number>>().notNull().default({}),
  /** admin's per-user watermark decision: true / false; null = follow the plan and the instance setting (quota.ts `watermarkFor`) */
  watermark: boolean("watermark"),
  /** record this user's accepts, rejects and edits in user_decisions (decisions/service.ts); off stops recording, keeps what exists */
  learnFromDecisions: boolean("learn_from_decisions").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type UserSettingsRow = typeof userSettings.$inferSelect;

export const uploads = pgTable(
  "uploads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    storageKey: text("storage_key").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("uploads_user_id_idx").on(t.userId)],
);

/**
 * The user's library: intros / outros, logos, stickers, b-roll, music and sound effects. Immutable: replacing
 * one is a new row, so a cache keyed by id is correct and a clip's diagnostics say exactly which version it
 * used. Soft-deleted rows still resolve at render time so projects that snapshotted the id keep working.
 * Storage keys are stored in full (`source_key`), so rows made before the rename keep their `bumpers/<id>/…`
 * objects and new rows write `assets/<id>/…`.
 */
export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    /** the account that uploaded it; null = an instance-shared row (imported from the catalog or a provider, visible to every account) */
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"video" | "image" | "audio">().notNull().default("video"),
    /** exact format (image/svg+xml, image/gif, video/mp4, audio/mpeg…); null for rows made before it existed */
    mime: text("mime"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    /** where an imported item came from and its license; null for the user's own uploads */
    provenance: jsonb("provenance").$type<AssetProvenance>(),
    /** came from the Reelsaw catalog (shown with a badge; otherwise an ordinary row) */
    system: boolean("system").notNull().default(false),
    name: text("name").notNull(),
    durationSec: real("duration_sec").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    hasAudio: boolean("has_audio").notNull(),
    sourceKey: text("source_key").notNull(),
    /** 270x480 jpg for pickers and cards; null until generated (made lazily for older assets) */
    thumbnailKey: text("thumbnail_key"),
    sizeBytes: integer("size_bytes").notNull(),
    /** sha256 of the uploaded file, to refuse duplicates; null for assets added before it existed (no backfill) */
    contentHash: text("content_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("assets_user_idx").on(t.userId),
    index("assets_hash_idx").on(t.userId, t.contentHash),
    // the hourly purge looks for removed assets across all users
    index("assets_deleted_idx").on(t.deletedAt).where(sql`${t.deletedAt} is not null`),
    // one instance-shared row per catalog / provider item (and Iconify colour), however many accounts import it
    uniqueIndex("assets_shared_source_idx")
      .on(sql`(${t.provenance}->>'provider')`, sql`(${t.provenance}->>'externalId')`, sql`coalesce(${t.provenance}->>'variant', '')`)
      .where(sql`${t.userId} is null and ${t.deletedAt} is null`),
  ],
);
export type Asset = typeof assets.$inferSelect;
/** @deprecated use Asset */
export type LibraryAsset = Asset;

/**
 * Which library assets a project or clip uses, and how, maintained in the same transaction as the write
 * that changed `clips.layers`, `clips.bumpers` or the project's intro/outro settings. "Used by N", the
 * purge's "still referenced" test and the credits list read this instead of scanning jsonb.
 */
export const assetRefs = pgTable(
  "asset_refs",
  {
    assetId: text("asset_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** null = the project's own settings name the asset */
    clipId: text("clip_id").references(() => clips.id, { onDelete: "cascade" }),
    role: text("role").$type<"intro" | "outro" | "layer">().notNull(),
  },
  (t) => [index("asset_refs_asset_idx").on(t.assetId), index("asset_refs_project_idx").on(t.projectId), index("asset_refs_clip_idx").on(t.clipId)],
);
export type AssetRef = typeof assetRefs.$inferSelect;

/**
 * Layer templates: a named set of layers whose windows are placed by a timing mode (head / tail / fill /
 * relative) instead of absolute seconds, so one template fits a 15 s clip and a 90 s clip (docs/specs/layer-templates.md).
 * Applying one materialises ordinary `clips.layers`; the template itself is never read at render time.
 * Removal is a soft delete, restorable from Deleted or `restore_layer_template`.
 */
export const layerTemplates = pgTable(
  "layer_templates",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** the layers with their timing (TemplateLayer[], max MAX_CLIP_LAYERS) */
    layers: jsonb("layers").$type<TemplateLayer[]>().notNull().default([]),
    /** intro / outro applied with the layers (clip-bumper shape; a missing slot leaves the clip's own); null = none */
    bumpers: jsonb("bumpers").$type<ClipBumpers>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("layer_templates_user_idx").on(t.userId, t.updatedAt)],
);
export type LayerTemplate = typeof layerTemplates.$inferSelect;

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sourceType: text("source_type").$type<"url" | "upload">().notNull(),
    sourceUrl: text("source_url"),
    sourceKey: text("source_key"),
    sourceMeta: jsonb("source_meta").$type<Record<string, unknown>>(),
    durationSec: real("duration_sec"),
    width: integer("width"),
    height: integer("height"),
    status: text("status").$type<ProjectStatus>().notNull().default("queued"),
    /** size of the stored source, for usage; null until ingested or after retention removed it */
    sourceBytes: bigint("source_bytes", { mode: "number" }),
    /** when retention deleted the stored source (row kept; Retry re-fetches) */
    sourceExpiredAt: timestamp("source_expired_at", { withTimezone: true }),
    stage: text("stage"),
    stageProgress: real("stage_progress"),
    /** checkpointed stages: units done, total, seconds left (remaining x rolling median unit time) and that median in ms; null when the stage is not made of steps */
    stageDetail: jsonb("stage_detail").$type<{ done: number; total: number; etaSec: number | null; unitMs: number | null }>(),
    /** explicit runs (see pipeline/lifecycle.ts startRun): how many have started, when and why the current/last one did */
    runSeq: integer("run_seq").notNull().default(0),
    runStartedAt: timestamp("run_started_at", { withTimezone: true }),
    runReason: text("run_reason").$type<RunReason>(),
    /**
     * Version of the project's stage work (ingest → analyze), like clips.render_gen: bumped when a retry, re-analyze,
     * refine or delete supersedes it. Stage jobs carry it and commit only while it is current (see pipeline/common.ts).
     */
    stageSeq: integer("stage_seq").notNull().default(0),
    /** times the reconciler re-enqueued this project's lost job since the last user start or retry; past the limit it fails the project (queue/reconcile.ts) */
    reconcileRequeues: integer("reconcile_requeues").notNull().default(0),
    /** when the stage now running began; stage.completed / stage.failed durations come from it */
    stageStartedAt: timestamp("stage_started_at", { withTimezone: true }),
    error: text("error"),
    settings: jsonb("settings").$type<ProjectSettings>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    /** soft delete: hidden everywhere, restorable until the purge (DELETED_RETENTION_DAYS) removes the row and its files */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** the owner asked, when deleting it, to forget its decisions too: every purge (theirs or the retention sweep) does; a restore clears it */
    forgetDecisionsOnPurge: boolean("forget_decisions_on_purge").notNull().default(false),
  },
  (t) => [
    // the hourly purge looks for deleted projects across all users
    index("projects_deleted_idx").on(t.deletedAt).where(sql`${t.deletedAt} is not null`),
    index("projects_user_id_idx").on(t.userId, t.createdAt),
    // searchIndex and "recently updated" lists
    index("projects_user_updated_idx").on(t.userId, t.updatedAt),
    // the reconciler and the stall watchdog look up projects by `status in (<working states>)`
    index("projects_status_idx").on(t.status),
    // source retention (every reconciler tick when enabled)
    index("projects_source_retention_idx").on(t.updatedAt).where(sql`${t.sourceKey} is not null and ${t.sourceExpiredAt} is null`),
    // palette search (`search`): ILIKE '%q%' on the title
    index("projects_title_trgm_idx").using("gin", t.title.op("gin_trgm_ops")),
  ],
);

export const transcriptChunks = pgTable(
  "transcript_chunks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    offsetSec: real("offset_sec").notNull(),
    language: text("language"),
    text: text("text").notNull(),
    segments: jsonb("segments").$type<TranscriptSegment[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("transcript_chunks_project_index_idx").on(t.projectId, t.index)],
);

/**
 * Durable checkpoints of a pipeline stage (pipeline/steps.ts, `ctx.step`): one row per unit of work (a map window,
 * a scoring batch). The key hashes the unit's content, model, prompt version and parameters, so a retry, or a
 * re-run with the same inputs, reuses the row and a changed input misses. Cascades with the project; the hourly
 * sweep drops the rows of finished projects after STEP_RETENTION_DAYS.
 */
export const jobSteps = pgTable(
  "job_steps",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** set for clip-scoped steps (prepare); null for project stages */
    clipId: text("clip_id"),
    stage: text("stage").notNull(),
    name: text("name").notNull(),
    key: text("key").notNull(),
    status: text("status").$type<"done" | "failed">().notNull(),
    /** bounded JSON only; validated with the caller's schema on read */
    output: jsonb("output"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** the projects.stage_seq that wrote it: diagnostics, not part of the key */
    stageSeq: integer("stage_seq").notNull(),
    ms: integer("ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.stage, t.name, t.key] }), index("job_steps_project_stage_idx").on(t.projectId, t.stage)],
);

export const transcripts = pgTable("transcripts", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  language: text("language"),
  text: text("text").notNull(),
  words: jsonb("words").$type<Word[]>().notNull(),
  /** words exactly as the transcriber returned them; `words` is this with accepted flags applied */
  rawWords: jsonb("raw_words").$type<Word[]>(),
  flags: jsonb("flags").$type<TranscriptFlag[]>().notNull().default([]),
  /** soft-deleted fixes, newest last; kept out of `flags` so nothing downstream applies them. Restorable. */
  /** how text-heavy the source is (slides, documents); presentations skip masking by default */
  textProfile: jsonb("text_profile").$type<TextProfile>(),
  deletedFlags: jsonb("deleted_flags").$type<Array<TranscriptFlag & { deletedAt: string }>>().notNull().default([]),
  entities: jsonb("entities").$type<string[]>().notNull().default([]),
  /** per-step status of the refine stage (entities / disfluency / scenes) */
  refine: jsonb("refine").$type<RefineStatus>().notNull().default({}),
  segments: jsonb("segments").$type<TranscriptSegment[]>().notNull(),
  sceneCuts: jsonb("scene_cuts").$type<number[]>(),
  /** captions / watermarks burned into the source video */
  overlays: jsonb("overlays").$type<SourceOverlay[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const clips = pgTable(
  "clips",
  {
    id: text("id").primaryKey(),
    /** bumped on every render request; a render only commits if its generation is still current */
    renderGen: integer("render_gen").notNull().default(0),
    /** times the reconciler re-enqueued this clip's lost job since the last render or prepare request; past the limit it fails the clip (queue/reconcile.ts) */
    reconcileRequeues: integer("reconcile_requeues").notNull().default(0),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    title: text("title").notNull(),
    hook: text("hook").notNull(),
    startSec: real("start_sec").notNull(),
    endSec: real("end_sec").notNull(),
    score: real("score").notNull(),
    reasoning: text("reasoning").notNull(),
    caption: text("caption").notNull().default(""),
    hashtags: jsonb("hashtags").$type<string[]>().notNull(),
    layoutOverride: text("layout_override").$type<ReframeMode>(),
    status: text("status").$type<ClipStatus>().notNull().default("pending"),
    origin: text("origin").$type<ClipOrigin>().notNull().default("ai"),
    error: text("error"),
    outputKey: text("output_key"),
    /** size of the rendered file at output_key, for the per-user storage total (null: rendered before it was kept) */
    outputBytes: bigint("output_bytes", { mode: "number" }),
    /** the last render burned the instance watermark in (quota.ts `watermarkFor` at render time); a re-render after an upgrade clears it */
    watermark: boolean("watermark").notNull().default(false),
    thumbnailKey: text("thumbnail_key"),
    layout: text("layout"),
    layoutInfo: jsonb("layout_info").$type<{ reason: string; faceRatio: number; faceSize: number }>(),
    /** User-forced framing per section (absolute source seconds). Empty/null = all auto. */
    layoutSections: jsonb("layout_sections").$type<LayoutSection[]>(),
    /** Framing the last render actually used per piece, for the editor timeline and preview. */
    layoutSegments: jsonb("layout_segments").$type<DetectedSegment[]>(),
    /** What the last render did (cuts applied/skipped with reasons, layout, timing). */
    diagnostics: jsonb("diagnostics").$type<ClipDiagnostics>(),
    /** Rubric sub-scores behind `score`. */
    scores: jsonb("scores").$type<ClipScores>(),
    /** Key words the captions emphasise (AI-picked, user-editable). */
    emphasis: jsonb("emphasis").$type<string[]>(),
    /** Per-clip caption/hook style override on top of the project settings. */
    style: jsonb("style").$type<StyleOverride>(),
    /** user decision per slot: missing key = inherit the project, null = none, string = that library asset (survives pipeline re-runs) */
    bumpers: jsonb("bumpers").$type<ClipBumpers>(),
    /** library images/videos laid over the clip for a time range (logos, stickers, b-roll); null = none */
    overlays: jsonb("overlays").$type<ClipOverlay[]>(),
    /** background music under parts of the clip (library audio tracks, ducked under speech); null = none. Read through `clipAudioList` (older rows hold one object). */
    audio: jsonb("audio").$type<ClipAudio[]>(),
    /** everything laid over or played under the clip (assets, text, sounds), replacing `overlays` + `audio`; null = read those (see `clipLayers`) */
    layers: jsonb("layers").$type<ClipLayer[]>(),
    /** the caption lines the last render burned in, in the rendered video's seconds, for SRT / VTT export */
    captions: jsonb("captions").$type<RenderedCaptions>(),
    /** last time the user edited the clip (clips.update); an edited clip survives a re-analyze */
    editedAt: timestamp("edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    /** soft delete (a re-analyze replaced it): hidden, restorable until the purge (DELETED_RETENTION_DAYS) */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // the hourly purge looks for replaced clips across all users
    index("clips_deleted_idx").on(t.deletedAt).where(sql`${t.deletedAt} is not null`),
    index("clips_project_id_idx").on(t.projectId, t.index),
    // clip retention (every reconciler tick when enabled)
    index("clips_retention_idx").on(t.updatedAt).where(sql`${t.outputKey} is not null and ${t.status} = 'done'`),
    // palette search (`search`): ILIKE '%q%' on title, hook and caption
    index("clips_title_trgm_idx").using("gin", t.title.op("gin_trgm_ops")),
    index("clips_hook_trgm_idx").using("gin", t.hook.op("gin_trgm_ops")),
    index("clips_caption_trgm_idx").using("gin", t.caption.op("gin_trgm_ops")),
  ],
);

export const projectEvents = pgTable(
  "project_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").$type<ProjectEventType>().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("project_events_project_id_idx").on(t.projectId, t.id)],
);

export type Project = typeof projects.$inferSelect;
export type Clip = typeof clips.$inferSelect;
export type Transcript = typeof transcripts.$inferSelect;
export type ProjectEventRow = typeof projectEvents.$inferSelect;

/**
 * What a pipeline stage decided and why, for diagnosis and issue reports: e.g. every candidate
 * moment with its scores and the filter that dropped it. Written in the stage's unit of work.
 * `models` records what actually ran (config at report time may differ).
 */
export const stageArtifacts = pgTable(
  "stage_artifacts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    stage: text("stage").notNull(),
    /** what the data is, within the stage (e.g. "candidates", "disfluency") */
    kind: text("kind").notNull(),
    models: jsonb("models").$type<Record<string, string>>().notNull().default({}),
    data: jsonb("data").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("stage_artifacts_project_id_idx").on(t.projectId, t.id)],
);

/**
 * Append-only log of what users decided about the pipeline's output (docs/specs/decision-log.md): accepted, rejected,
 * deleted and manual fixes, clip edits, deletes and re-picks, each with the before/after values and enough context
 * to judge it without the project. `project_id` / `clip_id` are deliberately not foreign keys: decisions outlive
 * the project ("Delete forever" keeps them unless the user asks to forget). Written in the action's unit of work
 * (`recordDecisions`); pruned after DECISION_RETENTION_DAYS (events-retention.ts).
 */
export const userDecisions = pgTable(
  "user_decisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull(),
    clipId: text("clip_id"),
    kind: text("kind").$type<DecisionKind>().notNull(),
    /** a person chose it (false: inferred, e.g. a clip a re-analyze replaced) */
    explicit: boolean("explicit").notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    context: jsonb("context").$type<Record<string, unknown>>().notNull(),
    models: jsonb("models").$type<Record<string, string>>().notNull().default({}),
    source: jsonb("source").$type<SourceRef>().notNull(),
    appVersion: text("app_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("user_decisions_user_idx").on(t.userId, t.id),
    index("user_decisions_user_kind_idx").on(t.userId, t.kind, t.id),
    index("user_decisions_project_idx").on(t.projectId, t.id),
  ],
);
export type UserDecision = typeof userDecisions.$inferSelect;

export * from "./oauth-schema.js";

// ---------- Enterprise edition (apps/server/src/ee, loaded with REELSAW_EE=true) ----------
// The tables exist on every install so there is one schema and one migration history (Cal.com, PostHog do the
// same); self-hosted they stay empty and nothing reads them.

/** One Stripe customer per account, created at the first checkout (ee/billing/service.ts). */
export const billingCustomers = pgTable("billing_customers", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Stripe's subscription statuses plus `complimentary` (an admin granted the plan without Stripe). */
export const BILLING_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
  "incomplete_expired",
  "paused",
  "complimentary",
] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];
export type BillingInterval = "month" | "year";

/**
 * The account's subscription as last read from Stripe (the source of truth): a cache the `billing.sync` job
 * rewrites whole from `subscriptions.retrieve`, never patched from a webhook payload, so events arriving out of
 * order or twice converge on Stripe's state. One row per account.
 */
export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    /** null = complimentary (no Stripe subscription behind it) */
    stripeSubscriptionId: text("stripe_subscription_id").unique(),
    stripeCustomerId: text("stripe_customer_id"),
    /** Stripe's `created`; when two live subscriptions exist for one account the newer one owns the row */
    stripeCreated: timestamp("stripe_created", { withTimezone: true }),
    /** plan name from ee/billing/plans.ts, resolved from the price's lookup key */
    plan: text("plan").notNull(),
    status: text("status").$type<BillingStatus>().notNull(),
    interval: text("interval").$type<BillingInterval>(),
    priceId: text("price_id"),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    /** first time the status became past_due; the grace period (BILLING_GRACE_DAYS) counts from here */
    pastDueSince: timestamp("past_due_since", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** when the row was last rewritten from Stripe */
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("billing_subscriptions_customer_idx").on(t.stripeCustomerId)],
);
export type BillingSubscriptionRow = typeof billingSubscriptions.$inferSelect;

/**
 * Every Stripe webhook event, keyed by Stripe's event id: the insert is the idempotency check (a redelivery
 * conflicts and is acknowledged without a second job). Written in the same transaction as the `billing.sync`
 * job it enqueues, so an acknowledged event always has its job. `processed_at` is set by the sync that
 * read Stripe after it; a pending row older than an hour is picked up by the daily reconcile.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    /** the Stripe subscription the event concerns, when it has one */
    subscriptionId: text("subscription_id"),
    /** Stripe's event time */
    created: timestamp("created", { withTimezone: true }).notNull(),
    /** the event's object as Stripe sent it, for forensics; never read to decide state */
    payload: jsonb("payload").$type<unknown>().notNull().default({}),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => [
    index("billing_events_subscription_idx").on(t.subscriptionId, t.created),
    index("billing_events_pending_idx").on(t.receivedAt).where(sql`processed_at is null`),
  ],
);
export type BillingEventRow = typeof billingEvents.$inferSelect;

/** What this process can use a GPU for; stored on each heartbeat so the admin page can show it without asking the box. */
export type WorkerGpu = { vendor: string; devices: string[]; note: string };
export type WorkerRenders = { running: number; limit: number; max: number; mode: "auto" | "fixed" };
export type WorkerJob = { jobId: string; queue: string; projectId: string; clipId?: string; startedAt: string };
export const WORKER_ROLES = ["app", "api", "worker"] as const;
export type WorkerRole = (typeof WORKER_ROLES)[number];

/**
 * One row per live process (API, worker, or combined app). Heartbeat in ops/workers.ts upserts
 * every 15 s; rows last-seen more than 45 s ago are stale, and ones older than an hour are pruned.
 * Identity is WORKER_ID, or `hostname:pid` when unset.
 */
export const workerInstances = pgTable(
  "worker_instances",
  {
    id: text("id").primaryKey(),
    role: text("role").$type<WorkerRole>().notNull(),
    hostname: text("hostname").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    version: text("version").notNull(),
    commit: text("commit").notNull(),
    pid: integer("pid").notNull(),
    cpus: integer("cpus").notNull(),
    memTotalMB: integer("mem_total_mb").notNull(),
    /** -1 when this filesystem cannot report free space (same as ResourceSnapshot) */
    diskFreeMB: integer("disk_free_mb").notNull().default(-1),
    diskTotalMB: integer("disk_total_mb").notNull().default(0),
    /** the filesystem DATA_DIR is on (the `.volume-id` marker, disk-leases.ts); processes sharing it share disk leases */
    volume: text("volume"),
    /** MB leased to jobs in flight on that volume (every process on it), as of this beat */
    diskLeasedMB: integer("disk_leased_mb").notNull().default(0),
    gpu: jsonb("gpu").$type<WorkerGpu | null>(),
    renders: jsonb("renders").$type<WorkerRenders>().notNull(),
    queues: text("queues").array().notNull().default(sql`'{}'::text[]`),
    processing: jsonb("processing").$type<WorkerJob[]>().notNull().default(sql`'[]'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("worker_instances_last_seen_idx").on(t.lastSeenAt)],
);
export type WorkerInstanceRow = typeof workerInstances.$inferSelect;

/**
 * Disk a job in flight has claimed on a volume (the filesystem DATA_DIR is on, identified by the
 * `.volume-id` marker every process sharing it reads). resources.ts takes one, atomically against the
 * volume's live total, before a stage writes its scratch, and the stage gives it back when it ends; a
 * lease counts while its worker heartbeats and until it expires (the longest a stage job may run), so
 * a crash leaks nothing for long. disk-leases.ts.
 */
export const diskLeases = pgTable(
  "disk_leases",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    volume: text("volume").notNull(),
    workerId: text("worker_id").notNull(),
    jobId: text("job_id"),
    projectId: text("project_id"),
    /** the stage that took it: ingest, transcribe, render */
    kind: text("kind").notNull(),
    mb: integer("mb").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("disk_leases_volume_idx").on(t.volume, t.expiresAt), index("disk_leases_worker_idx").on(t.workerId)],
);
export type DiskLeaseRow = typeof diskLeases.$inferSelect;
