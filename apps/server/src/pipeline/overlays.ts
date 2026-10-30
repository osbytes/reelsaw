/**
 * Find text burned into the source video (subtitles, channel watermarks) so renders can keep it out
 * of crops or mask it.
 *
 * Text detection alone also finds text that belongs to the scene (a sign on the wall, a logo on a
 * cap). The difference: overlays sit at the same screen position across different shots, scene text
 * moves or disappears when the camera cuts. So we sample frames across the whole video, mark text on
 * a coarse grid, and keep only cells that show text in several different shots.
 */
import { spawn } from "node:child_process";
import { ffmpegPipeThreads } from "../media.js";
import type { SourceOverlay, TextProfile } from "@reelsaw/shared";
import type { TextDetector } from "../vision/text.js";
import { TEXT_INPUT_W, TEXT_INPUT_H } from "../vision/text.js";
import { FACE_INPUT_W, FACE_INPUT_H, type FaceDetector } from "../vision/faces.js";
import { mapLimit } from "./select.js";

const GX = 48;
const GY = 27;
/** a frame whose text covers more than this share of the screen is a slide (recipe card, title card): content, not an overlay */
export const SLIDE_TEXT_SHARE = 0.22;

type Box = { x1: number; y1: number; x2: number; y2: number };
function textCells(boxes: Box[]): Set<number> {
  const cells = new Set<number>();
  for (const b of boxes)
    for (let gy = Math.floor(b.y1 * GY); gy < Math.ceil(b.y2 * GY); gy++)
      for (let gx = Math.floor(b.x1 * GX); gx < Math.ceil(b.x2 * GX); gx++) cells.add(gy * GX + gx);
  return cells;
}
export const isSlide = (boxes: Box[]) => textCells(boxes).size / (GX * GY) > SLIDE_TEXT_SHARE;
/** a stack of this many text lines is a paragraph (slide body, document, recipe card), never a caption or logo */
export const PARAGRAPH_LINES = 4;
/** a video is a presentation when at least this share of frames is text-heavy */
export const PRESENTATION_SHARE = 0.5;

/**
 * Split a frame's text boxes into overlay evidence and content. Lines that stack into a block of
 * PARAGRAPH_LINES or more (left/centre aligned, line-height spacing) are content: burned-in subtitles
 * are one to three lines, logos and handles one. Returns the remaining boxes and whether the frame is
 * text-heavy (a slide by area, or any paragraph).
 */
export function splitText(boxes: Box[]): { evidence: Box[]; paragraphs: Box[]; textHeavy: boolean; slide: boolean } {
  const n = boxes.length;
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const ha = a.y2 - a.y1;
      const hb = b.y2 - b.y1;
      const h = Math.min(ha, hb);
      if (Math.max(ha, hb) > 2.2 * h) continue; // a heading next to body text is still separate lines, but wildly different sizes aren't one block
      const gap = Math.max(a.y1, b.y1) - Math.min(a.y2, b.y2);
      if (gap > 0.9 * h || gap < -0.5 * h) continue; // stacked one under the other, not side by side
      const overlapX = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
      const alignedLeft = Math.abs(a.x1 - b.x1) < 0.02;
      if (overlapX < 0.3 * Math.min(a.x2 - a.x1, b.x2 - b.x1) && !alignedLeft) continue;
      parent[find(i)] = find(j);
    }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);
  const inPara = new Set<number>();
  for (const g of groups.values()) if (g.length >= PARAGRAPH_LINES) for (const i of g) inPara.add(i);
  const slide = isSlide(boxes);
  return {
    evidence: boxes.filter((_, i) => !inPara.has(i)),
    paragraphs: boxes.filter((_, i) => inPara.has(i)),
    textHeavy: slide || inPara.size > 0,
    slide,
  };
}

/** Merge regions that mostly overlap (the grid can split one band into two near-identical boxes). */
export function mergeRegions<O extends Box & { coverage?: number; kind?: string }>(regions: O[]): O[] {
  const out: O[] = [];
  for (const r of [...regions].sort((a, b) => (b.x2 - b.x1) * (b.y2 - b.y1) - (a.x2 - a.x1) * (a.y2 - a.y1))) {
    const m = out.find((o) => {
      const ix = Math.max(0, Math.min(o.x2, r.x2) - Math.max(o.x1, r.x1));
      const iy = Math.max(0, Math.min(o.y2, r.y2) - Math.max(o.y1, r.y1));
      const smaller = Math.min((o.x2 - o.x1) * (o.y2 - o.y1), (r.x2 - r.x1) * (r.y2 - r.y1));
      return smaller > 0 && (ix * iy) / smaller >= 0.6;
    });
    if (!m) out.push({ ...r });
    else {
      m.x1 = Math.min(m.x1, r.x1);
      m.y1 = Math.min(m.y1, r.y1);
      m.x2 = Math.max(m.x2, r.x2);
      m.y2 = Math.max(m.y2, r.y2);
      if (m.coverage !== undefined && r.coverage !== undefined) m.coverage = Math.max(m.coverage, r.coverage);
    }
  }
  return out;
}

/**
 * Burned-in text is pixel-stable: subtitle lines sit on one or two fixed baselines, logos never move.
 * Text printed on clothing or a prop drifts with it. A region whose boxes wander both vertically
 * (beyond ~2 line heights) and horizontally (beyond 5% of the width) is scene text.
 */
export function drifts(o: Box, boxes: Box[]): boolean {
  const own = boxes.filter((b) => {
    const cx = (b.x1 + b.x2) / 2;
    const cy = (b.y1 + b.y2) / 2;
    return cx >= o.x1 && cx <= o.x2 && cy >= o.y1 && cy <= o.y2;
  });
  if (own.length < 5) return false;
  const q = (xs: number[], p: number) => {
    const v = xs.slice().sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))]!;
  };
  const cys = own.map((b) => (b.y1 + b.y2) / 2);
  const cxs = own.map((b) => (b.x1 + b.x2) / 2);
  const h = q(
    own.map((b) => b.y2 - b.y1),
    0.5,
  );
  return q(cys, 0.9) - q(cys, 0.1) > 1.8 * h && q(cxs, 0.9) - q(cxs, 0.1) > 0.05;
}

/** a region this close to the left or right edge of the frame is anchored to it */
export const EDGE_MARGIN = 0.03;

/**
 * Game and app interface (scores, player lists, menu buttons) is pinned to the screen like burned-in
 * text, so the multi-shot test keeps it. It is content, not something to mask. Subtitles are centred
 * or span the frame; logos, handles and lower thirds sit in the top or bottom band. Narrow text off
 * centre, halfway down a side, is interface. Two or more such regions mean the video shows an
 * interface, and then narrow text hugging a side edge in the corners is part of it too (a player
 * list, menu icons); without them a corner box stays a logo.
 */
export function splitInterface<O extends Box>(overlays: O[]): { kept: O[]; ui: O[] } {
  const offCentre = (o: Box) => o.x2 - o.x1 < 0.25 && Math.abs((o.x1 + o.x2) / 2 - 0.5) > 0.2;
  const midSide = (o: Box) => {
    const cy = (o.y1 + o.y2) / 2;
    return cy > 0.2 && cy < 0.75;
  };
  const side = overlays.filter((o) => offCentre(o) && midSide(o));
  const ui = side.length >= 2 ? overlays.filter((o) => offCentre(o) && (midSide(o) || o.x1 <= EDGE_MARGIN || o.x2 >= 1 - EDGE_MARGIN)) : side;
  return { kept: overlays.filter((o) => !ui.includes(o)), ui };
}

/** Nearest-neighbour resize of a text-detector frame to the face detector's input (both stretch the source). */
function toFaceInput(rgb: Uint8Array): Uint8Array {
  const out = new Uint8Array(FACE_INPUT_W * FACE_INPUT_H * 3);
  for (let y = 0; y < FACE_INPUT_H; y++) {
    const sy = Math.min(TEXT_INPUT_H - 1, Math.floor(((y + 0.5) * TEXT_INPUT_H) / FACE_INPUT_H));
    for (let x = 0; x < FACE_INPUT_W; x++) {
      const sx = Math.min(TEXT_INPUT_W - 1, Math.floor(((x + 0.5) * TEXT_INPUT_W) / FACE_INPUT_W));
      const si = (sy * TEXT_INPUT_W + sx) * 3;
      const di = (y * FACE_INPUT_W + x) * 3;
      out[di] = rgb[si]!;
      out[di + 1] = rgb[si + 1]!;
      out[di + 2] = rgb[si + 2]!;
    }
  }
  return out;
}

/**
 * A render never blurs someone's face. A text region that keeps landing on a face is either scene
 * texture (cabinet edges, a shelf above a speaker's head in a static shot) or a caption band in a tight
 * close-up, where the subtitles sit over the chin and chest. So first trim the region's edge back to
 * where the faces end (the band keeps the lines below the chin); only a region that still touches
 * faces, or is left too thin to hold a line of text, is dropped. `share` = fraction of face-bearing
 * frames it may touch.
 */
export function dropFaceOverlaps<O extends Box>(
  overlays: O[],
  frames: Array<{ t?: number; faces: Box[] }>,
  opts: { share?: number; active?: (o: O, t: number) => boolean } = {},
): { kept: O[]; dropped: O[]; trimmed: Array<{ from: O; to: O }> } {
  const limit = opts.share ?? 0.1;
  const withFaces = frames.filter((f) => f.faces.length);
  if (!withFaces.length) return { kept: overlays, dropped: [], trimmed: [] };
  const touches = (o: Box, f: Box) => {
    const ix = Math.max(0, Math.min(o.x2, f.x2) - Math.max(o.x1, f.x1));
    const iy = Math.max(0, Math.min(o.y2, f.y2) - Math.max(o.y1, f.y1));
    return ix * iy > 0.2 * (f.x2 - f.x1) * (f.y2 - f.y1);
  };
  const kept: O[] = [];
  const dropped: O[] = [];
  const trimmed: Array<{ from: O; to: O }> = [];
  for (const o of overlays) {
    const live = withFaces.filter((f) => f.t === undefined || !opts.active || opts.active(o, f.t));
    const hitsOf = (r: Box) => live.filter((f) => f.faces.some((fb) => touches(r, fb)));
    const hits = hitsOf(o);
    if (hits.length / withFaces.length <= limit) {
      kept.push(o);
      continue;
    }
    // faces reaching in from above push the top edge down to their chins, faces from below the bottom
    // edge up; a quantile lets the same share of frames through that the check above allows
    const mid = (o.y1 + o.y2) / 2;
    const touching = hits.flatMap((f) => f.faces.filter((fb) => touches(o, fb)));
    const above = touching.filter((fb) => (fb.y1 + fb.y2) / 2 < mid).map((fb) => fb.y2);
    const below = touching.filter((fb) => (fb.y1 + fb.y2) / 2 >= mid).map((fb) => fb.y1);
    const y1 = above.length ? Math.max(o.y1, quant(above, 1 - limit)) : o.y1;
    const y2 = below.length ? Math.min(o.y2, quant(below, limit)) : o.y2;
    const cut = { ...o, y1: Number(y1.toFixed(3)), y2: Number(y2.toFixed(3)) };
    if (cut.y2 - cut.y1 >= Math.max(MIN_TRIMMED_H, 0.35 * (o.y2 - o.y1)) && hitsOf(cut).length / withFaces.length <= limit) {
      kept.push(cut);
      trimmed.push({ from: o, to: cut });
    } else dropped.push(o);
  }
  return { kept, dropped, trimmed };
}
/** A trimmed region thinner than this (fraction of the frame height) can't hold a line of text: dropped instead. */
const MIN_TRIMMED_H = 0.04;

function frameAt(ffmpegPath: string, source: string, t: number, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const p = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        ...ffmpegPipeThreads,
        "-ss",
        t.toFixed(2),
        "-i",
        source,
        "-frames:v",
        "1",
        "-vf",
        `scale=${TEXT_INPUT_W}:${TEXT_INPUT_H}`,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { signal },
    );
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(new Uint8Array(Buffer.concat(chunks))) : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

export interface OverlayScan {
  overlays: SourceOverlay[];
  frames: number;
  scenes: number;
  /** sampled frames skipped as slides */
  slides: number;
  /** regions discarded because they kept landing on faces */
  faceDropped: SourceOverlay[];
  /** regions discarded because their text wanders (printed on clothing or props, not burned in) */
  moving: SourceOverlay[];
  /** regions discarded as game or app interface (scores, player lists, menus) */
  ui: SourceOverlay[];
  textProfile: TextProfile;
}

export async function detectOverlays(
  deps: { detector: TextDetector; ffmpegPath: string; signal?: AbortSignal; faces?: FaceDetector | null },
  source: string,
  durationSec: number,
  sceneCuts: number[],
  opts: { samples?: number; concurrency?: number } = {},
): Promise<OverlayScan> {
  const n = Math.max(12, Math.min(opts.samples ?? Math.round(durationSec / 6), 160));
  const times = Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * durationSec);
  const cuts = [...sceneCuts].sort((a, b) => a - b);
  const sceneOf = (t: number) => cuts.filter((c) => c <= t).length;

  const grids = await mapLimit(times, opts.concurrency ?? 3, async (t) => {
    const rgb = await frameAt(deps.ffmpegPath, source, t, deps.signal).catch(() => null);
    if (!rgb || rgb.length !== TEXT_INPUT_W * TEXT_INPUT_H * 3) return null;
    const all = await deps.detector.detect(rgb);
    // paragraphs are content: only the remaining lines count as evidence of an overlay
    const { evidence: boxes, textHeavy, slide } = splitText(all);
    const cells = textCells(boxes);
    const faces = deps.faces ? await deps.faces.detect(toFaceInput(rgb)).catch(() => []) : [];
    return { scene: sceneOf(t), cells, boxes, faces, slide, textHeavy };
  });
  const sampled = grids.filter((g): g is NonNullable<typeof g> => !!g);
  // slides are full of text in the same places every time; counting them would mark half the screen as an overlay
  const valid = sampled.filter((g) => !g.slide);
  const slides = sampled.length - valid.length;
  const heavy = sampled.filter((g) => g.textHeavy).length;
  const textProfile: TextProfile = {
    frames: sampled.length,
    textHeavy: heavy,
    presentation: sampled.length > 0 && heavy / sampled.length >= PRESENTATION_SHARE,
  };
  if (!valid.length) return { overlays: [], frames: 0, scenes: 0, slides, faceDropped: [], moving: [], ui: [], textProfile };

  const sceneIds = new Set(valid.map((g) => g.scene));
  const hits = new Float32Array(GX * GY);
  const scenesPerCell = Array.from({ length: GX * GY }, () => new Set<number>());
  for (const g of valid)
    for (const c of g.cells) {
      hits[c]!++;
      scenesPerCell[c]!.add(g.scene);
    }
  // overlay cells: text in enough frames AND (when the video has cuts) in several different shots
  const multiShot = sceneIds.size >= 3;
  const needScenes = multiShot ? Math.max(2, Math.ceil(sceneIds.size * 0.2)) : 1;
  const minFreq = multiShot ? 0.08 : 0.25;
  const keep = new Uint8Array(GX * GY);
  for (let c = 0; c < GX * GY; c++) {
    if (hits[c]! / valid.length < minFreq || scenesPerCell[c]!.size < needScenes) continue;
    // without shot changes we can't tell overlays from text in the scene (a shirt print, a sign),
    // so only trust the places burned-in text lives: the lower 40% and the top 15% of the frame
    if (!multiShot) {
      const y = Math.floor(c / GX) / GY;
      if (y < 0.6 && y > 0.15) continue;
    }
    keep[c] = 1;
  }

  // connected regions of kept cells (8-neighbour) → rectangles
  const seen = new Uint8Array(GX * GY);
  const overlays: SourceOverlay[] = [];
  for (let c = 0; c < GX * GY; c++) {
    if (!keep[c] || seen[c]) continue;
    const stack = [c];
    seen[c] = 1;
    let x1 = GX,
      y1 = GY,
      x2 = 0,
      y2 = 0,
      maxFreq = 0,
      count = 0;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % GX;
      const y = (p - x) / GX;
      x1 = Math.min(x1, x);
      x2 = Math.max(x2, x);
      y1 = Math.min(y1, y);
      y2 = Math.max(y2, y);
      maxFreq = Math.max(maxFreq, hits[p]! / valid.length);
      count++;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= GX || ny >= GY) continue;
          const q = ny * GX + nx;
          if (keep[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
    }
    if (count < 2) continue;
    overlays.push({
      x1: Number((x1 / GX).toFixed(3)),
      y1: Number((y1 / GY).toFixed(3)),
      x2: Number(((x2 + 1) / GX).toFixed(3)),
      y2: Number(((y2 + 1) / GY).toFixed(3)),
      // a channel logo is on screen nearly all the time; subtitles come and go with speech
      // wide bands are subtitles even when someone talks nearly all the time; small, always-on boxes are logos
      kind: (x2 + 1 - x1) / GX >= 0.25 || maxFreq < 0.7 ? "caption" : "watermark",
      coverage: Number(maxFreq.toFixed(2)),
    });
  }
  // the frequency grid only finds the band's core (centred subtitles are short most of the time);
  // grow each region to the long lines and second lines actually seen in it
  const allBoxes = valid.flatMap((g) => g.boxes);
  const grown = mergeRegions(growOverlays(overlays, allBoxes, { quantile: 0.995 }));
  const steady = grown.filter((o) => !drifts(o, allBoxes));
  const { kept: burned, ui } = splitInterface(steady);
  const { kept, dropped } = dropFaceOverlaps(burned, valid);
  return {
    overlays: kept,
    frames: valid.length,
    scenes: sceneIds.size,
    slides,
    faceDropped: dropped,
    moving: grown.filter((o) => !steady.includes(o)),
    ui,
    textProfile,
  };
}

const quant = (xs: number[], q: number) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
};

/**
 * Grow overlay regions to cover the text boxes that belong to them: boxes overlapping a region or
 * stacked right against it (a second subtitle line), horizontally near it. Extents use a high
 * quantile so a stray detection can't blow the region up. Iterates so a second line pulls in a third.
 */
export function growOverlays(
  overlays: SourceOverlay[],
  boxes: Array<{ x1: number; y1: number; x2: number; y2: number }>,
  opts: { quantile?: number; pad?: number } = {},
): SourceOverlay[] {
  const q = opts.quantile ?? 0.995;
  const pad = opts.pad ?? 0.006;
  const inCore = (b: { x1: number; y1: number; x2: number; y2: number }, c: SourceOverlay) => {
    const cx = (b.x1 + b.x2) / 2;
    const cy = (b.y1 + b.y2) / 2;
    return cx >= c.x1 && cx <= c.x2 && cy >= c.y1 && cy <= c.y2;
  };
  return overlays.map((o0, idx) => {
    // boxes that sit in another region's core belong to it (a logo next to the subtitle band)
    const own = boxes.filter((b) => !overlays.some((other, j) => j !== idx && inCore(b, other)));
    let o = { ...o0 };
    for (let iter = 0; iter < 3; iter++) {
      const members = own.filter((b) => {
        const h = b.y2 - b.y1;
        const vGap = Math.max(0, o.y1 - b.y2, b.y1 - o.y2);
        // horizontal test against the ORIGINAL core: centred subtitle lines always overlap it, while
        // chaining through the growing region would drift into neighbouring text
        const overlapsCore = b.x2 > o0.x1 && b.x1 < o0.x2;
        return vGap <= 0.6 * h && overlapsCore;
      });
      if (members.length < (opts.quantile === 1 ? 1 : 3)) break;
      const next = {
        ...o,
        x1: Math.max(
          0,
          Math.min(
            o.x1,
            quant(
              members.map((b) => b.x1),
              1 - q,
            ) - pad,
          ),
        ),
        x2: Math.min(
          1,
          Math.max(
            o.x2,
            quant(
              members.map((b) => b.x2),
              q,
            ) + pad,
          ),
        ),
        y1: Math.max(
          0,
          Math.min(
            o.y1,
            quant(
              members.map((b) => b.y1),
              1 - q,
            ) - pad,
          ),
        ),
        y2: Math.min(
          1,
          Math.max(
            o.y2,
            quant(
              members.map((b) => b.y2),
              q,
            ) + pad,
          ),
        ),
      };
      const changed = Math.abs(next.x1 - o.x1) + Math.abs(next.x2 - o.x2) + Math.abs(next.y1 - o.y1) + Math.abs(next.y2 - o.y2) > 0.002;
      o = next;
      if (!changed) break;
    }
    return { ...o, x1: Number(o.x1.toFixed(3)), x2: Number(o.x2.toFixed(3)), y1: Number(o.y1.toFixed(3)), y2: Number(o.y2.toFixed(3)) };
  });
}

export interface ClipTextFrame {
  /** seconds from the clip start */
  t: number;
  /** overlay evidence: text lines that aren't part of a paragraph */
  boxes: Box[];
  slide: boolean;
  /** every text box in the frame, paragraphs included (side-panel detection reads it) */
  all: Box[];
  /** a slide, document or paragraph of text fills this frame (content to show whole, not to crop or blur) */
  textHeavy: boolean;
}

/** Text boxes per frame in a clip's own time range (one ffmpeg pass at `fps`). */
export async function sampleClipText(
  deps: { detector: TextDetector; ffmpegPath: string; signal?: AbortSignal },
  source: string,
  startSec: number,
  durationSec: number,
  fps = 2,
): Promise<ClipTextFrame[]> {
  const frameBytes = TEXT_INPUT_W * TEXT_INPUT_H * 3;
  const ff = spawn(
    deps.ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      ...ffmpegPipeThreads,
      "-ss",
      startSec.toFixed(3),
      "-t",
      durationSec.toFixed(3),
      "-i",
      source,
      "-vf",
      `fps=${fps},scale=${TEXT_INPUT_W}:${TEXT_INPUT_H}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { signal: deps.signal, stdio: ["ignore", "pipe", "ignore"] },
  );
  const frames: ClipTextFrame[] = [];
  let buf = Buffer.alloc(0);
  for await (const chunk of ff.stdout) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    while (buf.length >= frameBytes) {
      const frame = new Uint8Array(buf.subarray(0, frameBytes));
      buf = buf.subarray(frameBytes);
      const all = await deps.detector.detect(frame);
      const { evidence, slide, textHeavy } = splitText(all);
      frames.push({ t: frames.length / fps, boxes: evidence, all: all.map(({ x1, y1, x2, y2 }) => ({ x1, y1, x2, y2 })), slide, textHeavy });
    }
  }
  return frames;
}

/**
 * When each overlay is actually on screen in a clip: frames (slides excluded) with a text box
 * overlapping the region, padded and merged into windows. Regions never seen in the clip get no
 * windows (the caller drops them); regions on screen nearly the whole time stay always-on.
 */
export function overlayWindows(
  overlays: SourceOverlay[],
  frames: ClipTextFrame[],
  durationSec: number,
  opts: { fps?: number; pad?: number; mergeGap?: number; alwaysOn?: number } = {},
): SourceOverlay[] {
  const fps = opts.fps ?? 2;
  const pad = opts.pad ?? 0.6;
  const mergeGap = opts.mergeGap ?? 1.2;
  const alwaysOn = opts.alwaysOn ?? 0.85;
  if (!frames.length) return overlays; // scan failed or empty clip: keep the project regions as they are
  return overlays.map((o) => {
    const hits = frames.filter((f) => !f.slide && f.boxes.some((b) => b.x2 > o.x1 && b.x1 < o.x2 && b.y2 > o.y1 && b.y1 < o.y2)).map((f) => f.t);
    const share = hits.length / frames.length;
    if (share >= alwaysOn) return { ...o, share };
    const windows: Array<[number, number]> = [];
    for (const t of hits) {
      const a = Math.max(0, t - pad);
      const b = Math.min(durationSec, t + 1 / fps + pad);
      const last = windows.at(-1);
      if (last && a <= last[1] + mergeGap) last[1] = Math.max(last[1], b);
      else windows.push([a, b]);
    }
    return { ...o, share, windows: windows.map(([a, b]) => [Number(a.toFixed(2)), Number(b.toFixed(2))] as [number, number]) };
  });
}

/**
 * Tighten each timed region into pieces: stretches of the clip where the text seen in it keeps about
 * the same extent, each blurred only over the boxes seen during that stretch. A band grown to the
 * longest two-line caption of the clip then no longer blurs that whole area under a one-word line,
 * and a stray box (a second line once, a sign) widens only its own stretch. Every piece gets one
 * window (the renderer fades each in and out). Watermarks, and every region when there are no
 * frames, are returned as they are.
 */
export function tightenOverlays(
  overlays: SourceOverlay[],
  frames: ClipTextFrame[],
  durationSec: number,
  opts: { fps?: number; pad?: number; boxPad?: number; grow?: number; maxPieces?: number; cores?: Box[]; staticSec?: number } = {},
): SourceOverlay[] {
  const fps = opts.fps ?? 2;
  const pad = opts.pad ?? 0.6;
  const boxPad = opts.boxPad ?? 0.008;
  // a new piece starts when the next frame's text would grow the piece by more than this share of its area
  const grow = opts.grow ?? 0.35;
  const maxPieces = opts.maxPieces ?? 12;
  if (!frames.length) return overlays;
  const area = (b: Box) => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
  const union = (a: Box, b: Box): Box => ({ x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) });
  const iou = (a: Box, b: Box) => {
    const i = area({ x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2) });
    return i / (area(a) + area(b) - i || 1);
  };
  // scene text next to a caption band (a label on a bottle on the desk) is pulled in when the band
  // grows, but it holds still while subtitles change: a box seen at the same place for `staticSec` or
  // more, outside every region the project scan found (`cores`), is not blurred. A handle inside the
  // band holds still too, but the project scan found it, so it stays.
  const minStatic = Math.ceil((opts.staticSec ?? 3) * fps);
  const inCores = (b: Box) => {
    const cx = (b.x1 + b.x2) / 2;
    const cy = (b.y1 + b.y2) / 2;
    return (opts.cores ?? []).some((c) => cx >= c.x1 && cx <= c.x2 && cy >= c.y1 && cy <= c.y2);
  };
  const scene = (b: Box) =>
    opts.cores !== undefined && !inCores(b) && frames.filter((f) => !f.slide && f.boxes.some((x) => iou(x, b) >= 0.7)).length >= minStatic;
  const out: SourceOverlay[] = [];
  for (const o of overlays) {
    // a logo or handle has one extent; a missed detection would only make its blur flicker
    if (o.kind === "watermark") {
      out.push(o);
      continue;
    }
    const on = (t: number) => !o.windows || o.windows.some(([a, b]) => t >= a - 1e-6 && t <= b + 1e-6);
    // the text of this region in each frame (same overlap test as overlayWindows), kept inside the region
    const seen: Array<{ t: number; box: Box }> = [];
    for (const f of frames) {
      if (f.slide || !on(f.t)) continue;
      const mine = f.boxes.filter((b) => b.x2 > o.x1 && b.x1 < o.x2 && b.y2 > o.y1 && b.y1 < o.y2 && !scene(b));
      if (!mine.length) continue;
      const u = mine.reduce(union);
      seen.push({ t: f.t, box: { x1: Math.max(o.x1, u.x1), y1: Math.max(o.y1, u.y1), x2: Math.min(o.x2, u.x2), y2: Math.min(o.y2, u.y2) } });
    }
    if (!seen.length) {
      out.push(o);
      continue;
    }
    // runs of frames: a new one after a gap in the text or a jump in its extent, up (a longer line) or
    // down (one word after a two-line caption), so each run's box stays close to every frame in it
    const runs: Array<{ t0: number; t1: number; box: Box }> = [];
    for (const s of seen) {
      const last = runs.at(-1);
      const u = last ? area(union(last.box, s.box)) : 0;
      if (last && s.t - last.t1 <= 1 / fps + 1.2 && u <= area(last.box) * (1 + grow) + 1e-4 && u <= area(s.box) * (1 + grow) ** 2 + 1e-4) {
        last.t1 = s.t;
        last.box = union(last.box, s.box);
      } else runs.push({ t0: s.t, t1: s.t, box: s.box });
    }
    // windows padded like overlayWindows (longer than the sample interval): where the text changes
    // between two samples, the next piece is already on, so the switch is never uncovered
    let pieces = runs.map((r) => ({ a: Math.max(0, r.t0 - pad), b: Math.min(durationSec, r.t1 + 1 / fps + pad), box: r.box }));
    // a bounded number of blur patches per region: merge the neighbours whose union adds the least blurred area × time
    const cost = (p: { a: number; b: number; box: Box }) => area(p.box) * (p.b - p.a);
    while (pieces.length > maxPieces) {
      let best = 0;
      let bestCost = Infinity;
      for (let i = 0; i < pieces.length - 1; i++) {
        const p = pieces[i]!;
        const q = pieces[i + 1]!;
        const c = cost({ a: p.a, b: Math.max(p.b, q.b), box: union(p.box, q.box) }) - cost(p) - cost(q);
        if (c < bestCost) {
          bestCost = c;
          best = i;
        }
      }
      const p = pieces[best]!;
      const q = pieces[best + 1]!;
      pieces = [...pieces.slice(0, best), { a: p.a, b: Math.max(p.b, q.b), box: union(p.box, q.box) }, ...pieces.slice(best + 2)];
    }
    for (const p of pieces) {
      out.push({
        ...o,
        x1: Number(Math.max(0, p.box.x1 - boxPad).toFixed(3)),
        y1: Number(Math.max(0, p.box.y1 - boxPad).toFixed(3)),
        x2: Number(Math.min(1, p.box.x2 + boxPad).toFixed(3)),
        y2: Number(Math.min(1, p.box.y2 + boxPad).toFixed(3)),
        windows: [[Number(p.a.toFixed(2)), Number(p.b.toFixed(2))]],
      });
    }
  }
  return out;
}
