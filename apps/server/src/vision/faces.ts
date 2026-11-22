/**
 * Face detection with YuNet (OpenCV Zoo `face_detection_yunet_2026may`), a 230 KB ONNX model with a
 * dynamic input shape that runs in a few milliseconds per frame on CPU and returns five landmarks per
 * face (eyes, nose tip, mouth corners). Input is an RGB frame of any size: `sampleFaces` passes an
 * aspect-preserving `faceRaster` (640×360 for 16:9), other callers the frame they already decode; output is
 * a list of boxes in normalized [0..1] coordinates of that frame. Used to decide clip layout and to
 * drive the face-following crop; `tracker.ts` gives each box an identity across frames.
 * Model: https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet (MIT)
 *
 * Replaced UltraFace RFB-320 (2026-11): UltraFace boxed round pans seen from above with scores up to
 * 0.99 and missed small and profile faces. At the detector raster YuNet's boxes have UltraFace's extent
 * (median height ×0.998, width ×1.014 over 1,328 faces both found across the framing fixtures), so
 * every size threshold and crop built on face height keeps its meaning. The raster grew with the model: at 320×240, squashed
 * to 4:3 whatever the source, YuNet missed the 57 px webcam face of a 1080p webinar in every frame and a
 * 9:16 source's face in most; at 640×360 it finds the webcam in 98% of the frames and still puts a face
 * on 2% of a face-free POV clip's frames (UltraFace: 37%).
 */
import fs from "node:fs/promises";
import { createOnnxSession, type OnnxOptions, type OnnxProvider } from "../onnx.js";

/** The probe raster: every frame probe in `pipeline/` (divider, webcam tile, inset, text overlay faces) reads 320×240, squashed to 4:3 whatever the source. */
export const FACE_INPUT_W = 320;
export const FACE_INPUT_H = 240;

/** Pixels of the detector raster (640×360 at 16:9): small faces need them, and YuNet costs about what UltraFace did at 320×240. */
const DETECT_AREA = 640 * 360;

/** The detector raster for a source of `srcAspect` (width / height): the source's shape at `DETECT_AREA`, even sides. */
export function faceRaster(srcAspect = 16 / 9): { w: number; h: number } {
  const a = Number.isFinite(srcAspect) && srcAspect > 0 ? Math.min(4, Math.max(0.25, srcAspect)) : 16 / 9;
  const w = Math.round(Math.sqrt(DETECT_AREA * a) / 2) * 2;
  return { w, h: Math.round(w / a / 2) * 2 };
}

/** YuNet's strides; the network wants both sides a multiple of the largest, so the frame is padded right and below */
const STRIDES = [8, 16, 32] as const;
const pad32 = (v: number) => Math.ceil(v / 32) * 32;

export interface FaceBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
  /** five points as x,y pairs, normalized: right eye, left eye, nose tip, right mouth corner, left mouth corner (YuNet's order) */
  landmarks?: number[];
  /** identity across the sampled frames of one clip (`trackFaces`); absent on a single-frame detection */
  track?: number;
}

export interface FaceDetector {
  /**
   * `rgb` is a packed RGB24 buffer of `size`. No default: YuNet on a small raster squashed to 4:3 finds
   * faces in wall textures and misses small ones, so each caller passes the largest frame it decodes,
   * at the source's shape where it can (`faceRaster`).
   */
  detect(rgb: Uint8Array, size: { w: number; h: number }): Promise<FaceBox[]>;
  /** Free the ONNX session. Must run before process exit or onnxruntime aborts on teardown. */
  release(): Promise<void>;
  /** onnxruntime execution provider the model runs on (ONNX_EXECUTION_PROVIDER, or cpu after a fallback) */
  readonly provider: OnnxProvider;
}

type Ort = typeof import("onnxruntime-node");

export function iou(a: Pick<FaceBox, "x1" | "y1" | "x2" | "y2">, b: Pick<FaceBox, "x1" | "y1" | "x2" | "y2">) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const ua = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return ua > 0 ? inter / ua : 0;
}

export function nms(boxes: FaceBox[], iouThreshold = 0.4): FaceBox[] {
  const sorted = boxes.slice().sort((a, b) => b.score - a.score);
  const keep: FaceBox[] = [];
  for (const b of sorted) {
    if (keep.every((k) => iou(k, b) < iouThreshold)) keep.push(b);
  }
  return keep;
}

/** score floor; YuNet's score is sqrt(cls × obj), so it runs lower than UltraFace's softmax for the same face */
export const DEFAULT_THRESHOLD = 0.6;

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * Decode YuNet's per-stride heads (OpenCV's `FaceDetectorYN` post-processing): score = sqrt(cls × obj),
 * centre offsets in cells, log-scale size, landmarks as cell offsets. Coordinates come back normalized
 * to the `w`×`h` frame inside the padded `padW`×`padH` input (boxes reaching into the padding are clamped).
 */
export function decodeYunet(out: Record<string, { data: unknown }>, threshold: number, w: number, h: number, padW = pad32(w), padH = pad32(h)): FaceBox[] {
  const found: FaceBox[] = [];
  for (const s of STRIDES) {
    const cls = out[`cls_${s}`]!.data as Float32Array;
    const obj = out[`obj_${s}`]!.data as Float32Array;
    const bbox = out[`bbox_${s}`]!.data as Float32Array;
    const kps = out[`kps_${s}`]!.data as Float32Array;
    const cols = padW / s;
    const rows = padH / s;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(Math.min(1, Math.max(0, cls[i]!)) * Math.min(1, Math.max(0, obj[i]!)));
        if (score < threshold) continue;
        const cx = (c + bbox[i * 4]!) * s;
        const cy = (r + bbox[i * 4 + 1]!) * s;
        const bw = Math.exp(bbox[i * 4 + 2]!) * s;
        const bh = Math.exp(bbox[i * 4 + 3]!) * s;
        const landmarks: number[] = [];
        for (let k = 0; k < 5; k++) landmarks.push(r4(((kps[i * 10 + 2 * k]! + c) * s) / w), r4(((kps[i * 10 + 2 * k + 1]! + r) * s) / h));
        const x1 = cx - bw / 2;
        const x2 = cx + bw / 2;
        const y1 = cy - bh / 2;
        const y2 = cy + bh / 2;
        found.push({
          x1: r4(Math.max(0, x1 / w)),
          y1: r4(Math.max(0, y1 / h)),
          x2: r4(Math.min(1, x2 / w)),
          y2: r4(Math.min(1, y2 / h)),
          score: r4(score),
          landmarks,
        });
      }
  }
  return found;
}

export async function loadFaceDetector(modelPath: string, opts: OnnxOptions & { threshold?: number } = {}): Promise<FaceDetector> {
  await fs.access(modelPath);
  const ort: Ort = await import("onnxruntime-node");
  ort.env.logLevel = "error";
  const { session, provider } = await createOnnxSession(ort, modelPath, { graphOptimizationLevel: "all", intraOpNumThreads: 1, logSeverityLevel: 3 }, opts);
  const inputName = session.inputNames[0]!;
  if (!session.outputNames.includes("cls_8"))
    throw new Error(`${modelPath} is not a YuNet face model (outputs ${session.outputNames.join(", ")}); run "pnpm models:download"`);
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;

  return {
    async detect(rgb, size) {
      const { w, h } = size;
      if (rgb.length !== w * h * 3) throw new Error(`expected ${w * h * 3} bytes of RGB24 (${w}×${h}), got ${rgb.length}`);
      // HWC uint8 RGB → CHW float BGR, unnormalized 0..255, padded with black to multiples of 32. The tensor is
      // this call's own: the session is shared by every clip rendering at once and `run` reads the buffer after
      // the await, so a shared one mixed frames between clips.
      const pw = pad32(w);
      const ph = pad32(h);
      const np = pw * ph;
      const input = new Float32Array(3 * np);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 3;
          const j = y * pw + x;
          input[j] = rgb[i + 2]!;
          input[np + j] = rgb[i + 1]!;
          input[2 * np + j] = rgb[i]!;
        }
      const out = await session.run({ [inputName]: new ort.Tensor("float32", input, [1, 3, ph, pw]) });
      return nms(decodeYunet(out, threshold, w, h), 0.3).filter((b) => b.x1 < 1 && b.y1 < 1 && b.x2 > b.x1 && b.y2 > b.y1);
    },
    release: () => session.release(),
    provider,
  };
}
