/**
 * One place that opens onnxruntime sessions for the on-device models (faces, text, alignment).
 * ONNX_EXECUTION_PROVIDER picks the hardware; a provider that cannot load (no CUDA libraries, no
 * DirectML, a model the provider rejects) falls back to the CPU with a warning, so a GPU setting
 * never stops the pipeline. Which provider a model ended up on is reported in Settings → System.
 *
 * Measured on an M-series Mac (onnxruntime 1.30, CoreML vs CPU per run): UltraFace 7.8 vs 2.4 ms,
 * PP-OCRv4 72 vs 43 ms, wav2vec2 5 s 211 vs 170 ms. The CPU wins for these small models, which is why
 * cpu is the default and `coreml` is only an experiment.
 */
import type { Logger } from "./log.js";
import type { InferenceSession } from "onnxruntime-node";

export type OnnxProvider = "cpu" | "cuda" | "coreml" | "dml";
export const ONNX_PROVIDERS: readonly OnnxProvider[] = ["cpu", "cuda", "coreml", "dml"];

type Ort = typeof import("onnxruntime-node");

export interface OnnxOptions {
  provider?: OnnxProvider;
  log?: Logger;
}

/** Open `modelPath` on the requested provider, or on the CPU when that provider is unavailable. */
export async function createOnnxSession(
  ort: Ort,
  modelPath: string,
  base: InferenceSession.SessionOptions,
  opts: OnnxOptions = {},
): Promise<{ session: InferenceSession; provider: OnnxProvider }> {
  const requested = opts.provider ?? "cpu";
  if (requested !== "cpu") {
    try {
      const session = await ort.InferenceSession.create(modelPath, { ...base, executionProviders: [requested] });
      return { session, provider: requested };
    } catch (err) {
      opts.log?.warn({ err, requested, model: modelPath }, "onnx execution provider unavailable; using the cpu");
    }
  }
  const session = await ort.InferenceSession.create(modelPath, base);
  return { session, provider: "cpu" };
}
