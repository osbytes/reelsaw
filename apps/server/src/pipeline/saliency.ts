/**
 * Subject framing for shots without a face: b-roll of a ship or a car, a product turned in the hand, a
 * character running through a game level. Without a face the shot used to be shown whole over a
 * blurred background (`fit`), a picture a third of the output's width. When one thing in the shot
 * clearly moves and the rest of the picture does not, a full-height 9:16 crop that follows it is
 * what an editor (and Klap / OpusClip / Premiere Auto Reframe) does instead.
 *
 * Per frame (`probeMotion`), from the 320x240 frames the face detector already decodes: luma on an
 * 80x60 grid, the camera's own motion removed (the global shift that best matches the previous
 * frame, so a pan that follows a subject shows the subject still and the background moving, and the
 * shift takes the background out again), then the share of cells that still changed per column bin.
 * Per shot (`subjectFraming`): a frame votes when its moving cells are concentrated in one window
 * narrower than the 9:16 crop; the shot follows the votes when most active frames vote and the text
 * on screen would not be cut. A subject that stays put gives a stationary crop (the median), one
 * that moves gives a tripod track (`tripodTrack`, the face crop's camera), AutoFlip's per-shot
 * stationary / track choice. Anything else (diffuse motion: water, crowds, foliage, 3D gameplay; no
 * motion at all; a subject wider than the window; text that would be cut) stays `fit`: precision
 * over recall.
 */

import type { PBox } from "./content-region.js";

/** Moving-cell share per column bin of one frame against the previous one, camera motion removed. */
export interface MotionProbe {
  /** `SALIENCY.bins` values: share (0..1) of the bin's cells that changed, left to right */
  bins: number[];
  /** the camera's own shift that was removed, in grid cells (80 x 60 grid) */
  dx: number;
  dy: number;
}

export const SALIENCY = {
  /** analysis grid (cells), from the 320x240 decode */
  gridW: 80,
  gridH: 60,
  /** column bins of the stored profile (2 grid columns each, 2.5% of the width) */
  bins: 40,
  /** the camera shift searched, grid cells either way (7.5% of the width, 6.7% of the height per 0.25 s sample) */
  maxShiftX: 6,
  maxShiftY: 4,
  /** a cell moved when its luma changed by more than this (0..255) and `noiseK` times the frame's median change */
  minDelta: 14,
  noiseK: 3,
  /** a frame is active when this share of the whole frame moved … */
  minActive: 0.006,
  /** … and not more (a cut, a flash, a whip pan the shift cannot explain) */
  maxActive: 0.35,
  /** the window the subject must fit, as a share of the 9:16 crop's width (margin either side) */
  window: 0.85,
  /** a frame votes when this share of its moving cells lies in the window … */
  minConcentration: 0.7,
  /** … and the window itself moved this much (share of its cells): a flag fluttering at the edge is not a subject */
  minDensity: 0.025,
  /** per shot: frames with a probe, at least this many seconds of them (a crop that flashes in for a shorter shot reads as a glitch, and a second of motion does not establish a subject) … */
  minSec: 2,
  /** … active in this share of them … */
  minActiveShare: 0.5,
  /** … and of the active frames this share votes */
  minVoteShare: 0.65,
  /** a frame whose previous sample lies across a scene cut (within this slack of the cut) is skipped: it compares two shots */
  cutSlack: 0.06,
  /** vote centres spread (10th to 90th percentile) at most this much: a stationary crop at their median */
  stationary: 0.08,
  /** text on screen cut by the crop's edge in this share of the frames that show text: stay whole … */
  maxTextCut: 0.25,
  /** … counting text whose centre lies inside this band of the height (a watermark or caption line at the very top or bottom is cut by any crop and masked separately) */
  textBand: [0.1, 0.9] as [number, number],
  /** … or this many lines of text left outside the crop (a post, a caption card, a chart's labels beside the moving picture): the text is the content, the frame stays whole */
  maxTextDropped: 3,
  /** a source whose 9:16 crop keeps this share of the width already fits the output: nothing to follow */
  maxCropShare: 0.9,
};

function gridLuma(rgb: Uint8Array, w: number, h: number): Float32Array {
  const { gridW: GW, gridH: GH } = SALIENCY;
  const out = new Float32Array(GW * GH);
  const bx = w / GW;
  const by = h / GH;
  for (let gy = 0; gy < GH; gy++) {
    const y0 = Math.floor(gy * by);
    const y1 = Math.max(y0 + 1, Math.floor((gy + 1) * by));
    for (let gx = 0; gx < GW; gx++) {
      const x0 = Math.floor(gx * bx);
      const x1 = Math.max(x0 + 1, Math.floor((gx + 1) * bx));
      let sum = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 3;
          sum += 0.299 * rgb[i]! + 0.587 * rgb[i + 1]! + 0.114 * rgb[i + 2]!;
        }
      out[gy * GW + gx] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/**
 * Keeps the previous frame's grid and turns each new frame into a `MotionProbe` (undefined for the
 * first frame). One instance per decode pass.
 */
export function motionProber(w: number, h: number): (rgb: Uint8Array) => MotionProbe | undefined {
  let prev: Float32Array | undefined;
  return (rgb) => {
    const cur = gridLuma(rgb, w, h);
    const p = prev;
    prev = cur;
    return p ? probeMotion(p, cur) : undefined;
  };
}

/** Motion of `cur` against `prev` (both `gridLuma` grids), the best global shift removed. */
export function probeMotion(prev: Float32Array, cur: Float32Array): MotionProbe {
  const { gridW: GW, gridH: GH, maxShiftX: SX, maxShiftY: SY } = SALIENCY;
  // the camera's shift: the offset that best matches the previous frame over the interior (sum of |Δ|)
  let best = { dx: 0, dy: 0, sad: Infinity };
  for (let dy = -SY; dy <= SY; dy++)
    for (let dx = -SX; dx <= SX; dx++) {
      let sad = 0;
      for (let y = SY; y < GH - SY; y += 2) for (let x = SX; x < GW - SX; x += 2) sad += Math.abs(cur[y * GW + x]! - prev[(y + dy) * GW + x + dx]!);
      // ties go to no shift (a still camera), then the smaller shift
      if (sad < best.sad - 1e-6 || (Math.abs(sad - best.sad) <= 1e-6 && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy)))
        best = { dx, dy, sad };
    }
  const { dx, dy } = best;
  const delta = new Float32Array(GW * GH).fill(-1);
  const all: number[] = [];
  for (let y = 0; y < GH; y++)
    for (let x = 0; x < GW; x++) {
      const px = x + dx;
      const py = y + dy;
      if (px < 0 || py < 0 || px >= GW || py >= GH) continue; // uncovered by the shift: unknown, not motion
      const d = Math.abs(cur[y * GW + x]! - prev[py * GW + px]!);
      delta[y * GW + x] = d;
      all.push(d);
    }
  all.sort((a, b) => a - b);
  const noise = all[Math.floor(all.length / 2)] ?? 0;
  const thr = Math.max(SALIENCY.minDelta, SALIENCY.noiseK * noise);
  const per = GW / SALIENCY.bins;
  const moved = new Array<number>(SALIENCY.bins).fill(0);
  const cells = new Array<number>(SALIENCY.bins).fill(0);
  for (let y = 0; y < GH; y++)
    for (let x = 0; x < GW; x++) {
      const d = delta[y * GW + x]!;
      const b = Math.min(SALIENCY.bins - 1, Math.floor(x / per));
      cells[b]! += 1; // an uncovered cell counts as still: the bin's share stays comparable
      if (d > thr) moved[b]! += 1;
    }
  return { bins: moved.map((m, i) => Number((m / Math.max(1, cells[i]!)).toFixed(3))), dx, dy };
}

/** What the subject logic needs of a sample: its time, its motion probe and the text on screen. */
export interface SubjectSample {
  t: number;
  motion?: MotionProbe | undefined;
  text?: PBox[] | undefined;
}

export type SubjectFraming =
  | { ok: true; mode: "stationary" | "track"; points: Array<{ t: number; x: number }>; votes: number; active: number; frames: number }
  | { ok: false; rejected: string; votes: number; active: number; frames: number };

/** The window of `width` bins holding the most motion: its share of the frame's motion and its mass centre (normalized x). */
function bestWindow(bins: number[], width: number): { share: number; centre: number } {
  const total = bins.reduce((a, b) => a + b, 0);
  if (total <= 0) return { share: 0, centre: 0.5 };
  let bestSum = -1;
  let bestAt = 0;
  for (let i = 0; i + width <= bins.length; i++) {
    let s = 0;
    for (let j = i; j < i + width; j++) s += bins[j]!;
    if (s > bestSum) {
      bestSum = s;
      bestAt = i;
    }
  }
  let m = 0;
  for (let j = bestAt; j < bestAt + width; j++) m += bins[j]! * (j + 0.5);
  return { share: bestSum / total, centre: m / Math.max(1e-9, bestSum) / bins.length };
}

const pct = (xs: number[], q: number) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
};

/**
 * Decide whether one shot (or a piece of one) without a usable face gets a crop that follows its
 * moving subject. `cropShare` is the 9:16 crop's width as a share of the source width.
 */
export function subjectFraming(samples: SubjectSample[], sceneCuts: number[], cropShare: number): SubjectFraming {
  const S = SALIENCY;
  // a probe compares a frame with the sample before it: across a cut that is two different shots
  const gap = samples.length > 1 ? (samples.at(-1)!.t - samples[0]!.t) / (samples.length - 1) : 0.25;
  const probed = samples.filter((s) => s.motion && !sceneCuts.some((c) => c > s.t - gap - S.cutSlack && c <= s.t + S.cutSlack));
  const frames = probed.length;
  const none = (rejected: string, votes = 0, active = 0): SubjectFraming => ({ ok: false, rejected, votes, active, frames });
  if (cropShare >= S.maxCropShare) return none("the source already fits the output");
  if (!frames) return none("no motion measured");
  const dt = frames > 1 ? (probed.at(-1)!.t - probed[0]!.t) / (frames - 1) : 0.25;
  if (frames * dt < S.minSec) return none(`only ${(frames * dt).toFixed(1)}s measured`);
  const width = Math.max(2, Math.floor(cropShare * S.window * S.bins));
  const votes: Array<{ t: number; x: number }> = [];
  let active = 0;
  for (const s of probed) {
    const bins = s.motion!.bins;
    const share = bins.reduce((a, b) => a + b, 0) / bins.length;
    if (share < S.minActive || share > S.maxActive) continue;
    active++;
    const w = bestWindow(bins, width);
    const density = (w.share * share * bins.length) / width;
    if (w.share >= S.minConcentration && density >= S.minDensity) votes.push({ t: s.t, x: w.centre });
  }
  if (active / frames < S.minActiveShare) return none(`little motion (${Math.round((active / frames) * 100)}% of frames)`, votes.length, active);
  if (votes.length / active < S.minVoteShare)
    return none(`motion spread across the frame (${Math.round((votes.length / active) * 100)}% of active frames in one window)`, votes.length, active);
  const xs = votes.map((v) => v.x);
  const spread = pct(xs, 0.9) - pct(xs, 0.1);
  const mode = spread <= S.stationary ? "stationary" : "track";
  const points = mode === "stationary" ? [{ t: probed[0]!.t, x: pct(xs, 0.5) }] : votes;
  // text the crop would cut through (a title, a chart label, a slide): the shot stays whole
  const half = cropShare / 2;
  const at = (t: number) => {
    if (points.length === 1) return points[0]!.x;
    let best = points[0]!;
    for (const p of points) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best.x;
  };
  const withText = probed.filter((s) => s.text?.length);
  if (withText.length) {
    const cut = withText.filter((s) => {
      const c = Math.max(half, Math.min(1 - half, at(s.t)));
      const l = c - half;
      const r = c + half;
      const lines = s.text!.filter((b) => (b.y1 + b.y2) / 2 >= S.textBand[0] && (b.y1 + b.y2) / 2 <= S.textBand[1]);
      const crossed = lines.some((b) => (b.x1 < l - 0.01 && b.x2 > l + 0.01) || (b.x1 < r - 0.01 && b.x2 > r + 0.01));
      const dropped = lines.filter((b) => b.x2 <= l + 0.01 || b.x1 >= r - 0.01).length;
      return crossed || dropped >= S.maxTextDropped;
    }).length;
    if (cut / withText.length > S.maxTextCut)
      return none(`text on screen would be cut or left out (${Math.round((cut / withText.length) * 100)}% of frames with text)`, votes.length, active);
  }
  return { ok: true, mode, points, votes: votes.length, active, frames };
}

/** Reason text for a subject crop. */
export function subjectReason(f: Extract<SubjectFraming, { ok: true }>): string {
  const x = Math.round((f.points.reduce((a, p) => a + p.x, 0) / f.points.length) * 100);
  return `${f.mode === "stationary" ? `crop on the moving subject at ${x}%` : "crop follows the moving subject"} (${Math.round((f.votes / Math.max(1, f.active)) * 100)}% of active frames)`;
}
