import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  real,
  jsonb,
  bigserial,
  bigint,
  numeric,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";
import type { ProjectSettings, UserProjectDefaults, ProjectStatus, RunReason, ClipStatus, Word, TranscriptSegment, ProjectEventType, ReframeMode, TranscriptFlag, RefineStatus, LayoutSection, DetectedSegment, StyleOverride, ClipScores, ClipOrigin, ClipDiagnostics, ClipBumpers, SourceOverlay, TextProfile } from "@reelsaw/shared";

export const USER_ROLES = ["user", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

// ---------- Better Auth core tables ----------

export const user = pgTable("user", {
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
},
(t) => [
  // admin Users search: ILIKE '%q%' and word similarity on name and email
  index("user_name_trgm_idx").using("gin", t.name.op("gin_trgm_ops")),
  index("user_email_trgm_idx").using("gin", t.email.op("gin_trgm_ops")),
  uniqueIndex("user_email_key_idx").on(t.emailKey),
  index("user_signup_ip_idx").on(t.signupIp, t.createdAt),
]);

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
    updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
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
    updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
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
    updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
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
  "models.changed",
  "provider.changed",
  "settings.changed",
  // billing (ee/): written by the subscription sync, never by a webhook handler directly
  "billing.subscribed",
  "billing.changed",
  "billing.payment_failed",
  "billing.canceled",
  "billing.complimentary",
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
 * A user's intro/outro video. Immutable: replacing one is a new row, so a cache keyed by id is
 * correct and a clip's diagnostics say exactly which version it used. Soft-deleted rows still
 * resolve at render time so projects that snapshotted the id keep working.
 */
export const bumperAssets = pgTable(
  "bumper_assets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"video" | "image">().notNull().default("video"),
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
  (t) => [index("bumper_assets_user_idx").on(t.userId), index("bumper_assets_hash_idx").on(t.userId, t.contentHash),
    // the hourly purge looks for removed assets across all users
    index("bumper_assets_deleted_idx").on(t.deletedAt).where(sql`${t.deletedAt} is not null`),
  ],
);
export type BumperAsset = typeof bumperAssets.$inferSelect;

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
    /** explicit runs (see pipeline/lifecycle.ts startRun): how many have started, when and why the current/last one did */
    runSeq: integer("run_seq").notNull().default(0),
    runStartedAt: timestamp("run_started_at", { withTimezone: true }),
    runReason: text("run_reason").$type<RunReason>(),
    /** when the stage now running began; stage.completed / stage.failed durations come from it */
    stageStartedAt: timestamp("stage_started_at", { withTimezone: true }),
    error: text("error"),
    settings: jsonb("settings").$type<ProjectSettings>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    /** soft delete: hidden everywhere, restorable until the purge (DELETED_RETENTION_DAYS) removes the row and its files */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
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
  (t) => [
    index("project_events_project_id_idx").on(t.projectId, t.id),
  ],
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
export const BILLING_STATUSES = ["trialing", "active", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused", "complimentary"] as const;
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
  (t) => [index("billing_events_subscription_idx").on(t.subscriptionId, t.created), index("billing_events_pending_idx").on(t.receivedAt).where(sql`processed_at is null`)],
);
export type BillingEventRow = typeof billingEvents.$inferSelect;
