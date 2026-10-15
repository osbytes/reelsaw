/**
 * On-screen text detection with PaddleOCR's PP-OCRv4 detector (DB, 4.7 MB ONNX, CPU). Used to find
 * captions and watermarks burned into the source video so renders can keep them out of the crop or
 * mask them, instead of showing them twice next to our own captions.
 * Model: PaddleOCR (Apache-2.0), ONNX export from RapidOCR.
 *
 * Input: 640×352 RGB frame. Output: text boxes in normalized [0..1] coordinates.
 */
import fs from "node:fs/promises";

export const TEXT_INPUT_W = 640;
export const TEXT_INPUT_H = 352;

export interface TextBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
}

export interface TextDetector {
  /** `rgb` is packed RGB24 of exactly TEXT_INPUT_W×TEXT_INPUT_H. */
  detect(rgb: Uint8Array): Promise<TextBox[]>;
  release(): Promise<void>;
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/**
 * DB post-processing: threshold the probability map, take 4-connected components, keep confident
 * ones and grow each box a little (DB maps shrink text regions by design).
 */
export function boxesFromProbMap(prob: Float32Array, w: number, h: number, opts = { thresh: 0.3, boxThresh: 0.6, minArea: 12 }): TextBox[] {
  const label = new Int32Array(w * h).fill(-1);
  const out: TextBox[] = [];
  const stack: number[] = [];
  let next = 0;
  for (let i = 0; i < w * h; i++) {
    if (label[i] !== -1 || prob[i]! < opts.thresh) continue;
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    let sum = 0;
    let n = 0;
    label[i] = next;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      sum += prob[p]!;
      n++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= w * h) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
        if (label[q] !== -1 || prob[q]! < opts.thresh) continue;
        label[q] = next;
        stack.push(q);
      }
    }
    next++;
    if (n < opts.minArea || sum / n < opts.boxThresh) continue;
    // unclip: DB shrinks regions by ~0.4·height on each side
    const grow = Math.max(1, Math.round((maxY - minY + 1) * 0.4));
    out.push({
      x1: Math.max(0, minX - grow) / w,
      y1: Math.max(0, minY - grow) / h,
      x2: Math.min(w, maxX + 1 + grow) / w,
      y2: Math.min(h, maxY + 1 + grow) / h,
      score: Number((sum / n).toFixed(3)),
    });
  }
  return out;
}

export async function loadTextDetector(modelPath: string): Promise<TextDetector> {
  await fs.access(modelPath);
  const ort = await import("onnxruntime-node");
  ort.env.logLevel = "error";
  const session = await ort.InferenceSession.create(modelPath, { graphOptimizationLevel: "all", intraOpNumThreads: 2, logSeverityLevel: 3 });
  const inputName = session.inputNames[0]!;
  const outputName = session.outputNames[0]!;
  const n = TEXT_INPUT_W * TEXT_INPUT_H;
  const input = new Float32Array(3 * n);
  return {
    async detect(rgb) {
      if (rgb.length !== n * 3) throw new Error(`expected ${n * 3} bytes of RGB24, got ${rgb.length}`);
      // Paddle reads images as BGR and normalizes channel-wise with ImageNet mean/std
      for (let i = 0; i < n; i++) {
        const r = rgb[i * 3]! / 255;
        const g = rgb[i * 3 + 1]! / 255;
        const b = rgb[i * 3 + 2]! / 255;
        input[i] = (b - MEAN[0]!) / STD[0]!;
        input[n + i] = (g - MEAN[1]!) / STD[1]!;
        input[2 * n + i] = (r - MEAN[2]!) / STD[2]!;
      }
      const res = await session.run({ [inputName]: new ort.Tensor("float32", input, [1, 3, TEXT_INPUT_H, TEXT_INPUT_W]) });
      const prob = res[outputName]!.data as Float32Array;
      return boxesFromProbMap(prob, TEXT_INPUT_W, TEXT_INPUT_H);
    },
    release: () => session.release(),
  };
}
