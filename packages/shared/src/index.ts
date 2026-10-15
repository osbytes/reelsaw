import { z } from "zod";

// ---------- Project lifecycle ----------

export const PROJECT_STATUSES = [
  "queued",
  "ingesting",
  "transcribing",
  "refining",
  "analyzing",
  "rendering",
  "done",
  "failed",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PIPELINE_STAGES = ["ingest", "transcribe", "refine", "analyze", "render"] as const;

/** Sub-steps of the refine stage; they run as independent jobs after transcription. */
export const REFINE_STEPS = ["entities", "disfluency", "scenes"] as const;
export type RefineStep = (typeof REFINE_STEPS)[number];
export type RefineStatus = Partial<Record<RefineStep, "queued" | "running" | "done" | "failed">>;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** preparing = an AI job is writing metadata (and, for "manual-ai", choosing bounds) before render */
export const CLIP_STATUSES = ["preparing", "pending", "rendering", "done", "failed"] as const;
/** ai = found by analysis; manual = exact range picked by the user; manual-ai = AI picked the best clip inside a user selection */
export const CLIP_ORIGINS = ["ai", "manual", "manual-ai"] as const;
export type ClipOrigin = (typeof CLIP_ORIGINS)[number];
export type ClipStatus = (typeof CLIP_STATUSES)[number];

// ---------- Settings ----------

/**
 * auto   – detect faces per clip: big face → "face", webcam-in-corner/small face → "stack", no face → "fit"
 * face   – 9:16 crop that follows the detected face (falls back to center crop when none is found)
 * split  – two speakers, one crop stacked above the other
 * stack  – full frame on top, zoomed face crop below (screencast / slides with a webcam)
 * fit    – whole frame over a blurred background
 * center – static center crop
 * none   – keep the original aspect ratio
 */
export const reframeModeSchema = z.enum(["auto", "face", "split", "stack", "fit", "center", "none"]);
export type ReframeMode = z.infer<typeof reframeModeSchema>;

export const captionStyleSchema = z.enum(["karaoke", "box", "plain", "none"]);
/** Legacy coarse position; new projects store captionX/captionY instead. */
export const captionPositionSchema = z.enum(["bottom", "middle", "top"]);
export type CaptionPosition = z.infer<typeof captionPositionSchema>;
export type CaptionStyle = z.infer<typeof captionStyleSchema>;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * Everything that is burned into the picture besides the framing. Lives on the project (defaults for
 * every clip) and optionally per clip (`clips.style`, partial override). Positions are the centre of
 * the text block as a fraction of the 9:16 frame, so the browser preview and the ASS renderer agree.
 */
export const styleSchema = z.object({
  captions: captionStyleSchema.default("karaoke"),
  captionSize: z.number().min(0.5).max(2).default(1),
  captionX: z.number().min(0).max(1).default(0.5),
  captionY: z.number().min(0).max(1).default(0.72),
  /** Karaoke active-word colour. */
  highlightColor: hexColor.default("#FFD700"),
  /** Max words on screen at once (1 = one-word-at-a-time "Hormozi" style). */
  wordsPerLine: z.number().int().min(1).max(8).default(4),
  uppercase: z.boolean().default(false),
  /** Colour the clip's key words (picked by the AI when scoring; editable per clip). */
  emphasis: z.boolean().default(true),
  emphasisColor: hexColor.default("#39FF14"),
  showHook: z.boolean().default(true),
  hookX: z.number().min(0).max(1).default(0.5),
  hookY: z.number().min(0).max(1).default(0.16),
  hookSeconds: z.number().min(0).max(15).default(3.5),
});
export type Style = z.infer<typeof styleSchema>;
export const styleOverrideSchema = styleSchema.partial();
export type StyleOverride = z.infer<typeof styleOverrideSchema>;
export const defaultStyle: Style = styleSchema.parse({});

const LEGACY_CAPTION_Y: Record<CaptionPosition, number> = { top: 0.3, middle: 0.5, bottom: 0.74 };

/** Project defaults (incl. legacy captionPosition) + per-clip override → the style a clip renders with. */
export function resolveStyle(settings: Partial<ProjectSettings> & { captionPosition?: CaptionPosition }, override?: StyleOverride | null): Style {
  const legacyY = settings.captionY === undefined && settings.captionPosition ? LEGACY_CAPTION_Y[settings.captionPosition] : undefined;
  const base: Record<string, unknown> = {};
  for (const k of Object.keys(styleSchema.shape) as Array<keyof Style>) {
    const v = override?.[k] ?? settings[k as keyof typeof settings];
    if (v !== undefined) base[k] = v;
  }
  if (legacyY !== undefined && override?.captionY === undefined) base.captionY = legacyY;
  const parsed = styleSchema.safeParse(base);
  return parsed.success ? parsed.data : { ...defaultStyle, ...(base as Partial<Style>) };
}

/** Framing modes a user can pick for a section of a clip. "auto" = let face detection decide. */
export const sectionModeSchema = z.enum(["auto", "face", "split", "stack", "fit", "center"]);
export type SectionMode = z.infer<typeof sectionModeSchema>;

/** A user-forced framing for part of a clip, in absolute source seconds (survives retrims). */
export const layoutSectionSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  mode: sectionModeSchema,
  /** Manual re-centring: shifts the crop horizontally by this fraction of the source width. */
  offsetX: z.number().min(-0.5).max(0.5).optional(),
});
export type LayoutSection = z.infer<typeof layoutSectionSchema>;

/** What the renderer actually used for each piece of a clip, absolute source seconds. */
export interface DetectedSegment {
  start: number;
  end: number;
  layout: "face" | "split" | "stack" | "fit" | "center" | "none";
  /** true when the user forced this framing */
  manual: boolean;
  reason: string;
  /** median face centre (normalized) for the preview crop */
  cx: number;
  cy: number;
  cx2?: number;
  /** crop centre over time, ~1 point/s: [absolute seconds, x] (offset already applied) */
  track?: Array<[number, number]>;
  /** manual offset that was applied */
  offsetX?: number;
}

/** What the last render actually did, for the UI and for debugging (`reelsaw status`). */
export interface ClipDiagnostics {
  renderedAt: string;
  layout: string;
  cuts: {
    applied: Array<{ start: number; end: number }>;
    skipped: Array<{ start: number; end: number; reason: string }>;
  };
  outDurationSec: number;
  renderMs: number;
}

/** Rubric the clip was scored on (each 0-10, median over samples); `score` = weighted total ×10. */
export interface ClipScores {
  hook: number;
  flow: number;
  value: number;
  shareability: number;
  /** only when the project has a focus */
  relevance?: number;
  samples: number;
  /** position after the pairwise ranking pass (1 = best), when it ran */
  rank?: number;
}
export const RUBRIC_WEIGHTS = { hook: 0.35, flow: 0.2, value: 0.3, shareability: 0.15 } as const;
export function rubricTotal(s: Pick<ClipScores, "hook" | "flow" | "value" | "shareability" | "relevance">): number {
  const base = 10 * (RUBRIC_WEIGHTS.hook * s.hook + RUBRIC_WEIGHTS.flow * s.flow + RUBRIC_WEIGHTS.value * s.value + RUBRIC_WEIGHTS.shareability * s.shareability);
  const rel = s.relevance === undefined ? 1 : 0.5 + s.relevance / 20;
  return Math.round(Math.max(0, Math.min(100, base * rel)));
}

export const projectSettingsSchema = styleSchema.extend({
  /** Upper bound on clips. Unset = the AI returns every moment that stands on its own. */
  maxClips: z.number().int().min(1).max(50).optional(),
  minClipSeconds: z.number().int().min(5).max(180).default(20),
  maxClipSeconds: z.number().int().min(10).max(300).default(60),
  /** Framing default for every clip. "auto" detects per section; per-section overrides live on the clip. */
  reframe: reframeModeSchema.default("auto"),
  /** @deprecated use captionY */
  captionPosition: captionPositionSchema.optional(),
  language: z.string().max(10).optional(),
  /** "Find clips about …": restricts selection to this topic and adds a relevance score. */
  focus: z.string().max(300).optional(),
  instructions: z.string().max(2000).optional(),
  /** Names, brands and jargon the transcriber should spell correctly (comma separated). */
  vocabulary: z.string().max(1000).optional(),
});
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export const defaultProjectSettings: ProjectSettings = projectSettingsSchema.parse({});

export const createProjectInputSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  sourceUrl: z.url().optional(),
  uploadId: z.string().optional(),
  settings: projectSettingsSchema.partial().optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

// ---------- Transcript ----------

export const wordSchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
});
export type Word = z.infer<typeof wordSchema>;

export const transcriptSegmentSchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
});
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const transcriptFlagSchema = z.object({
  id: z.string(),
  /** entity = misheard name; disfluency = filler / repetition / false start to delete */
  kind: z.enum(["entity", "disfluency"]).default("entity"),
  /** for disfluencies: which class the detector assigned */
  subkind: z.enum(["filler", "repetition", "repair"]).optional(),
  /** index + span into the raw (as-heard) word list */
  wordIndex: z.number().int(),
  span: z.number().int().min(1),
  start: z.number(),
  end: z.number(),
  heard: z.string(),
  /** replacement text; empty string means "delete these words" */
  suggested: z.string(),
  /** user-typed replacement; wins over `suggested` when the flag is accepted */
  replacement: z.string().optional(),
  /** LLM confidence 0-1 that the suggestion is what was actually said */
  confidence: z.number().min(0).max(1),
  /** auto = applied automatically (high confidence); pending = waiting for the user; accepted/rejected = user decision */
  status: z.enum(["auto", "pending", "accepted", "rejected"]),
});
export type TranscriptFlag = z.infer<typeof transcriptFlagSchema>;

// ---------- Clip candidates (LLM output) ----------

export const clipCandidateSchema = z.object({
  title: z.string().describe("Short, punchy title for the clip (max 80 chars)"),
  hook: z
    .string()
    .describe("A 3-8 word on-screen hook line that makes someone stop scrolling"),
  startSec: z.number().describe("Clip start time in seconds, aligned to the start of a sentence"),
  endSec: z.number().describe("Clip end time in seconds, aligned to the end of a sentence"),
  score: z.number().min(0).max(100).describe("Virality score 0-100"),
  reasoning: z.string().describe("One or two sentences on why this moment works as a short"),
  caption: z.string().max(300).default("").describe("Ready-to-post caption for TikTok/Reels/Shorts: 1-2 punchy sentences, no hashtags"),
  hashtags: z.array(z.string()).max(8).describe("Suggested hashtags without the # symbol"),
});
export type ClipCandidate = z.infer<typeof clipCandidateSchema>;

// ---------- Events ----------

export const PROJECT_EVENT_TYPES = [
  "project.created",
  "stage.started",
  "stage.progress",
  "stage.completed",
  "stage.failed",
  "clip.created",
  "clip.rendering",
  "clip.done",
  "clip.failed",
  "project.done",
  "project.failed",
] as const;
export type ProjectEventType = (typeof PROJECT_EVENT_TYPES)[number];

export interface ProjectEvent {
  id: number;
  projectId: string;
  type: ProjectEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
}

// ---------- captions (shared by the ASS renderer and the browser preview) ----------

/** Normalized form used to match emphasis words against transcript words. */
export const emphasisKey = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

/**
 * Group clip-relative words into caption lines. Readability rules (subtitle research, adapted for
 * narrow 9:16 frames): at most `maxWords` words and `maxChars` characters (≈ two short lines), at most
 * `maxSeconds` on screen, break after sentence ends and (for 3+ words) after commas, never across a
 * pause longer than 0.8 s.
 */
export function groupCaptionLines<W extends { text: string; start: number; end: number }>(words: W[], maxWords = 4, maxSeconds = 1.8, maxChars = 28): W[][] {
  const lines: W[][] = [];
  let cur: W[] = [];
  let chars = 0;
  for (const w of words) {
    const first = cur[0];
    const tooLong = first && (cur.length >= maxWords || w.end - first.start > maxSeconds || chars + 1 + w.text.length > maxChars);
    const gap = cur.length && w.start - cur[cur.length - 1]!.end > 0.8;
    if (tooLong || gap) {
      lines.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(w);
    chars += (chars ? 1 : 0) + w.text.length;
    if ((/[.!?]$/.test(w.text) && cur.length >= 2) || (/[,;:]$/.test(w.text) && cur.length >= 3)) {
      lines.push(cur);
      cur = [];
      chars = 0;
    }
  }
  if (cur.length) lines.push(cur);
  return lines;
}

/** Character budget per caption chunk (≈ two short lines), shrinking as the font grows. */
export const captionMaxChars = (size: number) => Math.max(10, Math.min(40, Math.round(28 / size)));

/** Minimum time a caption line stays up (unless the next line starts sooner). */
export const MIN_LINE_SECONDS = 0.7;
/** Display end for line i: hold short lines up to MIN_LINE_SECONDS without overlapping the next. */
export function lineDisplayEnd<W extends { start: number; end: number }>(lines: W[][], i: number): number {
  const line = lines[i]!;
  const start = line[0]!.start;
  const end = line[line.length - 1]!.end;
  const next = lines[i + 1]?.[0]?.start ?? Infinity;
  return Math.max(end, Math.min(start + MIN_LINE_SECONDS, next));
}

/** Caption/hook font sizes as a fraction of frame height (renderer multiplies by output height). */
export const CAPTION_FONT_FRAC = 68 / 1920;
export const HOOK_FONT_FRAC = 60 / 1920;
/** Default max line seconds for a given words-per-line setting. */
export const lineSecondsFor = (wordsPerLine: number) => (wordsPerLine <= 2 ? 1.0 : 1.8);
