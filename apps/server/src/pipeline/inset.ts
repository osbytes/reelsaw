/**
 * Inset picture: a narrower video placed in the middle of the frame with flat or blurred bars on
 * both sides (pillarboxing). A phone clip in a 16:9 edit is the usual case: the picture is already
 * vertical, and the sides are a blurred, stretched copy of it (or black). Framing such a shot as
 * the whole frame shrinks the real picture to a third of the output's width; following a face
 * slides the crop onto the bars. The picture itself is the crop: near 9:16 it fills the output,
 * any other shape (a square or 4:3 inset) is fitted over a blurred copy of itself.
 *
 * Per frame (`probeInset`): a pair of vertical edges placed symmetrically about the centre, with
 * flat sides (little vertical detail: blur or a solid fill) and a detailed picture between them,
 * where the step from flat to detailed holds in most horizontal bands of the frame, so a person in
 * front of a plain wall (flat on both sides, but no straight edge from top to bottom) does not pass.
 * Per stretch (`insetRuns`): single frames do pass by chance (a centred document, a dark
 * room), so an inset counts only where the same bounds hold for most samples over a couple of
 * seconds. Precision over recall: no inset means the layout stays as it was.
 */

import type { ContentRegion } from "@reelsaw/shared";

/** Bounds of the picture across the frame (normalized x); the picture spans the full height. */
export interface InsetProbe {
  x1: number;
  x2: number;
}

export const INSET = {
  /** horizontal bands checked for the flat-to-detailed step */
  bands: 6,
  /** bands (of `bands`) in which both edges must show the step */
  minBands: 5,
  /** the picture's left edge is searched from here to `maxEdge` of the width; the right edge mirrors it */
  minEdge: 0.06,
  maxEdge: 0.42,
  /** px the right edge may sit off the mirror of the left one (a picture placed 1 px off centre) */
  skew: 2,
  /** columns either side of an edge compared, starting this far from it */
  near: 2,
  span: 5,
  /** a band shows the step when the detail inside is this many times the detail outside, plus `stepFloor` (0..255 luma units) … */
  stepRatio: 2,
  stepFloor: 0.4,
  /** … or when the luma jumps by `edgeStep` across an edge whose outside is flatter than `flatMax` (a black bar beside a dark picture) */
  edgeStep: 8,
  flatMax: 1.5,
  /** whole sides: their mean detail is at most this share of the picture's, and at most `sideMax` (blur measures 0.05-0.4, a plain wall in focus more) */
  sideRatio: 0.35,
  sideMax: 2.5,
  /** an inset wider than this (width / height, source pixels) is a frame with margins, not a picture to crop to; 4:3 is 1.33 */
  maxAspect: 1.37,
  /** frames showing an inset of other bounds keep a stretch going for this long */
  bridgeSec: 3,
  /** per stretch: samples whose bounds sit this close (normalized x) are the same inset … */
  same: 0.015,
  /** … which must show in this share of the stretch's samples … */
  minShare: 0.7,
  /** … over at least this many seconds */
  minSec: 2,
  /** a stretch's edge this close to a scene cut moves onto the cut */
  snapSec: 0.6,
  /** an inset whose shape is this close to 9:16 is trimmed to exactly 9:16, so it fills the output */
  fillTolerance: 0.12,
  /** pulled in from each detected edge so no column of the bar shows */
  margin: 0.003,
};

function luma(rgb: Uint8Array, n: number): Float32Array {
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.299 * rgb[i * 3]! + 0.587 * rgb[i * 3 + 1]! + 0.114 * rgb[i * 3 + 2]!;
  return L;
}

/** The inset of one decoded RGB frame, or undefined when the frame shows none. */
export function probeInset(rgb: Uint8Array, w: number, h: number): InsetProbe | undefined {
  const L = luma(rgb, w * h);
  const B = INSET.bands;
  const bh = Math.floor((h - 1) / B);
  if (bh < 2 || w < 40) return undefined;
  // per band and column: vertical detail (mean |Δluma| down the column) and the luma step across the column
  const detail = Array.from({ length: B }, () => new Float32Array(w));
  const step = Array.from({ length: B }, () => new Float32Array(w));
  const all = new Float32Array(w);
  for (let y = 0; y < B * bh; y++) {
    const b = Math.floor(y / bh);
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const d = Math.abs(L[row + w + x]! - L[row + x]!);
      detail[b]![x]! += d / bh;
      all[x]! += d / (B * bh);
      if (x > 0 && x < w - 1) step[b]![x]! += Math.abs(L[row + x + 1]! - L[row + x - 1]!) / bh;
    }
  }
  const mean = (a: Float32Array, from: number, to: number) => {
    let s = 0;
    let n = 0;
    for (let i = Math.max(0, from); i <= Math.min(w - 1, to); i++) {
      s += a[i]!;
      n++;
    }
    return n ? s / n : 0;
  };
  const peak = (a: Float32Array, x: number) => Math.max(a[x - 1] ?? 0, a[x]!, a[x + 1] ?? 0);
  const { near, span } = INSET;
  let best: { x1: number; x2: number; bands: number; contrast: number } | undefined;
  for (let x1 = Math.round(INSET.minEdge * w); x1 <= Math.round(INSET.maxEdge * w); x1++) {
    for (let d = -INSET.skew; d <= INSET.skew; d++) {
      const x2 = w - 1 - x1 + d;
      if (x2 - x1 < 8) continue;
      let bands = 0;
      let contrast = 0;
      for (let b = 0; b < B; b++) {
        const o1 = mean(detail[b]!, x1 - near - span, x1 - near);
        const i1 = mean(detail[b]!, x1 + near, x1 + near + span);
        const o2 = mean(detail[b]!, x2 + near, x2 + near + span);
        const i2 = mean(detail[b]!, x2 - near - span, x2 - near);
        const e1 = peak(step[b]!, x1);
        const e2 = peak(step[b]!, x2);
        const left = i1 > INSET.stepRatio * o1 + INSET.stepFloor || (e1 > INSET.edgeStep && o1 < INSET.flatMax);
        const right = i2 > INSET.stepRatio * o2 + INSET.stepFloor || (e2 > INSET.edgeStep && o2 < INSET.flatMax);
        if (left && right) bands++;
        contrast += e1 + e2 + i1 + i2 - o1 - o2;
      }
      if (!best || bands > best.bands || (bands === best.bands && contrast > best.contrast)) best = { x1, x2, bands, contrast };
    }
  }
  if (!best || best.bands < INSET.minBands) return undefined;
  const { x1, x2 } = best;
  const sideW = x1 - near + (w - 1 - (x2 + near));
  const side = (mean(all, 0, x1 - near) * (x1 - near + 1) + mean(all, x2 + near, w - 1) * (w - x2 - near)) / Math.max(1, sideW + 1);
  const picture = mean(all, x1 + near, x2 - near);
  if (side > INSET.sideRatio * picture || side > INSET.sideMax) return undefined;
  return { x1: Number((x1 / w).toFixed(4)), x2: Number(((x2 + 1) / w).toFixed(4)) };
}

/** A stretch of a clip (seconds on the samples' clock) where the picture is an inset at `region`. */
export interface InsetRun {
  start: number;
  end: number;
  region: ContentRegion;
  /** what was measured, before `fillRegion` trimmed it */
  bounds: InsetProbe;
}

const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

/**
 * The inset as the crop to show: pulled in from the bars by `margin`, and trimmed to exactly 9:16
 * (centred) when its shape is within `fillTolerance` of it, so it fills the output instead of
 * leaving slivers of blur. `srcAspect` is the source's width / height.
 */
export function fillRegion(p: InsetProbe, srcAspect: number, outAspect = 9 / 16): ContentRegion {
  let x1 = p.x1 + INSET.margin;
  let x2 = p.x2 - INSET.margin;
  let y1 = 0;
  let y2 = 1;
  const aspect = ((x2 - x1) * srcAspect) / (y2 - y1);
  if (Math.abs(aspect / outAspect - 1) <= INSET.fillTolerance) {
    if (aspect > outAspect) {
      const w = outAspect / srcAspect;
      const cx = (x1 + x2) / 2;
      x1 = cx - w / 2;
      x2 = cx + w / 2;
    } else {
      const hh = ((x2 - x1) * srcAspect) / outAspect;
      y1 = (1 - hh) / 2;
      y2 = y1 + hh;
    }
  }
  const r4 = (v: number) => Number(Math.max(0, Math.min(1, v)).toFixed(4));
  return { x1: r4(x1), y1: r4(y1), x2: r4(x2), y2: r4(y2) };
}

/**
 * Stretches where the same inset holds. Samples are grouped by their bounds (within `same` of the
 * bounds most frames share); in each group, members no more than a second apart (or up to `bridgeSec` apart with other insets between) form a stretch, kept when it spans at least `minSec`
 * with the inset in at least `minShare` of the samples over it. The picture's own cuts (a phone video
 * edited with jump cuts) do not break a stretch, since the bars stay put; a shot without the inset
 * longer than the gap does. Where stretches of two groups overlap the longer one wins. Edges snap to
 * a scene cut within `snapSec`, and to the clip's ends when the inset is on screen within a gap of
 * them. Samples are in time order; `inset` absent = the frame showed none.
 */
export function insetRuns(
  samples: ReadonlyArray<{ t: number; inset?: InsetProbe | undefined }>,
  duration: number,
  sceneCuts: number[] = [],
  srcAspect = 16 / 9,
): InsetRun[] {
  if (!samples.length) return [];
  const dt = samples.length > 1 ? (samples.at(-1)!.t - samples[0]!.t) / (samples.length - 1) : 0.25;
  const gap = Math.max(1, 4 * dt);
  // group by bounds, densest first: the bounds most frames agree with seed a group, which takes every
  // frame within `same` of them (a first frame caught mid-transition would otherwise split the rest)
  const near = (p: InsetProbe, q: InsetProbe) => Math.abs(p.x1 - q.x1) <= INSET.same && Math.abs(p.x2 - q.x2) <= INSET.same;
  const open = samples.flatMap((s, i) => (s.inset ? [i] : []));
  const groups: Array<{ members: number[] }> = [];
  while (open.length) {
    let seed = open[0]!;
    let most = -1;
    for (const i of open) {
      const n = open.filter((j) => near(samples[i]!.inset!, samples[j]!.inset!)).length;
      if (n > most) {
        most = n;
        seed = i;
      }
    }
    const members = open.filter((j) => near(samples[seed]!.inset!, samples[j]!.inset!));
    groups.push({ members });
    for (const j of members) open.splice(open.indexOf(j), 1);
  }
  const snap = (t: number) => sceneCuts.find((c) => Math.abs(c - t) <= INSET.snapSec) ?? t;
  // two members of a group belong to one stretch when at most a gap apart, or up to `bridgeSec` apart
  // with an inset in every frame between (the probe took a darker edge for the bar for a moment)
  const bridged = (i: number, j: number) => {
    const span = samples[j]!.t - samples[i]!.t;
    if (span <= gap) return true;
    if (span > INSET.bridgeSec) return false;
    for (let k = i + 1; k < j; k++) if (!samples[k]!.inset) return false;
    return true;
  };
  const candidates: InsetRun[] = [];
  for (const g of groups) {
    let from = 0;
    for (let k = 1; k <= g.members.length; k++) {
      if (k < g.members.length && bridged(g.members[k - 1]!, g.members[k]!)) continue;
      const idx = g.members.slice(from, k);
      from = k;
      const a = samples[idx[0]!]!.t;
      const b = samples[idx.at(-1)!]!.t + dt;
      const total = samples.filter((s) => s.t >= a - 1e-6 && s.t < b - 1e-6).length;
      if (b - a < INSET.minSec || idx.length / Math.max(1, total) < INSET.minShare) continue;
      const bounds = {
        x1: median(idx.map((i) => samples[i]!.inset!.x1)),
        x2: median(idx.map((i) => samples[i]!.inset!.x2)),
      };
      if ((bounds.x2 - bounds.x1) * srcAspect > INSET.maxAspect) continue;
      const start = a - samples[0]!.t <= gap ? 0 : snap(a);
      const end = samples.at(-1)!.t - samples[idx.at(-1)!]!.t <= gap ? duration : Math.min(duration, snap(b));
      candidates.push({ start, end, bounds, region: fillRegion(bounds, srcAspect) });
    }
  }
  // overlapping stretches: the longest keeps its time, the others keep what is left (if still long enough)
  const kept: InsetRun[] = [];
  for (const c of candidates.sort((p, q) => q.end - q.start - (p.end - p.start))) {
    let pieces = [{ start: c.start, end: c.end }];
    for (const k of kept)
      pieces = pieces.flatMap((pc) =>
        pc.end <= k.start || pc.start >= k.end
          ? [pc]
          : [
              { start: pc.start, end: k.start },
              { start: k.end, end: pc.end },
            ].filter((x) => x.end - x.start > 0),
      );
    for (const pc of pieces) if (pc.end - pc.start >= INSET.minSec) kept.push({ ...c, ...pc });
  }
  return kept.sort((p, q) => p.start - q.start);
}

/** "phone-shaped video in the middle of the frame (34–66% of the width), cropped to it" */
export function insetReason(r: InsetRun, srcAspect: number): string {
  const aspect = (r.bounds.x2 - r.bounds.x1) * srcAspect;
  const shape = aspect < 0.7 ? "vertical video" : aspect < 1.15 ? "square video" : "narrower video";
  const pct = (v: number) => Math.round(v * 100);
  return `${shape} inside the frame (${pct(r.bounds.x1)}–${pct(r.bounds.x2)}% of the width), cropped to it`;
}
