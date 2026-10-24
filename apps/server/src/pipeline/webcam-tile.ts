/**
 * Webcam tile: the speaker of a screen share or meeting recording is often a small
 * picture-in-picture box (Zoom, Teams, Meet, OBS) in a corner, over the slides or in a black band
 * beside them. A face-sized crop (`speakerCrop`) has a floor of 42% of the frame height so a
 * distant speaker in a wide shot still gets context; on a tile a quarter of the frame wide that
 * floor reaches past the tile into the slide, the band and the name plate. This module finds the
 * tile's rectangle from the frames the face detector already decodes, so the stack's speaker pane
 * can show the tile and nothing else (`tileCrop` in @reelsaw/shared), and, when the tile sits in a
 * flat band along one edge of the frame, the band is left out of the top pane as well (the content
 * region is the rest of the frame).
 *
 * Per frame (`probeTiles`): from the face box outward in each direction, the few nearest straight
 * luma edges that stand out from the other columns (rows) in reach, or the frame edge; every
 * rectangle they make whose four edges hold over its whole span, encloses the face with a margin,
 * and has a plausible size and aspect. A frame where the detector missed the face is probed around
 * the last (or next) face seen, since a tile does not move. Per clip (`aggregateTile`): the
 * rectangles are clustered by position across frames and the cluster seen in the most frames wins;
 * a door frame or a shoulder line inside the webcam picture is a valid rectangle in some frames (the
 * person covers it in the others), the tile's border in all of them, and on a tie the outer one is
 * the tile. Precision over recall: no tile means the crop stays as it was.
 */

import type { ContentRegion } from "@reelsaw/shared";
import type { PBox } from "./content-region.js";

export type BandSide = "left" | "right" | "top" | "bottom";

export interface TileProbe extends ContentRegion {
  /** weakest of the four edges (mean |Δluma| along the edge, 0..1; 1 for a frame edge) */
  s: number;
  /** the tile sits in a flat strip along this frame edge (a black column beside the slides) */
  band?: BandSide;
}

export const TILE = {
  /** an edge counts from this mean luma step (the slide/band boundary measures ~0.6, a webcam's inner edges ~0.1-0.2) */
  minEdge: 0.16,
  /** … and must be this many times the typical column (row) in reach, so a textured slide does not pass as an edge */
  prominence: 2.5,
  /** the tile reaches at most this far from the face centre, as a fraction of the frame */
  reach: 0.45,
  /** per side, the nearest candidate edges tried, nearest first */
  candidates: 4,
  /** the tile is at least this many face widths / heights big … */
  minFaceMul: 1.4,
  /** … and at most this share of the frame on either axis (bigger is a shot, not a tile) */
  maxFrac: 0.6,
  /** a webcam is a landscape camera: 4:3 to 16:9 with some slack (width / height in source pixels) */
  minAspect: 1.2,
  maxAspect: 2.1,
  /** the face box keeps this share of its own size clear of the tile's edges */
  faceMargin: 0.1,
  /** an edge holds along its span when every quarter of it has at least this mean step … */
  partEdge: 0.04,
  /** … and stands out this many times from the column (row) 3 px outside the rectangle (a webcam border over a dark room measures ~1.5) */
  partProminence: 1.4,
  /** a candidate edge this close to the frame edge is the frame edge (the last column is often a dark encoder line) */
  snap: 2,
  /** a frame with no face is probed around the last face seen up to this long before it, or the next face up to `backSec` after it */
  holdSec: 30,
  backSec: 10,
  /** per clip: a cluster of rectangles seen in at least this share of the best cluster's frames ties with it, and the outer one wins */
  tie: 0.9,
  /** a strip is a flat band when at most this share of its pixels differ from its median luma by more than `bandStep` (a name plate in a black column is a few percent) */
  bandUneven: 0.1,
  bandStep: 0.08,
  /** the row (column) 3 px inside each edge must show at least this mean |Δluma| in 3 of 4 quarters: a webcam picture, even a dark wall, not a flat band */
  innerMin: 0.004,
  /** the content left when a band is removed must be at least this wide / tall */
  minContent: 0.4,
  /** per clip: share of frames that must show the tile, and how far each edge may sit from the cluster's first member */
  minShare: 0.6,
  stable: 0.04,
};

function luma(rgb: Uint8Array, n: number): Float32Array {
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = (0.299 * rgb[i * 3]! + 0.587 * rgb[i * 3 + 1]! + 0.114 * rgb[i * 3 + 2]!) / 255;
  return L;
}

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** Mean |L[x+1] - L[x-1]| over rows [y1, y2) at column x: how much of a vertical line sits there. */
function vEdge(L: Float32Array, w: number, x: number, y1: number, y2: number): number {
  if (x < 1 || x >= w - 1 || y2 <= y1) return 0;
  let sum = 0;
  for (let y = y1; y < y2; y++) sum += Math.abs(L[y * w + x + 1]! - L[y * w + x - 1]!);
  return sum / (y2 - y1);
}
/** Mean |L[y+1] - L[y-1]| over columns [x1, x2) at row y. */
function hEdge(L: Float32Array, w: number, h: number, y: number, x1: number, x2: number): number {
  if (y < 1 || y >= h - 1 || x2 <= x1) return 0;
  let sum = 0;
  for (let x = x1; x < x2; x++) sum += Math.abs(L[(y + 1) * w + x]! - L[(y - 1) * w + x]!);
  return sum / (x2 - x1);
}

/**
 * Mean strength of the vertical edge at column x over rows [y1, y2) when it holds along the whole
 * span, else 0: each quarter of the span must exist and stand out from the column 3 px outside the
 * rectangle (`inside` is +1 when the rectangle lies to the right of x), which neither texture (the
 * same |Δ| everywhere) nor a flat band (none anywhere) does. A mean over the span alone would let
 * one strong stretch carry a rectangle out across the slide or the band. The inside is not compared:
 * a webcam picture has content right up to its border.
 */
function vHold(L: Float32Array, w: number, x: number, y1: number, y2: number, inside: 1 | -1): number {
  const n = y2 - y1;
  if (n < 4) return 0;
  let total = 0;
  for (let q = 0; q < 4; q++) {
    const a = y1 + Math.floor((n * q) / 4);
    const b = y1 + Math.floor((n * (q + 1)) / 4);
    const e = vEdge(L, w, x, a, b);
    if (e < TILE.partEdge || e < vEdge(L, w, x - 3 * inside, a, b) * TILE.partProminence) return 0;
    total += e * (b - a);
  }
  return total / n;
}
function hHold(L: Float32Array, w: number, h: number, y: number, x1: number, x2: number, inside: 1 | -1): number {
  const n = x2 - x1;
  if (n < 4) return 0;
  let total = 0;
  for (let q = 0; q < 4; q++) {
    const a = x1 + Math.floor((n * q) / 4);
    const b = x1 + Math.floor((n * (q + 1)) / 4);
    const e = hEdge(L, w, h, y, a, b);
    if (e < TILE.partEdge || e < hEdge(L, w, h, y - 3 * inside, a, b) * TILE.partProminence) return 0;
    total += e * (b - a);
  }
  return total / n;
}

/**
 * Candidate edge positions on one side of the face, nearest first: the prominent columns (rows)
 * between `from` (just outside the face) and `to` (the reach limit, or the frame edge), then the
 * frame edge itself when the reach gets there. `strength(i)` measures the edge at position i.
 */
function candidates(from: number, to: number, step: 1 | -1, limit: number, strength: (i: number) => number): Array<{ at: number; s: number }> {
  const vals: number[] = [];
  for (let i = from; step > 0 ? i <= to : i >= to; i += step) vals.push(strength(i));
  const typical = median(vals);
  const floor = Math.max(TILE.minEdge, typical * TILE.prominence);
  const out: Array<{ at: number; s: number }> = [];
  for (let k = 0; k < vals.length && out.length < TILE.candidates; k++) {
    const s = vals[k]!;
    if (s < floor) continue;
    const at = from + k * step;
    // an edge right at the frame edge is the frame edge
    if (to === limit && Math.abs(at - limit) <= TILE.snap) break;
    // one candidate per edge: a run of adjacent columns over the floor (a soft or two-pixel edge,
    // a thin line) is its strongest column
    const last = out[out.length - 1];
    if (last && Math.abs(last.at - at) <= 2) {
      if (s > last.s) out[out.length - 1] = { at, s };
      continue;
    }
    out.push({ at, s });
  }
  if (to === limit) out.push({ at: limit, s: 1 });
  return out;
}

/** The candidate edges on each side of the face and every rectangle they make, for `reelsaw faces` and tests. */
export interface TileCandidates {
  left: Array<{ at: number; s: number }>;
  right: Array<{ at: number; s: number }>;
  top: Array<{ at: number; s: number }>;
  bottom: Array<{ at: number; s: number }>;
  /** every rectangle that passed the size, aspect and edge checks, smallest first, each with its weakest edge and band */
  rects: TileProbe[];
}

/**
 * The rectangles that could be the webcam tile around `box` on one frame (`rgb` is w×h×3, `box`
 * normalized; `srcAspect` is the source's width / height, since the raster is not aspect-preserving),
 * smallest first; empty when no rectangle of plausible size and shape encloses the face with
 * straight edges on all four sides. `aggregateTile` picks one across frames.
 */
export function probeTiles(rgb: Uint8Array, w: number, h: number, box: PBox, srcAspect = 16 / 9): TileProbe[] {
  return tileCandidates(rgb, w, h, box, srcAspect).rects;
}

export function tileCandidates(rgb: Uint8Array, w: number, h: number, box: PBox, srcAspect = 16 / 9): TileCandidates {
  const none: TileCandidates = { left: [], right: [], top: [], bottom: [], rects: [] };
  const L = luma(rgb, w * h);
  const fx1 = box.x1 * w;
  const fx2 = box.x2 * w;
  const fy1 = box.y1 * h;
  const fy2 = box.y2 * h;
  const fw = fx2 - fx1;
  const fh = fy2 - fy1;
  if (fw < 2 || fh < 2) return none;
  const cx = (fx1 + fx2) / 2;
  const cy = (fy1 + fy2) / 2;
  // the face band the first pass measures vertical edges over (and the column band for horizontal ones)
  const ry1 = clampInt(fy1 - 0.5 * fh, 0, h);
  const ry2 = clampInt(fy2 + 0.5 * fh, 0, h);
  const cx1 = clampInt(fx1 - 0.5 * fw, 0, w);
  const cx2 = clampInt(fx2 + 0.5 * fw, 0, w);
  const reachX = TILE.reach * w;
  const reachY = TILE.reach * h;
  const lefts = candidates(clampInt(fx1 - 0.3 * fw, 1, w - 2), clampInt(cx - reachX, 0, w - 1), -1, 0, (x) => (x === 0 ? 0 : vEdge(L, w, x, ry1, ry2)));
  const rights = candidates(clampInt(fx2 + 0.3 * fw, 1, w - 2), clampInt(cx + reachX, 0, w - 1), 1, w - 1, (x) => (x === w - 1 ? 0 : vEdge(L, w, x, ry1, ry2)));
  const tops = candidates(clampInt(fy1 - 0.3 * fh, 1, h - 2), clampInt(cy - reachY, 0, h - 1), -1, 0, (y) => (y === 0 ? 0 : hEdge(L, w, h, y, cx1, cx2)));
  const bottoms = candidates(clampInt(fy2 + 0.3 * fh, 1, h - 2), clampInt(cy + reachY, 0, h - 1), 1, h - 1, (y) => (y === h - 1 ? 0 : hEdge(L, w, h, y, cx1, cx2)));
  const minW = TILE.minFaceMul * fw;
  const minH = TILE.minFaceMul * fh;
  const maxW = TILE.maxFrac * w;
  const maxH = TILE.maxFrac * h;
  const mx = TILE.faceMargin * fw;
  const my = TILE.faceMargin * fh;
  const hold = TILE.minEdge * 0.8;
  // every rectangle of plausible size, nearest edges first (candidates are nearest-first on every side)
  const rects: Array<TileProbe & { area: number }> = [];
  for (const t of tops)
    for (const b of bottoms) {
      const th = b.at - t.at;
      if (th < minH || th > maxH || t.at > fy1 - my || b.at < fy2 + my) continue;
      for (const l of lefts)
        for (const r of rights) {
          const tw = r.at - l.at;
          if (tw < minW || tw > maxW || l.at > fx1 - mx || r.at < fx2 + mx) continue;
          // the rectangle's shape in source pixels (the raster is 320x240 whatever the source)
          const aspect = (tw / w / (th / h)) * srcAspect;
          if (aspect < TILE.minAspect || aspect > TILE.maxAspect) continue;
          // each edge must hold over the rectangle's whole span, not just beside the face
          const sl = l.at === 0 ? 1 : vHold(L, w, l.at, t.at, b.at + 1, 1);
          const sr = r.at === w - 1 ? 1 : vHold(L, w, r.at, t.at, b.at + 1, -1);
          const st = t.at === 0 ? 1 : hHold(L, w, h, t.at, l.at, r.at + 1, 1);
          const sb = b.at === h - 1 ? 1 : hHold(L, w, h, b.at, l.at, r.at + 1, -1);
          const s = Math.min(sl, sr, st, sb);
          if (s < hold) continue;
          // a picture right up to every edge, frame edges included: a rectangle drawn around the flat band
          // above the tile (band edge, frame top, tile bottom) is not the tile
          if (!pictureInside((p, q) => vEdge(L, w, l.at + 3, p, q), t.at, b.at + 1) || !pictureInside((p, q) => vEdge(L, w, r.at - 3, p, q), t.at, b.at + 1)) continue;
          if (!pictureInside((p, q) => hEdge(L, w, h, t.at + 3, p, q), l.at, r.at + 1) || !pictureInside((p, q) => hEdge(L, w, h, b.at - 3, p, q), l.at, r.at + 1)) continue;
          rects.push({
            x1: Number((l.at / w).toFixed(3)),
            y1: Number((t.at / h).toFixed(3)),
            x2: Number(((r.at + 1) / w).toFixed(3)),
            y2: Number(((b.at + 1) / h).toFixed(3)),
            s: Number(s.toFixed(3)),
            area: tw * th,
          });
        }
    }
  rects.sort((a, b) => a.area - b.area);
  const out = rects.map(({ area: _a, ...t }): TileProbe => {
    const band = flatBand(L, w, h, { x1: Math.round(t.x1 * w), y1: Math.round(t.y1 * h), x2: Math.round(t.x2 * w), y2: Math.round(t.y2 * h) });
    return band ? { ...t, band } : t;
  });
  return { left: lefts, right: rights, top: tops, bottom: bottoms, rects: out };
}

/**
 * Share of a rectangle's pixels (minus the tile's own, and a 2 px rim at the tile's edges where the
 * neighbour bleeds in) that differ from the rectangle's median luma by more than `bandStep`: 0 for a
 * flat band, a few percent with a name plate in it, most of them for a slide or a window.
 */
function unevenShare(L: Float32Array, w: number, r: { x1: number; y1: number; x2: number; y2: number }, hole: { x1: number; y1: number; x2: number; y2: number }): number {
  const hx1 = hole.x1 - 2;
  const hx2 = hole.x2 + 2;
  const hy1 = hole.y1 - 2;
  const hy2 = hole.y2 + 2;
  const vals: number[] = [];
  for (let y = r.y1; y < r.y2; y++)
    for (let x = r.x1; x < r.x2; x++) {
      if (x >= hx1 && x < hx2 && y >= hy1 && y < hy2) continue;
      vals.push(L[y * w + x]!);
    }
  if (vals.length < 16) return 1;
  const mid = median(vals);
  let off = 0;
  for (const v of vals) if (Math.abs(v - mid) > TILE.bandStep) off++;
  return off / vals.length;
}

/** True when the row (column) 3 px inside an edge shows a picture in at least 3 of its 4 quarters (a flat band shows none): the rectangle is not drawn around empty space. */
function pictureInside(strength: (a: number, b: number) => number, from: number, to: number): boolean {
  const n = to - from;
  if (n < 4) return false;
  let ok = 0;
  for (let q = 0; q < 4; q++) if (strength(from + Math.floor((n * q) / 4), from + Math.floor((n * (q + 1)) / 4)) >= TILE.innerMin) ok++;
  return ok >= 3;
}

/**
 * The flat strip the tile sits in, if any: a tile flush with a frame edge whose whole column (row)
 * from the tile's inner edge to the frame edge is one flat colour apart from the tile, and leaves
 * at least `minContent` of the frame on the other side. The narrowest strip wins when two qualify.
 */
function flatBand(L: Float32Array, w: number, h: number, t: { x1: number; y1: number; x2: number; y2: number }): BandSide | undefined {
  const flush = { left: t.x1 <= 1, right: t.x2 >= w - 1, top: t.y1 <= 1, bottom: t.y2 >= h - 1 };
  const tries: Array<{ side: BandSide; strip: { x1: number; y1: number; x2: number; y2: number }; width: number }> = [];
  if (flush.right && t.x1 / w >= TILE.minContent) tries.push({ side: "right", strip: { x1: t.x1, y1: 0, x2: w, y2: h }, width: 1 - t.x1 / w });
  if (flush.left && 1 - t.x2 / w >= TILE.minContent) tries.push({ side: "left", strip: { x1: 0, y1: 0, x2: t.x2, y2: h }, width: t.x2 / w });
  if (flush.bottom && t.y1 / h >= TILE.minContent) tries.push({ side: "bottom", strip: { x1: 0, y1: t.y1, x2: w, y2: h }, width: 1 - t.y1 / h });
  if (flush.top && 1 - t.y2 / h >= TILE.minContent) tries.push({ side: "top", strip: { x1: 0, y1: 0, x2: w, y2: t.y2 }, width: t.y2 / h });
  tries.sort((a, b) => a.width - b.width);
  for (const s of tries) if (unevenShare(L, w, s.strip, t) <= TILE.bandUneven) return s.side;
  return undefined;
}

export interface ClipTile {
  tile: ContentRegion;
  band?: BandSide;
  /** share of face frames that showed the tile */
  share: number;
}

/**
 * The clip's tile from the per-frame rectangles (`tiles` on each sample): rectangles are clustered
 * by position (every edge within `stable` of the cluster's first member), the cluster seen in the
 * most frames wins, and a cluster seen in nearly as many (`tie`) that lies outside it wins over it,
 * since a rectangle inside the tile is a line in the webcam picture. The tile is the cluster's
 * median rectangle; it must be seen in `minShare` of the frames. Frames probed around a face the
 * detector last saw count too (`sampleFaces`), so a webcam too small for the detector most of the
 * time still gives a steady tile.
 */
export function aggregateTile(samples: Array<{ tiles?: TileProbe[] }>): ClipTile | undefined {
  if (!samples.length) return undefined;
  const r3 = (v: number) => Number(v.toFixed(3));
  const within = (a: ContentRegion, b: ContentRegion) => Math.abs(a.x1 - b.x1) <= TILE.stable && Math.abs(a.y1 - b.y1) <= TILE.stable && Math.abs(a.x2 - b.x2) <= TILE.stable && Math.abs(a.y2 - b.y2) <= TILE.stable;
  const clusters: Array<{ seed: ContentRegion; members: TileProbe[]; frames: number }> = [];
  for (const s of samples) {
    const seen = new Set<number>();
    for (const t of s.tiles ?? []) {
      let k = clusters.findIndex((c) => within(c.seed, t));
      if (k < 0) k = clusters.push({ seed: t, members: [], frames: 0 }) - 1;
      clusters[k]!.members.push(t);
      // one frame counts once per cluster, however many near-identical rectangles it holds
      if (!seen.has(k)) {
        seen.add(k);
        clusters[k]!.frames++;
      }
    }
  }
  if (!clusters.length) return undefined;
  const best = Math.max(...clusters.map((c) => c.frames));
  if (best / samples.length < TILE.minShare) return undefined;
  const area = (c: ContentRegion) => (c.x2 - c.x1) * (c.y2 - c.y1);
  const pick = clusters.filter((c) => c.frames >= best * TILE.tie).sort((a, b) => area(b.seed) - area(a.seed))[0]!;
  const m = pick.members;
  const tile: ContentRegion = { x1: r3(median(m.map((t) => t.x1))), y1: r3(median(m.map((t) => t.y1))), x2: r3(median(m.map((t) => t.x2))), y2: r3(median(m.map((t) => t.y2))) };
  const bands = new Map<BandSide, number>();
  for (const t of m) if (t.band) bands.set(t.band, (bands.get(t.band) ?? 0) + 1);
  const top = [...bands.entries()].sort((a, b) => b[1] - a[1])[0];
  const band = top && top[1] / m.length >= TILE.minShare ? top[0] : undefined;
  return { tile, band, share: r3(pick.frames / samples.length) };
}

/** The content region of a stack whose tile sits in a band: the frame without the band. */
export function tileContent(tile: ContentRegion, band: BandSide): ContentRegion {
  switch (band) {
    case "right":
      return { x1: 0, y1: 0, x2: tile.x1, y2: 1 };
    case "left":
      return { x1: tile.x2, y1: 0, x2: 1, y2: 1 };
    case "bottom":
      return { x1: 0, y1: 0, x2: 1, y2: tile.y1 };
    case "top":
      return { x1: 0, y1: tile.y2, x2: 1, y2: 1 };
  }
}

/** "webcam tile top-right (x 0.87-1.00, y 0.09-0.20), in a flat band on the right". */
export function tileReason(c: ClipTile): string {
  const t = c.tile;
  const cx = (t.x1 + t.x2) / 2;
  const cy = (t.y1 + t.y2) / 2;
  const where = `${cy < 0.4 ? "top" : cy > 0.6 ? "bottom" : "middle"}-${cx < 0.4 ? "left" : cx > 0.6 ? "right" : "centre"}`;
  const f = (v: number) => v.toFixed(2);
  return `webcam tile ${where} (x ${f(t.x1)}-${f(t.x2)}, y ${f(t.y1)}-${f(t.y2)})${c.band ? `, in a flat band on the ${c.band}` : ""}`;
}
