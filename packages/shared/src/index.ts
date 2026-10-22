import { z } from "zod";

/** Canonical source repository (app UI, emails, update checks). */
export const REPO_URL = "https://github.com/osbytes/reelsaw";

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

/**
 * Why a run started. A run is one stretch of work on a project, from the moment it leaves idle
 * (created, or done / failed) until it is done or failed again.
 */
export const RUN_REASONS = ["created", "retry", "rerender", "refine", "reanalyze", "clip_added"] as const;
export type RunReason = (typeof RUN_REASONS)[number];

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
export const reframeModeSchema = z.enum(["auto", "face", "split", "stack", "fit", "center", "none"]).describe("Framing: auto (detect per section), face (follow the speaker), split (two speakers stacked), stack (full frame over a face crop), fit (whole frame on blur), center (static crop), none (original aspect)");
export type ReframeMode = z.infer<typeof reframeModeSchema>;

export const captionStyleSchema = z.enum(["karaoke", "box", "plain", "none"]).describe("Caption look: karaoke (active word highlighted), box, plain, or none (no captions)");
/** Legacy coarse position; new projects store captionX/captionY instead. */
export const captionPositionSchema = z.enum(["bottom", "middle", "top"]);
export type CaptionPosition = z.infer<typeof captionPositionSchema>;
export type CaptionStyle = z.infer<typeof captionStyleSchema>;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** Fraction of the 9:16 frame, 0 = left/top, 1 = right/bottom. */
const frac = (what: string) => z.number().min(0).max(1).describe(`${what}, as a fraction of the 9:16 frame (0-1)`);

/**
 * Everything that is burned into the picture besides the framing. Lives on the project (defaults for
 * every clip) and optionally per clip (`clips.style`, partial override). Positions are the centre of
 * the text block as a fraction of the 9:16 frame, so the browser preview and the ASS renderer agree.
 */
export const styleSchema = z.object({
  captions: captionStyleSchema.default("karaoke"),
  captionSize: z.number().min(0.5).max(2).describe("Caption size multiplier (0.5-2, default 1)").default(1),
  captionX: frac("Caption centre, horizontal").default(0.5),
  captionY: frac("Caption centre, vertical (default 0.72)").default(0.72),
  /** Karaoke active-word colour. */
  highlightColor: hexColor.describe("Karaoke active-word colour, #RRGGBB (default #FFD700)").default("#FFD700"),
  /** Max words on screen at once (1 = one-word-at-a-time "Hormozi" style). */
  wordsPerLine: z.number().int().min(1).max(8).describe("Max caption words on screen at once (1-8, default 4)").default(4),
  uppercase: z.boolean().describe("Captions in capitals").default(false),
  /** Colour the clip's key words (picked by the AI when scoring; editable per clip). */
  emphasis: z.boolean().describe("Colour the clip's key words (default true)").default(true),
  emphasisColor: hexColor.describe("Colour of emphasised words, #RRGGBB (default #39FF14)").default("#39FF14"),
  showHook: z.boolean().describe("Show the hook text at the start of the clip (default true)").default(true),
  hookX: frac("Hook centre, horizontal").default(0.5),
  hookY: frac("Hook centre, vertical (default 0.16)").default(0.16),
  hookSeconds: z.number().min(0).max(15).describe("How long the hook shows, seconds (0-15, default 3.5)").default(3.5),
});
export type Style = z.infer<typeof styleSchema>;
/** Partial style without the defaults (`.partial()` would fill every unset field with its default). */
export const styleOverrideSchema = withoutDefaults<Partial<Style>>(styleSchema.shape);
export type StyleOverride = Partial<Style>;
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
export const sectionModeSchema = z.enum(["auto", "face", "split", "stack", "fit", "center"]).describe("Framing for this section (same modes as the project's reframe, without none)");
export type SectionMode = z.infer<typeof sectionModeSchema>;

/** A user-forced framing for part of a clip, in absolute source seconds (survives retrims). */
export const layoutSectionSchema = z.object({
  start: z.number().min(0).describe("Section start, seconds from the start of the source video"),
  end: z.number().min(0).describe("Section end, seconds from the start of the source video"),
  mode: sectionModeSchema,
  /** Manual re-centring of the first pane (the only pane, or the top of a split): shifts the crop by this fraction of the source width, relative to the tracked face. */
  offsetX: z.number().min(-0.5).max(0.5).optional().describe("Shift the (top) crop sideways by this fraction of the source width (-0.5 to 0.5), relative to the face it follows"),
  offsetY: z.number().min(-0.5).max(0.5).optional().describe("Shift the (top) crop up or down by this fraction of the source height; only matters where the crop is shorter than the frame (split, stack)"),
  /** Second pane of a split (the bottom speaker). */
  offsetX2: z.number().min(-0.5).max(0.5).optional().describe("Split only: shift the bottom crop sideways (-0.5 to 0.5)"),
  offsetY2: z.number().min(-0.5).max(0.5).optional().describe("Split only: shift the bottom crop up or down (-0.5 to 0.5)"),
  /** Follow the person at this x instead of the detector's pick: the render re-assigns the pane's track to the face nearest it (no face there = a fixed crop at that x). */
  subjectX: z.number().min(0).max(1).optional().describe("Follow the person at this x (0-1 of the source width) in the top/only pane; the offset still applies on top"),
  subjectX2: z.number().min(0).max(1).optional().describe("Split only: follow the person at this x in the bottom pane"),
});
export type LayoutSection = z.infer<typeof layoutSectionSchema>;
/** One pane's adjustment: pane 0 is the only pane or the top of a split, pane 1 the bottom of a split. */
export interface PaneAdjust {
  offsetX?: number;
  offsetY?: number;
  subjectX?: number;
}
export function paneOf(s: Pick<LayoutSection, "offsetX" | "offsetY" | "offsetX2" | "offsetY2" | "subjectX" | "subjectX2">, pane: 0 | 1): PaneAdjust {
  return pane === 0 ? { offsetX: s.offsetX, offsetY: s.offsetY, subjectX: s.subjectX } : { offsetX: s.offsetX2, offsetY: s.offsetY2, subjectX: s.subjectX2 };
}
/** Write one pane's adjustment back onto a section (undefined fields are removed). */
export function withPane<T extends Pick<LayoutSection, "offsetX" | "offsetY" | "offsetX2" | "offsetY2" | "subjectX" | "subjectX2">>(s: T, pane: 0 | 1, a: PaneAdjust): T {
  const out: T = { ...s };
  const keys = pane === 0 ? (["offsetX", "offsetY", "subjectX"] as const) : (["offsetX2", "offsetY2", "subjectX2"] as const);
  const vals = [a.offsetX, a.offsetY, a.subjectX];
  keys.forEach((k, i) => {
    const v = vals[i];
    if (v === undefined || (k !== "subjectX" && k !== "subjectX2" && Math.abs(v) < 1e-4)) delete out[k];
    else out[k] = v;
  });
  return out;
}
/** True when a section carries any manual adjustment (and so must be stored even in Auto mode). */
export const hasAdjust = (s: Pick<LayoutSection, "offsetX" | "offsetY" | "offsetX2" | "offsetY2" | "subjectX" | "subjectX2">) =>
  !!(s.offsetX || s.offsetY || s.offsetX2 || s.offsetY2 || s.subjectX !== undefined || s.subjectX2 !== undefined);

/**
 * An image or short video from the library laid over part of the clip (a logo, a sticker, b-roll).
 * Times are absolute source seconds like sections; position and size are fractions of the 9:16 output.
 */
export const clipOverlaySchema = z
  .object({
    id: z.string().min(1).max(40).describe("Stable id for this overlay (any short string; keep it when editing)"),
    /** absent = asset (rows stored before text overlays existed) */
    kind: z.enum(["asset", "text"]).optional().describe("asset (default): a library image or video; text: a line of text"),
    assetId: z.string().min(1).max(100).optional().describe("asset: library asset id (list_bumpers), an image or a video"),
    text: z.string().trim().min(1).max(120).optional().describe("text: the line to show (1-120 chars)"),
    start: z.number().min(0).describe("Shown from this second of the source video"),
    end: z.number().min(0).describe("Hidden after this second of the source video"),
    x: z.number().min(0).max(1).describe("Centre, fraction of the output width (0-1)"),
    y: z.number().min(0).max(1).describe("Centre, fraction of the output height (0-1)"),
    w: z.number().min(0.05).max(1).optional().describe("asset: width, fraction of the output width (0.05-1); the height follows the file. Default 0.3"),
    size: z.number().min(0.02).max(0.12).optional().describe("text: font size as a fraction of the output height (0.02-0.12), default 0.045"),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional()
      .describe("text: colour as #RRGGBB, default white"),
    box: z.boolean().optional().describe("text: dark plate behind the text (default: outlined text, no plate)"),
    font: z.string().min(1).max(60).optional().describe("text: font family from TEXT_FONTS (default DejaVu Sans, the caption font)"),
    opacity: z.number().min(0.1).max(1).optional().describe("0.1-1, default 1"),
  })
  .refine((o) => (o.kind === "text" ? !!o.text : !!o.assetId), { message: "an asset overlay needs assetId, a text overlay needs text" });
export type ClipOverlay = z.infer<typeof clipOverlaySchema>;
export const MAX_CLIP_OVERLAYS = 20;

/**
 * Background music under part of a clip: a library audio asset mixed under the speech, ducked while
 * someone talks, faded in and out. Times are absolute source seconds like sections and overlays.
 */
export const clipAudioSchema = z.object({
  id: z.string().min(1).max(40).describe("Stable id for this track (any short string; keep it when editing)"),
  assetId: z.string().min(1).max(100).describe("Library audio asset id (list_bumpers, kind audio); the same asset can be used more than once"),
  start: z.number().min(0).describe("Music starts at this second of the source video"),
  end: z.number().min(0).describe("Music stops after this second of the source video"),
  offset: z.number().min(0).optional().describe("Seconds into the track to start from (default 0)"),
  volume: z.number().min(0).max(1).optional().describe("Music level 0-1 (default 0.6) on a track normalised to -20 LUFS, before ducking"),
  duck: z.boolean().optional().describe("Lower the music while someone speaks (default true)"),
  fade: z.number().min(0).max(5).optional().describe("Fade in and out, seconds (default 0.5)"),
  loop: z.boolean().optional().describe("Repeat the track when it is shorter than the window (default true)"),
});
export type ClipAudio = z.infer<typeof clipAudioSchema>;
export const CLIP_AUDIO_DEFAULTS = { volume: 0.6, duck: true, fade: 0.5, loop: true } as const;
export const MAX_CLIP_AUDIO = 10;
/** Rows written before tracks had ids and could repeat hold one object; read them as a one-track list. */
export function clipAudioList(v: unknown): ClipAudio[] {
  if (Array.isArray(v)) return v.flatMap((x) => (clipAudioSchema.safeParse(x).success ? [clipAudioSchema.parse(x)] : []));
  if (v && typeof v === "object") {
    const one = clipAudioSchema.safeParse({ id: "music", ...(v as Record<string, unknown>) });
    return one.success ? [one.data] : [];
  }
  return [];
}

/**
 * Fonts a text overlay can use: installed in the server image (Dockerfile) and served to the editor
 * preview from there (`/api/fonts/:family`), so what you see is what libass draws.
 */
export const TEXT_FONTS = [
  { family: "DejaVu Sans", label: "DejaVu Sans (default)" },
  { family: "Liberation Sans", label: "Liberation Sans (Arial-like)" },
  { family: "Roboto", label: "Roboto" },
  { family: "Open Sans", label: "Open Sans" },
  { family: "Lato", label: "Lato" },
  { family: "Inter", label: "Inter" },
  { family: "Bebas Neue", label: "Bebas Neue (condensed caps)" },
  { family: "Liberation Serif", label: "Liberation Serif" },
  { family: "DejaVu Sans Mono", label: "DejaVu Sans Mono" },
] as const;
export type TextFont = (typeof TEXT_FONTS)[number]["family"];
export const textFontSchema = z.enum(TEXT_FONTS.map((f) => f.family) as [TextFont, ...TextFont[]]);

/** A caption line as the last render burned it in, in the rendered video's own seconds (after the intro). */
export interface RenderedCaptionLine {
  start: number;
  end: number;
  words: Array<{ text: string; start: number; end: number }>;
}
/** The captions of the last render, kept for SRT / VTT export so the files match the video exactly. */
export interface RenderedCaptions {
  /** seconds of intro before the body (already added to the line times) */
  introSec: number;
  /** the caption look that was rendered ("none" = no captions were burned in, lines still exported) */
  captions: "karaoke" | "box" | "plain" | "none";
  lines: RenderedCaptionLine[];
}
/** The kind of an overlay, "asset" for rows stored before text overlays existed. */
export const overlayKind = (o: Pick<ClipOverlay, "kind">): "asset" | "text" => o.kind ?? "asset";
export const TEXT_OVERLAY_DEFAULTS = { size: 0.045, color: "#FFFFFF" } as const;
export const ASSET_OVERLAY_DEFAULT_W = 0.3;

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
  /** median face height (fraction of source height), for speaker-sized crops */
  size?: number;
  size2?: number;
  cy2?: number;
  /** crop centre over time, ~1 point/s: [absolute seconds, x] (offset already applied) */
  track?: Array<[number, number]>;
  /** manual offsets that were applied (first pane, and the second pane of a split) */
  offsetX?: number;
  offsetY?: number;
  offsetX2?: number;
  offsetY2?: number;
  /** the pane follows the person the user pointed at (subjectX); "fixed" when no face was found there */
  subject?: "followed" | "fixed";
  subject2?: "followed" | "fixed";
  /** the subject x each pane was asked to follow */
  subjectX?: number;
  subjectX2?: number;
  /** second speaker's crop centre over time, like `track` */
  track2?: Array<[number, number]>;
  /** "stack" only: the part of the frame shown on top (absent = the whole frame) */
  content?: ContentRegion;
}

/**
 * Per-clip intro/outro choice. A missing key inherits the project's, `null` means none, a string is a
 * library asset id. Stored on the clip, so it survives pipeline re-runs.
 */
export const bumperSecondsSchema = z.number().min(1).max(10).describe("Seconds an image intro/outro shows (1-10); videos keep their own length");
/** How long an image intro/outro is shown unless its card or a use says otherwise. */
export const DEFAULT_IMAGE_BUMPER_SEC = 3;
/** `introSec` / `outroSec` override how long an image shown in that slot lasts (videos keep their own length). */
export const clipBumpersSchema = z.object({ intro: z.string().min(1).max(100).nullable().optional(), introSec: bumperSecondsSchema.optional(), outro: z.string().min(1).max(100).nullable().optional(), outroSec: bumperSecondsSchema.optional() });
export type ClipBumpers = z.infer<typeof clipBumpersSchema>;

/** What the last render actually did, for the UI and for debugging (`reelsaw status`). */
export interface ClipDiagnostics {
  renderedAt: string;
  /** caption words re-timed by forced alignment */
  captionTiming?: { aligned: number; total: number; medianShiftMs: number; ms: number };
  /** silence trimmed by the pause setting */
  pauses?: { cuts: number; removedSec: number; maxPause: number };
  layout: string;
  cuts: {
    /**
     * `verified: false` (absent in renders from before it existed, meaning verified) = applied at the
     * word timings without a seam check, with `reason`; `manual` = the user's own cut
     */
    applied: Array<{ start: number; end: number; verified?: boolean; reason?: string; manual?: boolean }>;
    skipped: Array<{ start: number; end: number; reason: string }>;
  };
  outDurationSec: number;
  /** intro/outro attached to this render (ids, seconds) and which were skipped, and why */
  bumpers?: { introId?: string; outroId?: string; introSec: number; outroSec: number; skipped?: string[]; fromClip?: Array<"intro" | "outro"> };
  /** overlays composited (and any that were skipped, with reasons) */
  overlays?: { used: number; skipped?: string[] };
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
  maxClips: z.number().int().min(1).max(50).optional().describe("Most clips to pick (1-50); unset = every moment that stands on its own"),
  minClipSeconds: z.number().int().min(5).max(180).describe("Shortest clip, seconds (5-180, default 20)").default(20),
  maxClipSeconds: z.number().int().min(10).max(300).describe("Longest clip, seconds (10-300, default 60; must be above minClipSeconds)").default(60),
  /** Long pauses inside clips: shortened to 0.6 s (natural) / 0.35 s (tight) with jump cuts, or kept. */
  pauses: z.enum(["off", "natural", "tight"]).describe("Long pauses inside clips: natural (cut to 0.6 s, default), tight (0.35 s) or off").default("natural"),
  /** Text burned into the source (captions, logos): "hide" keeps it out of crops and masks the rest. */
  /**
   * Text already in the video: hide = blur detected captions/logos, except in presentations (slide
   * decks, screen shares) where on-screen text is the content; always = blur even then; keep = never.
   */
  sourceText: z.enum(["hide", "keep", "always"]).describe("Text already in the video: hide (blur captions/logos except in slide decks, default), always (blur even then), keep").default("hide"),
  /** Framing default for every clip. "auto" detects per section; per-section overrides live on the clip. */
  reframe: reframeModeSchema.default("auto"),
  /** @deprecated use captionY */
  captionPosition: captionPositionSchema.optional().describe("Deprecated: use captionY"),
  language: z.string().max(10).optional().describe("Spoken language code (e.g. en); unset = detected"),
  /** "Find clips about …": restricts selection to this topic and adds a relevance score. */
  focus: z.string().max(300).optional().describe("Only pick clips about this topic (max 300 chars)"),
  instructions: z.string().max(2000).optional().describe("Free-text guidance for picking and titling clips (max 2000 chars)"),
  /** Names, brands and jargon the transcriber should spell correctly (comma separated). */
  vocabulary: z.string().max(1000).optional().describe("Names, brands and jargon to spell correctly, comma separated (max 1000 chars)"),
  /**
   * Refine-stage toggles. Defaults off (faster, cheaper); turn on for polish. An instance gate that
   * is off (Settings → System → Pipeline, or the matching .env) wins and the step stays skipped
   * even when these are true. Existing transcript flags stay until refine is re-run.
   */
  refineEntities: z.boolean().describe("Fix misheard names after transcription (LLM). Off by default; on runs that refine step.").default(false),
  refineDisfluency: z.boolean().describe("Find fillers, repetitions and false starts. Off by default; on runs that refine step.").default(false),
  /** Only used when refineDisfluency is on; rules still run when this is off. */
  disfluencyLlm: z.boolean().describe("Model pass on top of rule-based disfluency detection. Off by default (rules only when disfluency is on).").default(false),
  refineScenes: z.boolean().describe("Detect scene cuts and on-screen text. Off by default; on runs that refine step.").default(false),
  /**
   * Intro / outro video (bumper_assets ids) attached to every clip. Snapshotted from the user's
   * defaults when the project is created. Unset = none; null is reserved for "none, although my
   * default has one" (project override, phase 2).
   */
  introAssetId: z.string().max(100).nullable().optional().describe("Library asset id of the intro (list_bumpers); null = none"),
  outroAssetId: z.string().max(100).nullable().optional().describe("Library asset id of the outro (list_bumpers); null = none"),
  /** How long an image intro / outro lasts in this project, overriding the library item's own length. */
  introSec: bumperSecondsSchema.optional(),
  outroSec: bumperSecondsSchema.optional(),
});
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export const defaultProjectSettings: ProjectSettings = projectSettingsSchema.parse({});

/**
 * What a user can set once and have applied to every new project (Settings → Project defaults).
 * A subset of ProjectSettings: the things that describe the user's content, not one video.
 */
export const userProjectDefaultsSchema = z
  .object({
    language: z.string().max(10),
    vocabulary: z.string().max(1000),
    instructions: z.string().max(2000),
    focus: z.string().max(300),
    pauses: z.enum(["off", "natural", "tight"]),
    sourceText: z.enum(["hide", "keep", "always"]),
    minClipSeconds: z.number().int().min(5).max(180),
    maxClipSeconds: z.number().int().min(10).max(300),
    maxClips: z.number().int().min(1).max(50),
    highlightColor: hexColor,
    wordsPerLine: z.number().int().min(1).max(8),
    uppercase: z.boolean(),
    refineEntities: z.boolean(),
    refineDisfluency: z.boolean(),
    disfluencyLlm: z.boolean(),
    refineScenes: z.boolean(),
    /** Intro / outro (bumper_assets ids). Changed only through `bumpers.*`, never by the defaults form. */
    introAssetId: z.string().max(100),
    outroAssetId: z.string().max(100),
  })
  .partial(); // no defaults here: an unset field means "use the built-in default"
export type UserProjectDefaults = z.infer<typeof userProjectDefaultsSchema>;

/**
 * A partial ProjectSettings with the defaults stripped: zod's `.partial()` keeps `.default()`,
 * so an unset field would come back as the built-in value and override the user's saved default.
 */
export type ProjectSettingsPatch = Partial<ProjectSettings>;
function withoutDefaults<T = ProjectSettingsPatch>(shape: z.ZodRawShape): z.ZodType<T, T> {
  const out: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(shape)) {
    const def = (v as { def?: { type?: string; innerType?: z.ZodType } }).def;
    out[k] = def?.type === "default" && def.innerType ? def.innerType : (v as z.ZodType);
  }
  return z.object(out).partial() as unknown as z.ZodType<T, T>;
}
export const projectSettingsPatchSchema = withoutDefaults(projectSettingsSchema.shape);
/** Optional settings a project update can reset to their default (unset). */
export const CLEARABLE_SETTINGS = ["maxClips", "focus", "instructions", "language", "vocabulary"] as const;
export type ClearableSetting = (typeof CLEARABLE_SETTINGS)[number];

export const createProjectInputSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  sourceUrl: z.url({ protocol: /^https?$/, message: "Use a link that starts with http:// or https://" }).optional(),
  uploadId: z.string().optional(),
  settings: projectSettingsPatchSchema.optional(),
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
  /** manual = the user marked these words to cut from the transcript */
  subkind: z.enum(["filler", "repetition", "repair", "manual"]).optional(),
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
  /** manual cuts: detector flags this cut replaced, restored (with their decisions) if it is deleted */
  absorbed: z.array(z.record(z.string(), z.unknown())).optional(),
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
  /** a run began: the project went from idle (or was created) to working; payload { seq, reason } */
  "run.started",
  "stage.started",
  "stage.progress",
  "stage.completed",
  "stage.failed",
  "clip.created",
  "clip.rendering",
  "clip.done",
  "clip.failed",
  /** a clip job attempt ended without finishing (error, crash, restart) and will be retried */
  "clip.retrying",
  /** an intro/outro could not be used; the clip rendered without it */
  "clip.bumper_skipped",
  /** an overlay (logo, sticker, b-roll) could not be used; the clip rendered without it */
  "clip.overlay_skipped",
  /** a cut the user made was applied without a seam check (the audio around it couldn't be matched) */
  "clip.cut_unverified",
  /** no progress for a long time on a running clip/stage (watchdog) */
  "job.stalled",
  /** retention removed the stored source / rendered clips (rows stay; Retry or re-render brings them back) */
  "source.expired",
  "clips.expired",
  /** soft delete and its undo (projects/service.ts); payload { days } = how long it stays restorable */
  "project.deleted",
  "project.restored",
  /** a clip a re-analyze replaced (or that was deleted) was brought back */
  "clip.restored",
  /** one clip soft-deleted (clips.delete / delete_clip); payload { clipId, index, title, days } */
  "clip.deleted",
  /** title or settings changed without re-running anything (projects.update / update_project); payload { changed } */
  "project.updated",
  /** a transcript was imported from an SRT / VTT file instead of transcribed (importTranscript); payload { format, cues, words } */
  "transcript.imported",
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

/**
 * First message of a project's event stream after the stored history has been replayed (progress ticks
 * never replay). `shown` events were sent out of `total` non-progress events the project has; when more exist,
 * `projects.eventsPage` pages back from `oldestId`.
 */
export interface EventsReplayed {
  type: "events.replayed";
  shown: number;
  total: number;
  oldestId: number | null;
  hasMore: boolean;
}
export const isEventsReplayed = (e: ProjectEvent | EventsReplayed): e is EventsReplayed => e.type === "events.replayed";

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

/** Floor for a caption line's display time (1-2 word lines). */
export const MIN_LINE_SECONDS = 0.7;
/** Reading pace: BBC subtitle guidance is about 0.3 s per word, Netflix caps at 20 characters per second. */
export const MIN_SECONDS_PER_WORD = 0.3;
export const MAX_CHARS_PER_SECOND = 20;

/** Minimum time a line of these words must stay up so it can be read: max(floor, words x 0.3 s, chars / 20). */
export function lineMinSeconds(line: Array<{ text?: string }>): number {
  const chars = line.reduce((n, w, i) => n + (w.text?.length ?? 0) + (i ? 1 : 0), 0);
  return Math.max(MIN_LINE_SECONDS, line.length * MIN_SECONDS_PER_WORD, chars / MAX_CHARS_PER_SECOND);
}

/**
 * Display end for line i: hold short lines up to `lineMinSeconds` (reading pace), and never past
 * the next line's start (a line is never delayed or shrunk to make room). Word timestamps often
 * overlap (the last word ends after the next line's first begins), so without the cap two lines are
 * drawn on top of each other at the same position.
 */
export function lineDisplayEnd<W extends { start: number; end: number; text?: string }>(lines: W[][], i: number): number {
  const line = lines[i]!;
  const start = line[0]!.start;
  const end = line[line.length - 1]!.end;
  const next = lines[i + 1]?.[0]?.start ?? Infinity;
  return Math.min(next, Math.max(end, start + lineMinSeconds(line)));
}

/** Words in spoken order with non-decreasing starts and positive durations (captions assume it). */
export function monotonicWords<W extends { start: number; end: number }>(words: W[]): W[] {
  let prev = -Infinity;
  return words.map((w) => {
    const start = Math.max(w.start, prev);
    prev = start;
    return { ...w, start, end: Math.max(w.end, start + 0.05) };
  });
}

/** Caption/hook font sizes as a fraction of frame height (renderer multiplies by output height). */
export const CAPTION_FONT_FRAC = 68 / 1920;
export const HOOK_FONT_FRAC = 60 / 1920;
/** Default max line seconds for a given words-per-line setting. */
export const lineSecondsFor = (wordsPerLine: number) => (wordsPerLine <= 2 ? 1.0 : 1.8);

/**
 * The 9:16 window cut from a source frame: full height and 9:16 wide, or the full width when the
 * source is already narrower. One definition for the renderer's crop and the editor preview.
 */
export function verticalCrop(srcW: number, srcH: number): { w: number; h: number } {
  return { w: Math.min(srcW, (srcH * 9) / 16), h: Math.min(srcH, (srcW * 16) / 9) };
}

/** Padding around detected text boxes before they are blurred, as fractions of source width / height. */
export const OVERLAY_PAD_X = 0.01;
export const OVERLAY_PAD_Y = 0.012;

// ---------- burned-in text + crop geometry (shared by the renderer and the editor preview) ----------

/** Text burned into the source (captions, watermarks), normalized source coordinates. */
/** How text-heavy the source is, from the overlay scan. */
export interface TextProfile {
  /** frames sampled */
  frames: number;
  /** frames that are mostly text: slides, documents, paragraphs of text */
  textHeavy: number;
  /** most of the video is text-heavy: on-screen text is the content, not something to hide */
  presentation: boolean;
}

/** Whether renders blur detected source text, given the project setting and the scan's profile. */
export function masksSourceText(sourceText: "hide" | "keep" | "always" | undefined, profile: TextProfile | null | undefined): boolean {
  if (sourceText === "keep") return false;
  if (sourceText === "always") return true;
  return !profile?.presentation;
}

export interface SourceOverlay {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** caption = changes over time (subtitles); watermark = always there (channel logo, handle) */
  kind: "caption" | "watermark";
  /** fraction of sampled frames showing text here */
  coverage: number;
  /** render-time only: clip-relative [start, end] windows when this text is on screen (absent = always) */
  windows?: Array<[number, number]>;
  /** render-time only: share of the clip this text is on screen */
  share?: number;
}

/**
 * Crop window for one speaker in a stacked/split layout, sized to the face instead of the full
 * source height: centres the speaker (a full-height 9:8 crop of a wide shot is ~60% of the frame and
 * cannot centre a face near the edge) and, when `avoid` bands are given, keeps burned-in captions out
 * of the crop. Returns source pixels; x is chosen per point by the caller (`cropX`).
 */
export function speakerCrop(srcW: number, srcH: number, aspect: number, face: { cy: number; size: number }, avoid: Array<{ y1: number; y2: number }> = []): { w: number; h: number; y: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  // ~3.2 face-heights tall: head and shoulders, the usual podcast-clip framing
  let h = clamp((face.size || 0.3) * 3.2, 0.42, 1) * srcH;
  let w = h * aspect;
  if (w > srcW) {
    w = srcW;
    h = w / aspect;
  }
  const faceY = face.cy * srcH;
  let y = clamp(faceY - 0.42 * h, 0, srcH - h);
  for (const b of avoid) {
    const b1 = b.y1 * srcH - 2;
    const b2 = b.y2 * srcH + 2;
    if (y + h <= b1 || y >= b2) continue; // no overlap
    if (faceY < b1) {
      // speaker above the band: end the crop just above it (shrink if needed, never below 35% of the source)
      const room = b1 - y;
      if (room >= 0.35 * srcH) h = Math.min(h, room);
      else {
        h = Math.max(0.35 * srcH, Math.min(h, b1));
        y = Math.max(0, b1 - h);
      }
    } else if (faceY > b2) {
      // speaker below: start just under it
      const ny = b2;
      if (srcH - ny >= 0.35 * srcH) {
        y = ny;
        h = Math.min(h, srcH - ny);
      }
    }
    w = h * aspect;
  }
  return { w: Math.round(w), h: Math.round(h), y: Math.round(clamp(y, 0, srcH - h)) };
}

/**
 * The part of the source frame a "stack" shows on top (normalized); the speaker is cropped below.
 * A corner webcam over a screen share shows the whole frame; an app screen or title card beside the
 * speaker is a full-height region on one side; an inset or a top strip are regions too.
 */
export interface ContentRegion {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export const FULL_FRAME: ContentRegion = { x1: 0, y1: 0, x2: 1, y2: 1 };
/** No region, or one covering the whole frame: the classic stack (frame on top, zoomed speaker below). */
export function isFullFrame(c: ContentRegion | undefined | null): boolean {
  return !c || (c.x1 <= 0.01 && c.y1 <= 0.01 && c.x2 >= 0.99 && c.y2 >= 0.99);
}
/** Which edge a full-height region hugs, or null for any other shape. */
export function contentSide(c: ContentRegion): "left" | "right" | null {
  if (c.y1 > 0.01 || c.y2 < 0.99) return null;
  if (c.x1 <= 0.01 && c.x2 < 0.99) return "left";
  if (c.x2 >= 0.99 && c.x1 > 0.01) return "right";
  return null;
}
/** "Stack" for the whole frame, "Stack · content left 50%" for a region. */
export function contentLabel(c: ContentRegion | undefined | null): string {
  if (isFullFrame(c)) return "Stack";
  const side = contentSide(c!);
  return `Stack · content ${side ?? "inset"} ${Math.round((c!.x2 - c!.x1) * 100)}%`;
}

/**
 * Geometry of a "stack" with a content region: the top half shows only the region, the bottom half
 * the speaker cropped from the part of the frame the region is not on. Source pixels, shared by the
 * renderer and the editor preview. Region bounds come from a probe on a 320 px wide frame (±1% of
 * the width), so both crops keep 1.2% of the width clear of a shared edge.
 */
export function contentStackGeometry(
  srcW: number,
  srcH: number,
  content: ContentRegion,
  face: { cy: number; size: number },
  halfAspect: number,
  avoid: Array<{ y1: number; y2: number }> = [],
): { content: { x: number; y: number; w: number; h: number }; free: { lo: number; hi: number }; zoom: { w: number; h: number; y: number } } {
  const gap = 0.012 * srcW;
  const side = contentSide(content);
  const x = side === "right" ? content.x1 * srcW + gap : side === "left" ? 0 : content.x1 * srcW;
  const w = side === "left" ? content.x2 * srcW - gap - x : content.x2 * srcW - x;
  const free = side === "right" ? { lo: 0, hi: content.x1 * srcW - gap } : side === "left" ? { lo: content.x2 * srcW + gap, hi: srcW } : { lo: 0, hi: srcW };
  let zoom = speakerCrop(srcW, srcH, halfAspect, face, avoid);
  if (zoom.w > free.hi - free.lo) {
    // the speaker's side of the frame is narrower than the usual crop: use all of it
    const zw = free.hi - free.lo;
    const h = Math.min(srcH, zw / halfAspect);
    zoom = { w: zw, h, y: Math.max(0, Math.min(srcH - h, face.cy * srcH - 0.42 * h)) };
  }
  return { content: { x, y: content.y1 * srcH, w, h: (content.y2 - content.y1) * srcH }, free, zoom };
}

/** Left edge of a crop of width `w` centred on normalized x `cx`, kept inside the frame. */
export function cropX(srcW: number, w: number, cx: number) {
  return Math.max(0, Math.min(srcW - w, cx * srcW - w / 2));
}

// ---------- issue reports ----------

/** Report zip format; the importer refuses newer major versions. */
export const REPORT_FORMAT = 1;

export const reportIncludeSchema = z.object({
  /** this project's log lines */
  logs: z.boolean().default(true),
  /** versions, machine resources, queue state, usage and the instance's recent errors */
  system: z.boolean().default(true),
  /**
   * Admin-only: unfinished work, failed jobs, usage and error logs across every account.
   * For problems that are not just the reporter's projects. Off unless the caller is an admin.
   */
  instance: z.boolean().default(false),
  /** thumbnails and the selected clip's rendered video */
  previews: z.boolean().default(true),
  /** every rendered clip */
  allClips: z.boolean().default(false),
  /** the source video file (can be large) */
  source: z.boolean().default(false),
});
export type ReportInclude = z.infer<typeof reportIncludeSchema>;

export const reportClientSchema = z
  .object({
    route: z.string().max(2000),
    userAgent: z.string().max(500),
    viewport: z.string().max(40),
    theme: z.string().max(20),
    errors: z.array(z.object({ at: z.string().max(40), kind: z.string().max(40), message: z.string().max(4000), stack: z.string().max(8000).optional() })).max(100),
  })
  .partial();

export const reportRequestSchema = z.object({
  description: z.string().trim().min(3, "Describe what went wrong").max(10000),
  /** clips the report is about (their renders are included with previews) */
  clipIds: z.array(z.string().max(100)).max(50).default([]),
  include: reportIncludeSchema.default({ logs: true, system: true, instance: false, previews: true, allClips: false, source: false }),
  client: reportClientSchema.default({}),
});
export type ReportRequest = z.infer<typeof reportRequestSchema>;

// ---------- Clip boundaries ----------

/**
 * Words a thought cannot end on ("…and you're now so", "…the", "…to"). A pause or a capital letter
 * after one of these is a hesitation or a transcription artefact, not a sentence end. Deliberately
 * small: it only has to stop the common mid-sentence cuts, and a missing word costs a missed
 * extension, never a wrong cut. Lower-case, apostrophes normalised to "'".
 */
export const CONNECTOR_WORDS: ReadonlySet<string> = new Set([
  "and", "but", "or", "so", "nor", "yet", "that", "which", "who", "whose", "where", "because", "if", "when", "while", "as", "than", "then", "although", "though", "unless", "until", "since",
  "to", "of", "the", "a", "an", "with", "from", "by",
  "my", "your", "our", "their", "his", "her", "its",
  "is", "are", "was", "were", "be", "been", "am", "do", "does", "did", "not",
  "i'm", "i've", "i'll", "i'd", "you're", "you've", "you'll", "you'd", "we're", "we've", "we'll", "they're", "they've", "they'll",
  "he's", "she's", "it's", "that's", "there's", "what's", "let's", "don't", "can't", "won't",
]);

export * from "./tokens.js";
export * from "./billing.js";
export * from "./accounts.js";
export * from "./captions-format.js";
