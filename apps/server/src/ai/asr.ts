/**
 * Speech-to-text with a content-addressed cache. The cut search, the transcribe stage, the CLI and
 * repeated renders transcribe the same audio again and again (each call 10-50 s on a CPU whisper);
 * results are stored under DATA_DIR/cache/asr keyed by sha256(model, options, audio bytes).
 * Old entries are pruned at boot (ASR_CACHE_DAYS).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { transcribe as aiTranscribe } from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import type { AiService } from "./registry.js";
import type { Logger } from "../log.js";

export interface AsrResult {
  text: string;
  language?: string;
  segments: Array<{ text: string; startSecond: number; endSecond: number }>;
}

export interface Asr {
  /** Transcribe `audio` with `modelId` (default TRANSCRIPTION_MODEL) and its word-timestamp options. */
  transcribe(audio: Uint8Array, opts?: { modelId?: string; providerOptions?: Record<string, JSONObject>; signal?: AbortSignal; maxRetries?: number; functionId?: string; telemetry?: boolean }): Promise<AsrResult & { cached: boolean }>;
  stats(): { hits: number; misses: number };
  prune(maxAgeDays: number): Promise<number>;
}

export function createAsr(ai: AiService, defaultModel: () => string, dir: string, log: Logger): Asr {
  let hits = 0;
  let misses = 0;
  const fileFor = (key: string) => path.join(dir, key.slice(0, 2), `${key}.json`);
  return {
    async transcribe(audio, opts = {}) {
      const modelId = opts.modelId ?? defaultModel();
      const providerOptions = opts.providerOptions ?? (ai.transcriptionOptions(modelId) as Record<string, JSONObject>);
      const key = createHash("sha256").update(modelId).update("\0").update(JSON.stringify(providerOptions)).update("\0").update(audio).digest("hex");
      const file = fileFor(key);
      try {
        const hit = JSON.parse(await fs.readFile(file, "utf8")) as AsrResult;
        hits++;
        return { ...hit, cached: true };
      } catch {
        /* miss */
      }
      misses++;
      const res = await aiTranscribe({
        model: await ai.transcriptionModel(modelId),
        audio,
        providerOptions,
        abortSignal: opts.signal,
        maxRetries: opts.maxRetries ?? 2,
        ...(opts.functionId ? { telemetry: { isEnabled: !!opts.telemetry, functionId: opts.functionId, recordOutputs: false } } : {}),
      });
      const out: AsrResult = { text: res.text, language: res.language, segments: res.segments.map((s) => ({ text: s.text, startSecond: s.startSecond, endSecond: s.endSecond })) };
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(`${file}.tmp`, JSON.stringify(out));
        await fs.rename(`${file}.tmp`, file);
      } catch (err) {
        log.warn({ err }, "asr cache write failed");
      }
      return { ...out, cached: false };
    },
    stats: () => ({ hits, misses }),
    async prune(maxAgeDays) {
      const cutoff = Date.now() - maxAgeDays * 86_400_000;
      let removed = 0;
      for (const sub of await fs.readdir(dir).catch(() => [] as string[])) {
        for (const f of await fs.readdir(path.join(dir, sub)).catch(() => [] as string[])) {
          const p = path.join(dir, sub, f);
          const st = await fs.stat(p).catch(() => null);
          if (st && st.mtimeMs < cutoff) {
            await fs.rm(p, { force: true });
            removed++;
          }
        }
      }
      return removed;
    },
  };
}
