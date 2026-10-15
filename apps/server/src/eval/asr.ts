/** Cached speech-to-text for evals: same model call as the pipeline, keyed by audio bytes + model + options. */
import { transcribe } from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import type { Word } from "@reelsaw/shared";
import { createAi, providerOf, type AiService } from "../ai/registry.js";
import { toWords } from "../pipeline/transcript.js";
import type { EvalContext } from "./framework.js";

let ai: AiService | undefined;
export function evalAi(ctx: EvalContext): AiService {
  return (ai ??= createAi(ctx.config(), ctx.log.child({ module: "ai" })));
}

export async function transcribeCached(ctx: EvalContext, modelId: string, audio: Uint8Array, extraOptions: Record<string, unknown> = {}): Promise<{ text: string; words: Word[] }> {
  const a = evalAi(ctx);
  const provider = providerOf(modelId);
  const providerOptions = { [provider]: { ...(a.transcriptionOptions(modelId)[provider] ?? {}), ...extraOptions } } as Record<string, JSONObject>;
  return ctx.cached(["asr", modelId, providerOptions, audio], async () => {
    const res = await transcribe({ model: await a.transcriptionModel(modelId), audio, providerOptions, maxRetries: 2 });
    return { text: res.text, words: toWords(res.segments.map((s) => ({ text: s.text, startSecond: s.startSecond, endSecond: s.endSecond }))) };
  });
}
