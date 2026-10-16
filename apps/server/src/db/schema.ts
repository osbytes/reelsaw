import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  real,
  jsonb,
  bigserial,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { ProjectSettings, ProjectStatus, ClipStatus, Word, TranscriptSegment, ProjectEventType, ReframeMode, TranscriptFlag, RefineStatus, LayoutSection, DetectedSegment, StyleOverride, ClipScores, ClipOrigin, ClipDiagnostics, SourceOverlay, TextProfile } from "@reelsaw/shared";

// ---------- Better Auth core tables ----------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
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
