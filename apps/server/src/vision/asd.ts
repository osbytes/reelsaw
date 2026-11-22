/**
 * Learned audio-visual active speaker detection: LR-ASD (Liao et al., IJCV 2025, the successor of
 * Light-ASD; MIT, code and weights), run as the three ONNX graphs DeepTalk-ASD exported (audio frontend,
 * visual frontend, audio-visual backend; ~3.3 MB together). Given one face's 25 fps crops and the MFCCs of
 * the same seconds it returns a speaking logit per frame (> 0 = this face is talking).
 *
 * Preprocessing follows the reference demo (Columbia_test.py) so the weights see what they were trained on:
 * the face box widened to 2.8× half its size (more below the centre than above), resized to 224², the centre
 * 112² kept in grayscale; MFCCs per 10 ms (audio/mfcc.ts), 4 per video frame; scores averaged over windows of
 * 1-6 s, then over ±2 frames.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createOnnxSession, type OnnxOptions, type OnnxProvider } from "../onnx.js";
import { MFCC_COEFFS } from "../audio/mfcc.js";

export const ASD_FPS = 25;
export const ASD_CROP = 112;
export const ASD_FILES = ["audio_frontend.onnx", "visual_frontend.onnx", "av_backend.onnx"] as const;

export interface AsdModel {
  /**
   * Speaking logits for `frames` consecutive 25 fps frames of one face. `crops` holds frames × 112 × 112
   * grayscale pixels (0-255); `mfcc` holds at least frames × 4 rows of 13 coefficients for the same span.
   */
  score(crops: Float32Array, mfcc: Float32Array, frames: number): Promise<Float32Array>;
  release(): Promise<void>;
  /** onnxruntime execution provider the model runs on (ONNX_EXECUTION_PROVIDER, or cpu after a fallback) */
  readonly provider: OnnxProvider;
}

// the reference's window lengths in seconds, repeats included (shorter windows weigh more)
const DURATIONS = [1, 1, 1, 2, 2, 2, 3, 3, 4, 5, 6];
const CHUNK = 6 * ASD_FPS;

export async function loadAsdModel(dir: string, opts: OnnxOptions = {}): Promise<AsdModel> {
  for (const f of ASD_FILES) await fs.access(path.join(dir, f));
  const ort = await import("onnxruntime-node");
  const base = { graphOptimizationLevel: "all" as const, intraOpNumThreads: 1, logSeverityLevel: 3 as const };
  const open = (f: string) => createOnnxSession(ort, path.join(dir, f), base, opts);
  const audio = await open("audio_frontend.onnx");
  const visual = await open("visual_frontend.onnx");
  const backend = await open("av_backend.onnx");
  const sessions = [audio.session, visual.session, backend.session];

  const EMBED = 128;
  // the frontends see 6 s chunks once; only the cheap backend runs per scoring window (the reference
  // re-runs all three per window, ~11× the work for the same windows)
  async function embeddings(crops: Float32Array, mfcc: Float32Array, frames: number) {
    const px = ASD_CROP * ASD_CROP;
    const ae = new Float32Array(frames * EMBED);
    const ve = new Float32Array(frames * EMBED);
    const rows = mfcc.length / MFCC_COEFFS;
    for (let v0 = 0; v0 < frames; v0 += CHUNK) {
      const n = Math.min(CHUNK, frames - v0);
      const a = new Float32Array(n * 4 * MFCC_COEFFS);
      const avail = Math.max(0, Math.min(n * 4, rows - v0 * 4));
      // short audio wraps around, as the reference pads it (np.pad mode "wrap")
      for (let r = 0; r < n * 4; r++) {
        const src = avail ? v0 * 4 + (r % avail) : 0;
        a.set(mfcc.subarray(src * MFCC_COEFFS, (src + 1) * MFCC_COEFFS), r * MFCC_COEFFS);
      }
      const ao = await audio.session.run({ audio_feature: new ort.Tensor("float32", a, [1, n * 4, MFCC_COEFFS]) });
      const vo = await visual.session.run({
        visual_feature: new ort.Tensor("float32", crops.slice(v0 * px, (v0 + n) * px), [1, n, ASD_CROP, ASD_CROP]),
      });
      ae.set(ao["audio_embed"]!.data as Float32Array, v0 * EMBED);
      ve.set(vo["visual_embed"]!.data as Float32Array, v0 * EMBED);
    }
    return { ae, ve };
  }

  return {
    async score(crops, mfcc, frames) {
      const { ae, ve } = await embeddings(crops, mfcc, frames);
      const sum = new Float32Array(frames);
      for (const d of DURATIONS) {
        const len = d * ASD_FPS;
        for (let v0 = 0; v0 < frames; v0 += len) {
          const n = Math.min(len, frames - v0);
          const out = await backend.session.run({
            audio_embed: new ort.Tensor("float32", ae.slice(v0 * EMBED, (v0 + n) * EMBED), [1, n, EMBED]),
            visual_embed: new ort.Tensor("float32", ve.slice(v0 * EMBED, (v0 + n) * EMBED), [1, n, EMBED]),
          });
          const s = out["score"]!.data as Float32Array;
          for (let i = 0; i < n; i++) sum[v0 + i]! += s[i]! / DURATIONS.length;
        }
      }
      // ±2 frame mean, as the reference smooths before thresholding
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        let k = 0;
        for (let j = Math.max(0, i - 2); j <= Math.min(frames - 1, i + 2); j++, k++) s += sum[j]!;
        out[i] = s / k;
      }
      return out;
    },
    async release() {
      for (const s of sessions) await s.release();
    },
    provider: audio.provider,
  };
}

/**
 * The model's 112×112 grayscale input for one face, from a packed RGB24 frame of `w`×`h` pixels with the
 * face centred at (cx, cy) px and half-size `bs` px (half the larger side of the face box). Equivalent to
 * the reference's pad-with-110 → crop [cy - bs, cy + 1.8 bs] × [cx ± 1.4 bs] → resize 224 → centre 112,
 * sampled bilinearly straight into the 112² output.
 */
export function faceCrop(rgb: Uint8Array, w: number, h: number, cx: number, cy: number, bs: number, out: Float32Array, offset = 0) {
  const side = 1.4 * bs; // the kept centre half of the 2.8 bs region
  const x0 = cx - 0.7 * bs;
  const y0 = cy - 0.3 * bs;
  const px = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return 110;
    const i = (y * w + x) * 3;
    return 0.299 * rgb[i]! + 0.587 * rgb[i + 1]! + 0.114 * rgb[i + 2]!;
  };
  for (let oy = 0; oy < ASD_CROP; oy++) {
    const sy = y0 + ((oy + 0.5) * side) / ASD_CROP - 0.5;
    const iy = Math.floor(sy);
    const fy = sy - iy;
    for (let ox = 0; ox < ASD_CROP; ox++) {
      const sx = x0 + ((ox + 0.5) * side) / ASD_CROP - 0.5;
      const ix = Math.floor(sx);
      const fx = sx - ix;
      const top = px(ix, iy) * (1 - fx) + px(ix + 1, iy) * fx;
      const bot = px(ix, iy + 1) * (1 - fx) + px(ix + 1, iy + 1) * fx;
      out[offset + oy * ASD_CROP + ox] = Math.round(top * (1 - fy) + bot * fy);
    }
  }
}
