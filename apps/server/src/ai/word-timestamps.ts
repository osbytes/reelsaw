/**
 * Does a transcription model return word-level timestamps? Found out by transcribing a short bundled
 * clip (assets/probe/word-timestamps.mp3), never by matching model or vendor names.
 *
 * Why a test call instead of a list
 * ---------------------------------
 * Cuts, captions and boundary snapping need a start and an end for every word. The pipeline accepts
 * what `looksWordLevel` (pipeline/transcript.ts) calls word-level; anything coarser is spread over its
 * words by character count, which puts cuts and caption timing visibly off, and a model that returns
 * text only gives no words at all. Nothing we can ask before the first call says which models qualify:
 *  - OpenAI-compatible servers and routers (OpenRouter, Speaches, vLLM, LocalAI…) list models in
 *    `GET /models` with no capabilities. OpenRouter marks speech models with
 *    `architecture.output_modalities: ["transcription"]` but reports `supported_parameters: []`, and
 *    one model id is served by several upstreams (DeepInfra, Groq, …) whose `verbose_json` may or may
 *    not carry `words`.
 *  - The AI SDK's `TranscriptionModel` has no capability fields either.
 * A hand-kept allowlist (`/whisper/` plus vendor names) used to decide. It was wrong both ways: it
 * rejected whisper served through a compatible provider (osbytes/reelsaw#260) and accepted anything
 * with "whisper" in its name.
 *
 * How it works
 * ------------
 * `verify` (ai/registry.ts: boot check, Settings → Models save, and the Test button) transcribes the
 * clip with the same provider options the pipeline sends and judges the answer with `looksWordLevel`,
 * so the test and the pipeline cannot disagree. The verdict is stored per model id and base URL in
 * `instance_settings` (key `transcription_probes`) so every process shares it and a restart does not
 * pay again. It is re-checked after PROBE_TTL_MS, and every time an admin presses Test. A failed call
 * (bad key, unreachable server, rate limit) is not a verdict: it is thrown and nothing is stored.
 * The pipeline keeps its own "no words" failure as the backstop for a model that changes behaviour
 * between checks.
 *
 * What would let us delete this
 * -----------------------------
 * A machine-readable "returns word timestamps" from whoever serves the model, available before the
 * first call. Any one of these is enough:
 *  - the AI SDK adds a capability to `TranscriptionModel` (e.g. supported timestamp granularities)
 *    that every provider package fills in, including @ai-sdk/openai pointed at a custom base URL;
 *  - OpenAI-compatible `/models` listings (and OpenRouter's per-endpoint metadata) report supported
 *    `timestamp_granularities` / response formats per model, and routers keep that true per upstream;
 *  - Reelsaw drops compatible servers for transcription and supports a fixed set of vendors, where a
 *    table keyed by vendor is exact.
 * Until then the cost is one ~5 s transcription per model per PROBE_TTL_MS.
 */
import fs from "node:fs/promises";
import { sql } from "drizzle-orm";
import { transcribe, type TranscriptionModel } from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import { looksWordLevel } from "../pipeline/transcript.js";
import { bundledAssetPath } from "../lib/assets.js";

/** 5 s of synthetic speech (flite, voice "slt"), 13 words: "Reelsaw checks that this speech model returns a time for every single word." */
export const PROBE_CLIP = bundledAssetPath("probe/word-timestamps.mp3");
/** How long a verdict stands before the clip is sent again (providers change what they return). */
export const PROBE_TTL_MS = 30 * 24 * 3600_000;
const PROBE_TIMEOUT_MS = 5 * 60_000; // a self-hosted server may load the model into memory first

export interface WordTimestampVerdict {
  wordLevel: boolean;
  /** segments the model returned for the clip */
  segments: number;
  /** what it heard (short; shown in errors so an admin can tell a bad clip from a bad model) */
  text: string;
  checkedAt: string;
}

/** Where verdicts live. Keys come from `verdictKey`. */
export interface VerdictStore {
  get(key: string): Promise<WordTimestampVerdict | undefined>;
  set(key: string, verdict: WordTimestampVerdict): Promise<void>;
}

/** The same model id on another server (OPENAI_BASE_URL, the compatible provider) is another model. Pass the base URL redacted (`redactUrl`): keys are stored. */
export function verdictKey(modelId: string, redactedBaseUrl?: string): string {
  return redactedBaseUrl ? `${modelId} @ ${redactedBaseUrl}` : modelId;
}

export function isStale(v: WordTimestampVerdict, now = Date.now()): boolean {
  const at = Date.parse(v.checkedAt);
  return !Number.isFinite(at) || now - at > PROBE_TTL_MS;
}

/** Evals, tests, the CLI before the database is attached: verdicts last for the process. */
export function memoryVerdictStore(): VerdictStore {
  const m = new Map<string, WordTimestampVerdict>();
  return { get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v) };
}

const KEY = "transcription_probes";

/** Shared by every process through `instance_settings`; memory only until `attach`. */
export function dbVerdictStore(): VerdictStore & { attach(db: Db): void } {
  const mem = memoryVerdictStore();
  let db: Db | undefined;
  return {
    attach(d) {
      db = d;
    },
    async get(k) {
      if (!db) return mem.get(k);
      const row = await db.query.instanceSettings.findFirst({ where: (t, { eq }) => eq(t.key, KEY) });
      return parseVerdict((row?.value as Record<string, unknown> | undefined)?.[k]);
    },
    async set(k, v) {
      await mem.set(k, v);
      if (!db) return;
      // merge one key into the map in a single statement: two processes probing two models must not drop each other's verdict
      const patch = { [k]: v };
      await db
        .insert(schema.instanceSettings)
        .values({ key: KEY, value: patch, updatedBy: "system" })
        .onConflictDoUpdate({
          target: schema.instanceSettings.key,
          set: { value: sql`${schema.instanceSettings.value} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() },
        });
    },
  };
}

function parseVerdict(v: unknown): WordTimestampVerdict | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.wordLevel !== "boolean" || typeof o.checkedAt !== "string") return undefined;
  return { wordLevel: o.wordLevel, segments: Number(o.segments) || 0, text: String(o.text ?? ""), checkedAt: o.checkedAt };
}

/**
 * Transcribe the clip and judge it. Throws when the call fails or the model hears nothing, since
 * neither says anything about timestamps.
 */
export async function probeWordTimestamps(
  model: TranscriptionModel,
  providerOptions: Record<string, Record<string, unknown>>,
  opts: { clip?: string; signal?: AbortSignal } = {},
): Promise<WordTimestampVerdict> {
  const audio = await fs.readFile(opts.clip ?? PROBE_CLIP);
  const res = await transcribe({
    model,
    audio,
    providerOptions: providerOptions as Record<string, JSONObject>,
    maxRetries: 2,
    abortSignal: opts.signal ?? AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const text = res.text.trim();
  if (!text) throw new Error("it returned no text for a 5-second test clip of clear speech, so its word timestamps could not be checked");
  const segments = res.segments.map((s) => ({ text: s.text, startSecond: s.startSecond, endSecond: s.endSecond }));
  return { wordLevel: looksWordLevel(segments), segments: segments.length, text: text.slice(0, 120), checkedAt: new Date().toISOString() };
}
