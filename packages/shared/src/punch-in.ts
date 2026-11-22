/**
 * Punch-in zooms: short, eased scale-ups of the picture on the clip's emphasis words (style `punchIn`,
 * `punchInScale`). One plan for the renderer (an ffmpeg expression of the same curve, `render.ts`) and the editor
 * preview (a canvas transform), so both zoom on the same words, by the same amount, at the same moments.
 *
 * Rules (docs/LAYOUTS.md, "Punch-in zooms"):
 * - only a piece whose picture fills the frame as one crop zooms: `face`, `center`, and a fixed crop or an inset
 *   shaped like the frame. A split or stack (two panes), a whole frame over a blur (`fit`) and `none` never zoom.
 * - a zoom never spans a break: a scene cut, a jump cut, or a change of layout. One that would is dropped, not
 *   shortened, so every zoom has its full ease in and out.
 * - each emphasis word zooms once (its first occurrence that fits), and zooms keep `PUNCH_IN.gap` apart.
 */
import { emphasisKey } from "./index.js";

export const PUNCH_IN = {
  /** the ease in starts this long before the word */
  lead: 0.1,
  /** ease in, seconds */
  in: 0.18,
  /** held this long after the word ends (a word shorter than `minWord` counts as that long) */
  hold: 0.35,
  minWord: 0.3,
  /** ease out, seconds */
  out: 0.4,
  /** at least this long between the end of one zoom and the start of the next */
  gap: 2.5,
  /** where the zoom is anchored vertically (fraction of the frame), kept inside this band */
  anchorMin: 0.3,
  anchorMax: 0.6,
  /** a fixed crop or inset within this of the frame's shape fills it (`fitPane` then has no blurred margin) */
  fillTolerance: 0.03,
} as const;

export interface PunchIn {
  /** start of the ease in and end of the ease out, seconds on the caller's clock */
  start: number;
  end: number;
  /** the emphasis word it zooms on, as spoken */
  word: string;
  /** zoom centre as fractions of the frame (x is always the middle) */
  ax: number;
  ay: number;
}

/** A crop of the source (fractions) whose shape is the frame's, so `fitPane` fills the frame with it. */
export function fillsFrame(region: { x1: number; y1: number; x2: number; y2: number }, srcW: number, srcH: number, frameAspect = 9 / 16): boolean {
  const w = (region.x2 - region.x1) * srcW;
  const h = (region.y2 - region.y1) * srcH;
  return h > 0 && Math.abs(w / h / frameAspect - 1) <= PUNCH_IN.fillTolerance;
}

/**
 * Whether a piece of a clip zooms, and about which height: a face crop about the face (kept in a band so the zoom
 * does not push the head out of the top), anything else about the middle. Null = this piece never zooms.
 */
export function punchInAnchor(
  piece: {
    layout: string;
    /** the user's fixed crop on the (only) pane */
    crop?: { x1: number; y1: number; x2: number; y2: number } | undefined;
    /** a picture inset between bars (`fit`) */
    inset?: { x1: number; y1: number; x2: number; y2: number } | undefined;
    /** the followed face's centre height, fraction of the source (a `face` crop is full height, so of the frame too) */
    cy?: number | undefined;
  },
  srcW: number,
  srcH: number,
  /** the output frame's width / height (`shape`) */
  frameAspect = 9 / 16,
): number | null {
  const fixed = piece.crop ?? (piece.layout === "fit" ? piece.inset : undefined);
  if (piece.layout === "split" || piece.layout === "stack" || piece.layout === "none") return null;
  if (fixed) return fillsFrame(fixed, srcW, srcH, frameAspect) ? 0.5 : null;
  if (piece.layout === "fit") return null;
  if (piece.layout === "face" && piece.cy !== undefined) return Math.round(Math.max(PUNCH_IN.anchorMin, Math.min(PUNCH_IN.anchorMax, piece.cy)) * 100) / 100;
  return 0.5;
}

/**
 * The zooms of a clip. `words` and `breaks` are on one clock (the clip's, before jump cuts); `anchorAt(t)` says
 * whether the picture at `t` may zoom and about which height (`punchInAnchor`), constant between two breaks.
 */
export function planPunchIns(
  words: ReadonlyArray<{ text: string; start: number; end: number }>,
  emphasis: ReadonlyArray<string>,
  opts: { start: number; end: number; breaks: ReadonlyArray<number>; anchorAt: (t: number) => number | null },
): PunchIn[] {
  const keys = new Set(emphasis.map(emphasisKey).filter(Boolean));
  if (!keys.size) return [];
  const done = new Set<string>();
  const out: PunchIn[] = [];
  const eps = 0.01;
  for (const w of words) {
    const key = emphasisKey(w.text);
    if (!keys.has(key) || done.has(key)) continue;
    const start = w.start - PUNCH_IN.lead;
    const end = Math.max(w.end, w.start + PUNCH_IN.minWord) + PUNCH_IN.hold + PUNCH_IN.out;
    if (start < opts.start || end > opts.end) continue;
    const last = out.at(-1);
    if (last && start < last.end + PUNCH_IN.gap) continue;
    if (opts.breaks.some((b) => b > start + eps && b < end - eps)) continue;
    const ay = opts.anchorAt(start + eps);
    if (ay === null || opts.anchorAt(end - eps) !== ay) continue;
    done.add(key);
    out.push({ start: round3(start), end: round3(end), word: w.text, ax: 0.5, ay });
  }
  return out;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const smooth = (u: number) => {
  const c = Math.max(0, Math.min(1, u));
  return c * c * (3 - 2 * c);
};

/** How far into its zoom the picture is at `t` (0 = not zoomed, 1 = fully), and which zoom; the renderer's expression is the same curve. */
export function punchInLevel(zooms: ReadonlyArray<PunchIn>, t: number): { level: number; zoom: PunchIn | null } {
  for (const z of zooms) {
    if (t <= z.start || t >= z.end) continue;
    return { level: Math.min(smooth((t - z.start) / PUNCH_IN.in), smooth((z.end - t) / PUNCH_IN.out)), zoom: z };
  }
  return { level: 0, zoom: null };
}
