/**
 * Speech-to-text with a content-addressed cache. The cut search, the transcribe stage, the CLI and
 * repeated renders transcribe the same audio again and again (each call 10-50 s on a CPU whisper);
 * results are stored under DATA_DIR/cache/asr keyed by sha256(model, options, audio bytes).
 * Old entries are pruned at boot (ASR_CACHE_DAYS). With an S3 store the entries are also kept under
 * `cache/asr/<sha>.json` in the bucket (written after the local copy, read back on a local miss), so a
 * worker on another host does not transcribe audio a sibling already did; the same ASR_CACHE_DAYS prunes them.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { transcribe as aiTranscribe } from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import { providerOf, type AiService } from "./registry.js";
import type { ProviderGate } from "./gate.js";
import { llmContext, type LlmContext } from "./trace.js";
import type { Logger } from "../log.js";
import { ASR_CACHE_PREFIX, keys, type Storage } from "../storage/index.js";
import { mapLimit } from "../lib/batch.js";

/** The cache key of one transcription: sha256 over the model, its options and the audio bytes. */
export function asrCacheKey(modelId: string, providerOptions: Record<string, JSONObject>, audio: Uint8Array): string {
  return createHash("sha256").update(modelId).update("\0").update(JSON.stringify(providerOptions)).update("\0").update(audio).digest("hex");
}

/** Entries one prune pass lists on the store; the next pass takes the rest. */
export const ASR_PRUNE_LIST_LIMIT = 5000;

export interface AsrResult {
  text: string;
  language?: string;
  segments: Array<{ text: string; startSecond: number; endSecond: number }>;
}

/** One transcription that reached a provider (cache hits are not reported). */
export interface SttUsage {
  ctx: LlmContext;
  provider: string;
  model: string;
  audioSec: number;
  ms: number;
  ok: boolean;
}

export interface Asr {
  /** The cache key `transcribe` would use for these inputs. */
  keyFor(audio: Uint8Array, opts?: { modelId?: string; providerOptions?: Record<string, JSONObject> }): string;
  /** Transcribe `audio` with `modelId` (default TRANSCRIPTION_MODEL) and its word-timestamp options. */
  transcribe(audio: Uint8Array, opts?: { modelId?: string; providerOptions?: Record<string, JSONObject>; signal?: AbortSignal; maxRetries?: number; functionId?: string; telemetry?: boolean }): Promise<AsrResult & { cached: boolean }>;
  stats(): { hits: number; misses: number };
  prune(maxAgeDays: number): Promise<number>;
  /** Called after every provider call (usage accounting). Set once the database is up. */
  onUsage: ((u: SttUsage) => void) | null;
}

export function createAsr(ai: AiService, defaultModel: () => string, dir: string, log: Logger, gate?: ProviderGate | null, store?: Storage | null): Asr {
  // only a shared store is worth a round trip; the local driver's "store" is this machine's disk again
  const shared = store && store.driver === "s3" ? store : null;
  let hits = 0;
  let misses = 0;
  const fileFor = (key: string) => path.join(dir, key.slice(0, 2), `${key}.json`);
  const asr: Asr = {
    onUsage: null,
    keyFor(audio, opts = {}) {
      const modelId = opts.modelId ?? defaultModel();
      return asrCacheKey(modelId, opts.providerOptions ?? (ai.transcriptionOptions(modelId) as Record<string, JSONObject>), audio);
    },
    async transcribe(audio, opts = {}) {
      const modelId = opts.modelId ?? defaultModel();
      const providerOptions = opts.providerOptions ?? (ai.transcriptionOptions(modelId) as Record<string, JSONObject>);
      const key = asrCacheKey(modelId, providerOptions, audio);
      const file = fileFor(key);
      const readLocal = async () => JSON.parse(await fs.readFile(file, "utf8")) as AsrResult;
      try {
        const hit = await readLocal();
        hits++;
        return { ...hit, cached: true };
      } catch {
        /* miss */
      }
      if (shared) {
        // read-through: another host may have transcribed this audio; ensureLocal puts the object where the local cache looks
        try {
          await shared.ensureLocal(keys.asrCache(key), file);
          const hit = await readLocal();
          hits++;
          return { ...hit, cached: true };
        } catch (err) {
          await fs.rm(file, { force: true }).catch(() => {});
          log.debug({ err, key }, "asr cache miss on the store");
        }
      }
      misses++;
      const model = await ai.transcriptionModel(modelId);
      const provider = providerOf(modelId);
      const call = async () => {
        const t0 = Date.now();
        try {
          const r = await aiTranscribe({
            model,
            audio,
            providerOptions,
            abortSignal: opts.signal,
            maxRetries: opts.maxRetries ?? 2,
            ...(opts.functionId ? { telemetry: { isEnabled: !!opts.telemetry, functionId: opts.functionId, recordOutputs: false } } : {}),
          });
          const audioSec = r.durationInSeconds ?? r.segments.at(-1)?.endSecond ?? 0;
          asr.onUsage?.({ ctx: llmContext(), provider, model: modelId, audioSec, ms: Date.now() - t0, ok: true });
          return r;
        } catch (err) {
          asr.onUsage?.({ ctx: llmContext(), provider, model: modelId, audioSec: 0, ms: Date.now() - t0, ok: false });
          throw err;
        }
      };
      // a self-hosted whisper is one shared machine: the provider gate caps calls across every job and process
      const res = gate ? await gate.run(provider, call, opts.signal) : await call();
      const out: AsrResult = { text: res.text, language: res.language, segments: res.segments.map((s) => ({ text: s.text, startSecond: s.startSecond, endSecond: s.endSecond })) };
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(`${file}.tmp`, JSON.stringify(out));
        await fs.rename(`${file}.tmp`, file);
        // write-through: best effort, a failure only costs another host a transcription
        if (shared) await shared.putFile(keys.asrCache(key), file, "application/json").catch((err) => log.warn({ err, key }, "asr cache write to the store failed"));
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
      if (shared) {
        const old = (await shared.list(ASR_CACHE_PREFIX, ASR_PRUNE_LIST_LIMIT).catch((err) => {
          log.warn({ err }, "asr cache listing on the store failed");
          return [];
        })).filter((o) => o.modifiedAt.getTime() < cutoff);
        await mapLimit(old, 8, async (o) => {
          await shared.delete(o.key).then(() => void removed++, (err) => log.warn({ err, key: o.key }, "asr cache delete on the store failed"));
        });
      }
      return removed;
    },
  };
  return asr;
}
