/**
 * Face detection with UltraFace (version-RFB-320), a 1.2 MB ONNX model that runs in a few
 * milliseconds per frame on CPU. Input is a 320×240 RGB frame; output is a list of boxes in
 * normalized [0..1] coordinates. Used to decide clip layout and to drive the face-following crop.
 * Model: https://github.com/onnx/models/tree/main/validated/vision/body_analysis/ultraface (MIT)
 */
import fs from "node:fs/promises";

export const FACE_INPUT_W = 320;
export const FACE_INPUT_H = 240;

export interface FaceBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
}

export interface FaceDetector {
  /** `rgb` is a packed RGB24 buffer of exactly 320×240 pixels. */
  detect(rgb: Uint8Array, threshold?: number): Promise<FaceBox[]>;
  /** Free the ONNX session. Must run before process exit or onnxruntime aborts on teardown. */
  release(): Promise<void>;
}

type Ort = typeof import("onnxruntime-node");

function iou(a: FaceBox, b: FaceBox) {
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

export async function loadFaceDetector(modelPath: string): Promise<FaceDetector> {
  await fs.access(modelPath);
  const ort: Ort = await import("onnxruntime-node");
  ort.env.logLevel = "error"; // the published UltraFace graph triggers harmless initializer warnings
  const session = await ort.InferenceSession.create(modelPath, { graphOptimizationLevel: "all", intraOpNumThreads: 1, logSeverityLevel: 3 });
  const inputName = session.inputNames[0]!;
  const n = FACE_INPUT_W * FACE_INPUT_H;

  return {
    async detect(rgb, threshold = 0.7) {
      if (rgb.length !== n * 3) throw new Error(`expected ${n * 3} bytes of RGB24, got ${rgb.length}`);
      // HWC uint8 → CHW float, (x - 127) / 128. The tensor is this call's own: the session is shared by every
      // clip rendering at once and `run` reads the buffer after the await, so a shared one mixed frames between clips.
      const input = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) {
        input[i] = (rgb[i * 3]! - 127) / 128;
        input[n + i] = (rgb[i * 3 + 1]! - 127) / 128;
        input[2 * n + i] = (rgb[i * 3 + 2]! - 127) / 128;
      }
      const out = await session.run({ [inputName]: new ort.Tensor("float32", input, [1, 3, FACE_INPUT_H, FACE_INPUT_W]) });
      const scores = out.scores!.data as Float32Array; // [1, N, 2]
      const boxes = out.boxes!.data as Float32Array; // [1, N, 4]
      const count = scores.length / 2;
      const found: FaceBox[] = [];
      for (let i = 0; i < count; i++) {
        const s = scores[i * 2 + 1]!;
        if (s < threshold) continue;
        found.push({
          x1: Math.max(0, boxes[i * 4]!),
          y1: Math.max(0, boxes[i * 4 + 1]!),
          x2: Math.min(1, boxes[i * 4 + 2]!),
          y2: Math.min(1, boxes[i * 4 + 3]!),
          score: s,
        });
      }
      return nms(found);
    },
    release: () => session.release(),
  };
}
