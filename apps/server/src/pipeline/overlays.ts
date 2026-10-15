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
import type { SourceOverlay } from "@reelsaw/shared";
import type { TextDetector } from "../vision/text.js";
import { TEXT_INPUT_W, TEXT_INPUT_H } from "../vision/text.js";
import { mapLimit } from "./select.js";

const GX = 48;
const GY = 27;

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
}

export async function detectOverlays(
  deps: { detector: TextDetector; ffmpegPath: string; signal?: AbortSignal },
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
    const boxes = await deps.detector.detect(rgb);
    const cells = new Set<number>();
    for (const b of boxes) {
      for (let gy = Math.floor(b.y1 * GY); gy < Math.ceil(b.y2 * GY); gy++) for (let gx = Math.floor(b.x1 * GX); gx < Math.ceil(b.x2 * GX); gx++) cells.add(gy * GX + gx);
    }
    return { scene: sceneOf(t), cells, boxes };
  });
  const valid = grids.filter((g): g is NonNullable<typeof g> => !!g);
  if (!valid.length) return { overlays: [], frames: 0, scenes: 0 };

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
  const grown = growOverlays(overlays, valid.flatMap((g) => g.boxes), { quantile: 0.995 });
  return { overlays: grown, frames: valid.length, scenes: sceneIds.size };
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

/** Text boxes in a clip's own time range (one ffmpeg pass at `fps`), for per-clip region growth. */
export async function sampleClipText(deps: { detector: TextDetector; ffmpegPath: string; signal?: AbortSignal }, source: string, startSec: number, durationSec: number, fps = 2) {
  const frameBytes = TEXT_INPUT_W * TEXT_INPUT_H * 3;
  const ff = spawn(deps.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", startSec.toFixed(3), "-t", durationSec.toFixed(3), "-i", source, "-vf", `fps=${fps},scale=${TEXT_INPUT_W}:${TEXT_INPUT_H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { signal: deps.signal, stdio: ["ignore", "pipe", "ignore"] });
  const boxes: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  let buf = Buffer.alloc(0);
  for await (const chunk of ff.stdout) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    while (buf.length >= frameBytes) {
      const frame = new Uint8Array(buf.subarray(0, frameBytes));
      buf = buf.subarray(frameBytes);
      boxes.push(...(await deps.detector.detect(frame)));
    }
  }
  return boxes;
}
