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
    return { scene: sceneOf(t), cells };
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
  return { overlays, frames: valid.length, scenes: sceneIds.size };
}
