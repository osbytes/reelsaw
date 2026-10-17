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
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ProjectSettings, UserProjectDefaults, ProjectStatus, ClipStatus, Word, TranscriptSegment, ProjectEventType, ReframeMode, TranscriptFlag, RefineStatus, LayoutSection, DetectedSegment, StyleOverride, ClipScores, ClipOrigin, ClipDiagnostics, SourceOverlay, TextProfile } from "@reelsaw/shared";

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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
});

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
export const ADMIN_EVENT_TYPES = ["user.signed_up", "user.approved", "user.role_changed", "user.limits_changed", "user.banned", "user.unbanned", "user.removed", "models.changed", "provider.changed"] as const;
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("llm_usage_user_id_idx").on(t.userId, t.createdAt)],
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
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type UserSettingsRow = typeof userSettings.$inferSelect;

export const uploads = pgTable("uploads", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  storageKey: text("storage_key").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

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
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("bumper_assets_user_idx").on(t.userId)],
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
    error: text("error"),
    settings: jsonb("settings").$type<ProjectSettings>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("projects_user_id_idx").on(t.userId, t.createdAt)],
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("clips_project_id_idx").on(t.projectId, t.index)],
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

export * from "./oauth-schema.js";
