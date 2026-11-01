/**
 * Whisper (and other decoder-style ASR) sometimes emits a runaway repeat: one token, or a short
 * n-gram, copied hundreds of times, often with collapsed word timestamps. OpenAI's own transcribe.py
 * treats a gzip/zlib compression ratio above 2.4 as a failed 30 s window and retries at a higher
 * temperature (Radford et al. 2022, "Robust Speech Recognition via Large-Scale Weak Supervision";
 * default `compression_ratio_threshold` in openai/whisper). The hosted whisper-1 API does not expose
 * that retry, and `condition_on_previous_text=false` is local-only, so a loop in one internal window
 * poisons the rest of our 10-minute chunk.
 *
 * Two cheap defences, both token-identity rules (no word list):
 *  1. After decoding, collapse consecutive n-gram runs that are longer than spoken emphasis.
 *  2. If a chunk looks repetitive and we passed a vocabulary `prompt`, retry once without it
 *     (Whisper is known to transcribe its initial prompt, especially at a chunk cut).
 *
 * Keep-side (do not overfit to one video):
 *  - "no no no" / "no no no no" is emphasis (`EMPHATIC` in disfluency.ts; human captions for the
 *    2026-10-24 triathlon report wrote four "no"s). Unigram keep-cap is 4.
 *  - "I think I think" is a 2-copy bigram: disfluency's job, not this one.
 *  - A spoken 3-copy phrase with distinct timestamps is kept (cheers, "come on come on come on").
 *
 * Cite: openai/whisper transcribe.py; faster-whisper#465; openai community "Whisper hallucination";
 * issue report 218 (project dee69555, 2270× "no" from 40:28–49:59 and a 10-minute prompt-list loop).
 */
import { z } from "zod";
import type { StepKeyInput } from "./steps.js";

import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { TranscriptFlag, Word } from "@reelsaw/shared";

/** openai/whisper `compression_ratio_threshold` default. */
export const COMPRESSION_RATIO_THRESHOLD = 2.4;
/** Spoken emphasis tops out around four copies ("no no no no"). Longer is a decoder loop. */
export const UNIGRAM_KEEP = 4;
/** Phrase loops of 2+ distinct tokens: 3 collapsed copies, or 4 with healthy timestamps. */
export const NGRAM_MIN_REPEATS = 3;
const MAX_NGRAM = 12;
/** Below this, zlib's header dominates and the ratio is not a loop signal. */
const MIN_RATIO_BYTES = 80;
const MIN_UNIQUE_TOKENS = 40;
const UNIQUE_FRAC_LOOP = 0.12;

export const tokenKey = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, "");

/** Uncompressed / zlib-compressed length. Higher = more repetitive. Same definition as openai/whisper. */
export function compressionRatio(text: string): number {
  const buf = Buffer.from(text, "utf8");
  if (buf.length < MIN_RATIO_BYTES) return 1;
  const compressed = deflateSync(buf);
  return compressed.length ? buf.length / compressed.length : 1;
}

/** True when a chunk's text looks like a decoder loop, so a no-prompt retry is worth it. */
export function looksRepetitive(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_RATIO_BYTES) return false;
  if (compressionRatio(t) > COMPRESSION_RATIO_THRESHOLD) return true;
  const toks = t.split(/\s+/).filter(Boolean);
  if (toks.length < MIN_UNIQUE_TOKENS) return false;
  const unique = new Set(toks.map(tokenKey).filter(Boolean)).size;
  return unique / toks.length < UNIQUE_FRAC_LOOP;
}

export function shouldRetryWithoutPrompt(text: string, hasPrompt: boolean): boolean {
  return hasPrompt && looksRepetitive(text);
}

export function preferLessRepetitive<T extends { text: string }>(a: T, b: T): T {
  if (!b.text.trim()) return a;
  if (!a.text.trim()) return b;
  return compressionRatio(a.text) <= compressionRatio(b.text) ? a : b;
}

/** Drop `prompt` from a vendor's transcription options without mutating the shared object. */
export function withoutPrompt<T extends Record<string, Record<string, unknown>>>(opts: T, vendor: string): T {
  const cur = opts[vendor];
  if (!cur || !("prompt" in cur)) return opts;
  const next = { ...cur };
  delete next.prompt;
  return { ...opts, [vendor]: next };
}

export interface LoopRun {
  /** first word of the run, seconds */
  at: number;
  /** last dropped copy's time, or the next surviving word's start when timestamps piled up */
  end: number;
  ngram: number;
  repeats: number;
  kept: number;
  token: string;
  /** index of the first copy in the as-heard (uncollapsed) word list */
  wordIndex: number;
  /** full run length in words (repeats × n-gram), including copies we drop from captions */
  span: number;
}

export interface CollapseResult {
  words: Word[];
  dropped: number;
  runs: LoopRun[];
}

/**
 * Each copy of an n-gram looks like speech when its words occupy distinct, increasing time and the
 * copy lasts at least ~60 ms per token (faster than conversational rate, slower than a timestamp pile-up).
 */
function spokenLooking(words: Word[], start: number, n: number, repeats: number): boolean {
  let prevEnd = -Infinity;
  for (let k = 0; k < repeats; k++) {
    const a = words[start + k * n]!;
    const b = words[start + (k + 1) * n - 1]!;
    if (a.start + 0.005 < prevEnd) return false;
    if (b.end - a.start < 0.06 * n) return false;
    prevEnd = b.end;
  }
  return true;
}

function runLength(keys: string[], i: number, n: number): number {
  const pat = keys.slice(i, i + n);
  let r = 1;
  while (i + (r + 1) * n <= keys.length) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (keys[i + r * n + j] !== pat[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) break;
    r++;
  }
  return r;
}

/**
 * Collapse consecutive decoder-loop repeats. Identity on ordinary speech, including short
 * emphatic repeats and a single immediate phrase copy.
 */
export function collapseDecoderLoops(words: Word[]): Word[] {
  return collapseDecoderLoopsWithStats(words).words;
}

export function collapseDecoderLoopsWithStats(words: Word[]): CollapseResult {
  if (words.length < UNIGRAM_KEEP + 1) return { words, dropped: 0, runs: [] };
  const keys = words.map((w) => tokenKey(w.text));
  const out: Word[] = [];
  const runs: LoopRun[] = [];
  let i = 0;
  while (i < words.length) {
    let best: { n: number; repeats: number; keep: number } | null = null;
    let bestDrop = 0;
    const maxN = Math.min(MAX_NGRAM, words.length - i);
    for (let n = 1; n <= maxN; n++) {
      const pat = keys.slice(i, i + n);
      if (pat.some((k) => !k)) continue;
      if (n > 1 && new Set(pat).size < 2) continue; // "no no" is a unigram, not a 2-gram
      const repeats = runLength(keys, i, n);
      const spoken = spokenLooking(words, i, n, repeats);
      let keepCopies = repeats;
      if (n === 1) {
        if (repeats > UNIGRAM_KEEP) keepCopies = UNIGRAM_KEEP;
      } else if (repeats >= NGRAM_MIN_REPEATS && (repeats >= NGRAM_MIN_REPEATS + 1 || !spoken)) {
        keepCopies = spoken ? 2 : 1;
      }
      if (keepCopies >= repeats) continue;
      const drop = (repeats - keepCopies) * n;
      if (drop > bestDrop || (drop === bestDrop && n > (best?.n ?? 0))) {
        best = { n, repeats, keep: keepCopies };
        bestDrop = drop;
      }
    }
    if (!best) {
      out.push(words[i]!);
      i++;
      continue;
    }
    const take = best.keep * best.n;
    const span = best.repeats * best.n;
    for (let k = 0; k < take; k++) out.push(words[i + k]!);
    const lastOrig = words[i + span - 1]!;
    const next = words[i + span];
    runs.push({
      at: words[i]!.start,
      end: next ? next.start : lastOrig.end,
      ngram: best.n,
      repeats: best.repeats,
      kept: best.keep,
      token: keys.slice(i, i + best.n).join(" "),
      wordIndex: i,
      span,
    });
    i += span;
  }
  return { words: out, dropped: words.length - out.length, runs };
}

/**
 * Auto-applied transcript flags over the as-heard run. `raw` is the uncollapsed word list (same
 * indexing as `run.wordIndex` / `run.span`). Rejecting the flag puts the repeated copies back.
 */
export function flagsFromCollapse(raw: Word[], result: CollapseResult): TranscriptFlag[] {
  return result.runs.map((run) => {
    const keepN = run.kept * run.ngram;
    const kept = raw.slice(run.wordIndex, run.wordIndex + keepN);
    const last = raw[Math.min(raw.length - 1, run.wordIndex + run.span - 1)];
    const suggested = kept.map((w) => w.text).join(" ");
    const heard = `${run.token} × ${run.repeats}`.slice(0, 200);
    return {
      id: randomUUID(),
      kind: "loop" as const,
      wordIndex: run.wordIndex,
      span: run.span,
      start: run.at,
      end: Math.max(run.end, last?.end ?? run.at),
      heard,
      suggested,
      confidence: 1,
      status: "auto" as const,
    };
  });
}

/** Bumped when the way a chunk is transcribed changes (prompt retry rule, options), so saved chunk steps stop applying. */
export const CHUNK_STEP_VERSION = "chunk-1";

/** What a saved chunk step holds: counts and timing only. The words stay in `transcript_chunks`, which the stage reads. */
export const chunkStepSchema = z.object({
  chunkIndex: z.number().int().min(0),
  segments: z.number().int().min(0),
  words: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  fromRow: z.boolean(),
});
export type ChunkStepOutput = z.infer<typeof chunkStepSchema>;

export function chunkStepName(index: number): string {
  return `chunk:${index}`;
}

/** The key a chunk's step is saved under: the ASR cache hash (model, options and the audio bytes) plus the chunk's place and the rule version. */
export function chunkStepKey(cacheKey: string, model: string, index: number, offsetSec: number): StepKeyInput {
  return { input: cacheKey, model, promptVersion: CHUNK_STEP_VERSION, params: { index, offsetMs: Math.round(offsetSec * 1000) } };
}

export function chunkStepOutput(index: number, text: string, segments: number, durationMs: number, fromRow = false): ChunkStepOutput {
  return { chunkIndex: index, segments, words: text.split(/\s+/).filter(Boolean).length, durationMs: Math.max(0, Math.round(durationMs)), fromRow };
}
