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
  for (const b of boxes) for (let gy = Math.floor(b.y1 * GY); gy < Math.ceil(b.y2 * GY); gy++) for (let gx = Math.floor(b.x1 * GX); gx < Math.ceil(b.x2 * GX); gx++) cells.add(gy * GX + gx);
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
  const h = q(own.map((b) => b.y2 - b.y1), 0.5);
  return q(cys, 0.9) - q(cys, 0.1) > 1.8 * h && q(cxs, 0.9) - q(cxs, 0.1) > 0.05;
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
 * Burned-in captions and logos are placed clear of faces. A "text" region that keeps landing on a
 * face (cabinet edges or a shelf above a speaker's head in a static shot) is scene texture: drop it,
 * so a render never blurs someone's face. `share` = fraction of face-bearing frames it may touch.
 */
export function dropFaceOverlaps<O extends Box>(overlays: O[], frames: Array<{ t?: number; faces: Box[] }>, opts: { share?: number; active?: (o: O, t: number) => boolean } = {}): { kept: O[]; dropped: O[] } {
  const limit = opts.share ?? 0.1;
  const withFaces = frames.filter((f) => f.faces.length);
  if (!withFaces.length) return { kept: overlays, dropped: [] };
  const touches = (o: Box, f: Box) => {
    const ix = Math.max(0, Math.min(o.x2, f.x2) - Math.max(o.x1, f.x1));
    const iy = Math.max(0, Math.min(o.y2, f.y2) - Math.max(o.y1, f.y1));
    return ix * iy > 0.2 * (f.x2 - f.x1) * (f.y2 - f.y1);
  };
  const kept: O[] = [];
  const dropped: O[] = [];
  for (const o of overlays) {
    const hit = withFaces.filter((f) => (f.t === undefined || !opts.active || opts.active(o, f.t)) && f.faces.some((fb) => touches(o, fb))).length;
    (hit / withFaces.length > limit ? dropped : kept).push(o);
  }
  return { kept, dropped };
}

function frameAt(ffmpegPath: string, source: string, t: number, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const p = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", t.toFixed(2), "-i", source, "-frames:v", "1", "-vf", `scale=${TEXT_INPUT_W}:${TEXT_INPUT_H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { signal });
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
  const textProfile: TextProfile = { frames: sampled.length, textHeavy: heavy, presentation: sampled.length > 0 && heavy / sampled.length >= PRESENTATION_SHARE };
  if (!valid.length) return { overlays: [], frames: 0, scenes: 0, slides, faceDropped: [], moving: [], textProfile };

  const sceneIds = new Set(valid.map((g) => g.scene));
  const hits = new Float32Array(GX * GY);
  const scenesPerCell = Array.from({ length: GX * GY }, () => new Set<number>());
  for (const g of valid) for (const c of g.cells) {
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
    let x1 = GX, y1 = GY, x2 = 0, y2 = 0, maxFreq = 0, count = 0;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % GX;
      const y = (p - x) / GX;
      x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y);
      maxFreq = Math.max(maxFreq, hits[p]! / valid.length);
      count++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= GX || ny >= GY) continue;
        const q = ny * GX + nx;
        if (keep[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
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
  const { kept, dropped } = dropFaceOverlaps(steady, valid);
  return { overlays: kept, frames: valid.length, scenes: sceneIds.size, slides, faceDropped: dropped, moving: grown.filter((o) => !steady.includes(o)), textProfile };
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
export function growOverlays(overlays: SourceOverlay[], boxes: Array<{ x1: number; y1: number; x2: number; y2: number }>, opts: { quantile?: number; pad?: number } = {}): SourceOverlay[] {
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
        x1: Math.max(0, Math.min(o.x1, quant(members.map((b) => b.x1), 1 - q) - pad)),
        x2: Math.min(1, Math.max(o.x2, quant(members.map((b) => b.x2), q) + pad)),
        y1: Math.max(0, Math.min(o.y1, quant(members.map((b) => b.y1), 1 - q) - pad)),
        y2: Math.min(1, Math.max(o.y2, quant(members.map((b) => b.y2), q) + pad)),
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
  /** a slide, document or paragraph of text fills this frame (content to show whole, not to crop or blur) */
  textHeavy: boolean;
}

/** Text boxes per frame in a clip's own time range (one ffmpeg pass at `fps`). */
export async function sampleClipText(deps: { detector: TextDetector; ffmpegPath: string; signal?: AbortSignal }, source: string, startSec: number, durationSec: number, fps = 2): Promise<ClipTextFrame[]> {
  const frameBytes = TEXT_INPUT_W * TEXT_INPUT_H * 3;
  const ff = spawn(deps.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", startSec.toFixed(3), "-t", durationSec.toFixed(3), "-i", source, "-vf", `fps=${fps},scale=${TEXT_INPUT_W}:${TEXT_INPUT_H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { signal: deps.signal, stdio: ["ignore", "pipe", "ignore"] });
  const frames: ClipTextFrame[] = [];
  let buf = Buffer.alloc(0);
  for await (const chunk of ff.stdout) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    while (buf.length >= frameBytes) {
      const frame = new Uint8Array(buf.subarray(0, frameBytes));
      buf = buf.subarray(frameBytes);
      const { evidence, slide, textHeavy } = splitText(await deps.detector.detect(frame));
      frames.push({ t: frames.length / fps, boxes: evidence, slide, textHeavy });
    }
  }
  return frames;
}

/**
 * When each overlay is actually on screen in a clip: frames (slides excluded) with a text box
 * overlapping the region, padded and merged into windows. Regions never seen in the clip get no
 * windows (the caller drops them); regions on screen nearly the whole time stay always-on.
 */
export function overlayWindows(overlays: SourceOverlay[], frames: ClipTextFrame[], durationSec: number, opts: { fps?: number; pad?: number; mergeGap?: number; alwaysOn?: number } = {}): SourceOverlay[] {
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
