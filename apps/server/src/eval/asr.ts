/** Cached speech-to-text for evals: same model call as the pipeline, keyed by audio bytes + model + options. */
import { transcribe } from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import type { Word } from "@reelsaw/shared";
import { underlyingProvider, type AiService } from "../ai/registry.js";
import { toWords } from "../pipeline/transcript.js";
import type { EvalContext } from "./framework.js";
import { reportedCost } from "./meter.js";

/** The profile's models (metered). Kept as a function so suites read the same way as before. */
export function evalAi(ctx: EvalContext): AiService {
  return ctx.ai;
}

export async function transcribeCached(ctx: EvalContext, modelId: string, audio: Uint8Array, extraOptions: Record<string, unknown> = {}): Promise<{ text: string; words: Word[] }> {
  const a = ctx.ai;
  // options go under the vendor key: "gateway:openai/whisper-1" still speaks OpenAI options
  const provider = underlyingProvider(modelId);
  const providerOptions = { [provider]: { ...(a.transcriptionOptions(modelId)[provider] ?? {}), ...extraOptions } } as Record<string, JSONObject>;
  return ctx.cached(["asr", modelId, providerOptions, audio], async () => {
    const t0 = Date.now();
    try {
      const res = await transcribe({ model: await a.transcriptionModel(modelId), audio, providerOptions, maxRetries: 2 });
      const last = res.segments.at(-1);
      ctx.meter.record({ kind: "stt", model: modelId, ms: Date.now() - t0, ok: true, audioSec: res.durationInSeconds ?? last?.endSecond, costUsd: reportedCost(res.providerMetadata) });
      return { text: res.text, words: toWords(res.segments.map((s) => ({ text: s.text, startSecond: s.startSecond, endSecond: s.endSecond }))) };
    } catch (err) {
      ctx.meter.record({ kind: "stt", model: modelId, ms: Date.now() - t0, ok: false, error: (err as Error).message?.slice(0, 200) });
      throw err;
    }
  });
}
