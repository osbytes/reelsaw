/**
 * Clip selection as map → pool → rank (see docs/RESEARCH.md, B4/B5):
 *
 *  1. chunk   – split the transcript into ~3-minute windows (also capped by characters) at the
 *               longest pause near the boundary, with ~35% overlap so a max-length clip at the
 *               cut appears whole in at least one window. Long single-prompt maps under-select
 *               the middle (Lost in the Middle, TACL 2024) and stop after the first few JSON
 *               items; smaller windows are the structural fix, not a "spread clips" prompt.
 *  2. map     – ask for every standalone moment per chunk (no target count), in parallel. Drop
 *               proposals that do not overlap the chunk after timestamp repair.
 *  3. glean   – one extra map pass when a long window's first picks leave a long uncovered tail
 *               (exhaustive-extraction / GraphRAG gleaning). Empty is allowed; dull stretches
 *               stay empty.
 *  4. pool    – snap/dedupe in the caller
 *  5. score   – rubric (hook / flow / value / shareability [/ relevance]) 0-10 per criterion, k samples,
 *               median per criterion; also returns emphasis words for the captions
 *  6. rank    – K sliding pairwise passes over the top clips (K places the top K), each comparison
 *               asked twice with the positions swapped; disagreements count as ties (judge position bias)
 */
import { generateText, Output, NoObjectGeneratedError, type LanguageModel } from "ai";
import { z } from "zod";
import { clipCandidateSchema, rubricTotal, type ClipCandidate, type ClipScores, type TranscriptSegment } from "@reelsaw/shared";
import { fmtTs } from "./transcript.js";
import { withLlmContext } from "../ai/trace.js";
import type { Logger } from "../log.js";

// ---------- small helpers ----------

/** Run `fn` over items with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** "mm:ss.s", "h:mm:ss", "12.5", 12.5 → seconds */
export function toSeconds(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const parts = t.split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** Pull the first JSON object/array out of model text (code fences, chatter around it). */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const start = cleaned.indexOf("{");
  const startArr = cleaned.indexOf("[");
  const from = start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
  if (from === -1) return undefined;
  try {
    return JSON.parse(cleaned.slice(from, Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]")) + 1));
  } catch {
    return undefined;
  }
}

function firstArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") return (Object.values(parsed as Record<string, unknown>).find((v) => Array.isArray(v)) as unknown[] | undefined) ?? [];
  return [];
}

/** Fix the usual small-model slips even when the schema validated: 0-1 scores, timestamps pasted into hooks. */
export function normalizeCandidate(c: ClipCandidate): ClipCandidate {
  const score = c.score <= 1 ? c.score * 100 : c.score <= 10 && Number.isInteger(c.score) ? c.score * 10 : c.score;
  const hook = c.hook.replace(/^\s*\[[^\]]*\]\s*/, "").replace(/^["'“”]+|["'“”]+$/g, "").trim();
  const title = c.title.replace(/^\s*\[[^\]]*\]\s*/, "").trim() || hook.slice(0, 60) || "Clip";
  return { ...c, title, hook: (hook || title).slice(0, 80), score: Math.max(0, Math.min(100, score)) };
}

/**
 * Small/local models often ignore the schema (wrong key names, "mm:ss" strings, missing fields).
 * Salvage what we can from the raw text instead of failing the project.
 */
export function parseClipsLeniently(text: string): ClipCandidate[] {
  const parsed = extractJson(text);
  if (parsed === undefined) return [];
  const out: ClipCandidate[] = [];
  for (const raw of firstArray(parsed)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const startSec = toSeconds(r.startSec ?? r.start ?? r.start_time ?? r.startTime ?? r.from);
    const endSec = toSeconds(r.endSec ?? r.end ?? r.end_time ?? r.endTime ?? r.to);
    if (startSec === undefined || endSec === undefined || endSec <= startSec) continue;
    const text = typeof r.text === "string" ? r.text : typeof r.quote === "string" ? r.quote : "";
    const title = String(r.title ?? r.headline ?? text.slice(0, 60) ?? "Clip").trim() || "Clip";
    const hook = String(r.hook ?? r.caption ?? r.overlay ?? title).trim().slice(0, 80);
    const scoreRaw = Number(r.score ?? r.virality ?? r.rating ?? 50);
    const score = Number.isFinite(scoreRaw) ? (scoreRaw <= 1 ? scoreRaw * 100 : scoreRaw <= 10 ? scoreRaw * 10 : scoreRaw) : 50;
    const hashtags = Array.isArray(r.hashtags) ? r.hashtags.map(String) : typeof r.hashtags === "string" ? r.hashtags.split(/[\s,]+/).filter(Boolean) : [];
    out.push({ title, hook, startSec, endSec, score: Math.max(0, Math.min(100, score)), reasoning: String(r.reasoning ?? r.reason ?? r.why ?? text).slice(0, 1000), caption: String(r.caption ?? r.description ?? "").slice(0, 300), hashtags: hashtags.slice(0, 8) });
  }
  return out;
}

export interface LlmOpts {
  log?: Logger;
  model: LanguageModel;
  signal?: AbortSignal;
  telemetry: boolean;
}

/**
 * Structured output with two fallbacks for weak/local models: salvage the raw text of a schema
 * failure, then one plain-text attempt for servers that reject response_format.
 */
async function llmJson<T>(o: LlmOpts, prompt: string, schema: z.ZodType<T>, name: string, temperature: number, salvage: (text: string) => T | null): Promise<T | null> {
  return withLlmContext({ call: `analyze.${name}` }, () => llmJsonInner(o, prompt, schema, name, temperature, salvage));
}

async function llmJsonInner<T>(o: LlmOpts, prompt: string, schema: z.ZodType<T>, name: string, temperature: number, salvage: (text: string) => T | null): Promise<T | null> {
  const common = { model: o.model, prompt, abortSignal: o.signal, maxRetries: 2, temperature } as const;
  try {
    const { output } = await generateText({ ...common, output: Output.object({ schema, name }), telemetry: { isEnabled: o.telemetry, functionId: `analyze.${name}`, recordInputs: false, recordOutputs: false } });
    return output as T;
  } catch (err) {
    if (!NoObjectGeneratedError.isInstance(err)) throw err;
    const salvaged = salvage(err.text ?? "");
    if (salvaged) return salvaged;
    const { text } = await generateText({ ...common, telemetry: { isEnabled: o.telemetry, functionId: `analyze.${name}.text` } });
    return salvage(text);
  }
}

// ---------- 1. chunk ----------

export interface Chunk {
  lines: string[];
  start: number;
  end: number;
}

/**
 * Map-window size. ~3 minutes is long enough for several 15–60 s clips and short enough that
 * the model actually reads past the opening (GraphRAG measured ~2× entity recall at 600 tokens
 * vs 2400 in one pass). Character cap is a safety bound on dense speech, not the primary split.
 */
export const MAP_CHUNK_SECONDS = 180;
export const MAP_CHUNK_CHARS = 4000;

/** Split at the longest pause in the last quarter of each window; overlap ~35% so a 60 s clip at the cut appears whole once. */
export function chunkTranscript(segments: TranscriptSegment[], targetChars = MAP_CHUNK_CHARS, overlap = 0.2, targetSec = MAP_CHUNK_SECONDS): Chunk[] {
  if (!segments.length) return [];
  const lines = segments.map((s) => `[${fmtTs(s.start)} - ${fmtTs(s.end)}] ${s.text}`);
  const n = lines.length;
  const chunks: Chunk[] = [];
  let i0 = 0;
  while (i0 < n) {
    let chars = 0;
    let j = i0;
    while (j < n && chars < targetChars && (j === i0 || segments[j - 1]!.end - segments[i0]!.start < targetSec)) {
      chars += lines[j++]!.length + 1;
    }
    if (j >= n) {
      chunks.push({ lines: lines.slice(i0), start: segments[i0]!.start, end: segments[n - 1]!.end });
      break;
    }
    let cut = j;
    let bestGap = -1;
    for (let k = i0 + Math.floor((j - i0) * 0.75); k < j - 1; k++) {
      const gap = segments[k + 1]!.start - segments[k]!.end;
      if (gap > bestGap) {
        bestGap = gap;
        cut = k + 1;
      }
    }
    // a short remainder joins this chunk instead of becoming its own tiny chunk (time, not chars:
    // a long sparse remainder must stay its own window or we recreate a 10-minute prompt)
    const restSec = segments[n - 1]!.end - segments[cut]!.start;
    if (restSec < targetSec * 0.3) {
      chunks.push({ lines: lines.slice(i0), start: segments[i0]!.start, end: segments[n - 1]!.end });
      break;
    }
    chunks.push({ lines: lines.slice(i0, cut), start: segments[i0]!.start, end: segments[cut - 1]!.end });
    const chunkDur = segments[cut - 1]!.end - segments[i0]!.start;
    const wantOverlap = Math.min(chunkDur * 0.35, Math.max(targetSec * overlap, Math.min(60, chunkDur)));
    let k = cut;
    while (k > i0 + 1 && segments[cut - 1]!.end - segments[k - 1]!.start < wantOverlap) k--;
    i0 = Math.max(i0 + 1, k);
  }
  return chunks;
}

/** True when the candidate overlaps this map window (same ±5 s slop as timestamp repair). */
export function inChunk(c: { startSec: number; endSec: number }, chunk: Pick<Chunk, "start" | "end">, slop = 5): boolean {
  return c.endSec > c.startSec && c.endSec > chunk.start - slop && c.startSec < chunk.end + slop;
}

/**
 * One extra map pass is worth it when the window is long enough to hold more than one clip and
 * the first pass left a long uncovered side (usually the tail: primacy bias). A dull stretch that
 * returned nothing still gets one gleaning pass; the prompt already allows {"clips":[]}.
 */
export function needsSecondLook(chunk: Pick<Chunk, "start" | "end">, found: Array<{ startSec: number; endSec: number }>, minSec = 20): boolean {
  const dur = chunk.end - chunk.start;
  if (dur < MAP_CHUNK_SECONDS - 1e-6) return false;
  if (found.length <= 1) return true;
  const slack = minSec + 15;
  const lo = Math.min(...found.map((c) => c.startSec));
  const hi = Math.max(...found.map((c) => c.endSec));
  return lo - chunk.start >= slack || chunk.end - hi >= slack;
}

export function excludeRanges(cs: Array<{ startSec: number; endSec: number; title: string }>): string {
  return cs.length ? cs.map((c) => `${fmtTs(c.startSec)}-${fmtTs(c.endSec)} "${c.title}"`).join("; ") : "none";
}

// ---------- 2. map ----------

export interface SelectContext {
  title: string;
  durationSec: number;
  minSec: number;
  maxSec: number;
  maxClips?: number;
  focus?: string;
  instructions?: string;
}

const mapSchema = z.object({ clips: z.array(clipCandidateSchema) });

export function buildMapPrompt(chunk: Chunk, c: SelectContext, opts: { exclude?: string } = {}) {
  const focus = c.focus ? `\nThe user only wants clips about: "${c.focus}". Skip anything unrelated, however good.\n` : "";
  const extra = c.instructions ? `\nAdditional instructions from the user:\n${c.instructions}\n` : "";
  return `You are an expert short-form video editor who finds the moments in long videos that go viral on TikTok, YouTube Shorts and Instagram Reels.

Video title: ${c.title}
This part of the transcript covers ${fmtTs(chunk.start)} to ${fmtTs(chunk.end)} of a ${Math.round(c.durationSec)} second video.
${focus}${extra}
Below is a timestamped transcript. Each line is "[start - end] text" in mm:ss.s.

Pick every non-overlapping moment in this part that would work as a standalone vertical clip. There is no target count: a dull stretch may have none, a dense one several. Do not pad the list with weak moments.
Rules:
- Each clip must be between ${c.minSec} and ${c.maxSec} seconds long.
- startSec must be the start time of a transcript line and endSec the end time of a transcript line, so the clip starts and ends on complete sentences.
- A clip must make sense without any other context. Prefer moments with a strong opening line, a clear payoff, emotion, controversy, a surprising fact, a story, or actionable advice.
- Do not pick intros, outros, sponsor reads, or housekeeping.
- Avoid moments where the speaker asks viewers to like, subscribe, comment, hit the bell, or refers to "this channel"/"this video": the clips are reposted to other platforms where that makes no sense.
- "score" is a quick 0-100 estimate; it is refined later.
- "hook" is a short on-screen text overlay (3-8 words) in the voice of a creator, not a summary.
- "caption" is the post text for TikTok/Reels/Shorts: 1-2 punchy sentences that make people watch, no hashtags, no emoji spam.
- Titles must be specific, never generic.
${opts.exclude ? `\nAlready selected, do NOT overlap these: ${opts.exclude}. Return only additional strong moments, or {"clips":[]} if there are none.\n` : ""}
Respond with JSON only, exactly this shape (numbers in seconds, not mm:ss):
{"clips":[{"title":"...","hook":"...","startSec":12.3,"endSec":41.0,"score":70,"reasoning":"...","caption":"...","hashtags":["tag1","tag2"]}]}

Transcript:
${chunk.lines.join("\n")}`;
}

export async function mapChunk(o: LlmOpts, chunk: Chunk, c: SelectContext, exclude?: string): Promise<ClipCandidate[]> {
  const res = await llmJson(o, buildMapPrompt(chunk, c, { exclude }), mapSchema, "map", exclude ? 0.7 : 0.4, (t) => {
    const clips = parseClipsLeniently(t);
    return clips.length ? { clips } : null;
  });
  if (!res) throw new Error("The model did not return usable JSON for clip candidates");
  const repaired = res.clips.map((x) => repairTimestamps(normalizeCandidate(x), chunk));
  const kept = repaired.filter((clip) => inChunk(clip, chunk));
  if (kept.length !== repaired.length) o.log?.debug({ chunkStart: chunk.start, chunkEnd: chunk.end, dropped: repaired.length - kept.length }, "map dropped candidates outside the chunk");
  return kept;
}

/**
 * Small models sometimes turn "05:28.0" into 528 (colon dropped) or "5:28" into 5.28 (minutes.seconds
 * as a decimal). If a candidate falls outside the chunk but a reading of its numbers lands inside, use that.
 */
export function repairTimestamps(c: ClipCandidate, chunk: Pick<Chunk, "start" | "end">): ClipCandidate {
  const inside = (a: number, b: number) => a >= chunk.start - 5 && b <= chunk.end + 5 && b > a;
  if (inside(c.startSec, c.endSec)) return c;
  const mmss = (v: number) => {
    const whole = Math.floor(v);
    const ss = whole % 100;
    return ss < 60 ? Math.floor(whole / 100) * 60 + ss + (v - whole) : NaN;
  };
  // 5.28 → 5 min 28 s (not 5.28 seconds, and not 5.28 × 60)
  const mmDotSs = (v: number) => {
    if (!Number.isFinite(v) || v < 0) return NaN;
    const m = Math.floor(v);
    const ss = Math.round((v - m) * 100 + 1e-9);
    return ss < 60 ? m * 60 + ss : NaN;
  };
  for (const conv of [mmss, mmDotSs]) {
    const a = conv(c.startSec);
    const b = conv(c.endSec);
    if (Number.isFinite(a) && Number.isFinite(b) && inside(a, b)) return { ...c, startSec: a, endSec: b };
  }
  return c;
}

// ---------- 4. score ----------

const scoreItem = z.object({
  id: z.number().int(),
  hook: z.number(),
  flow: z.number(),
  value: z.number(),
  shareability: z.number(),
  relevance: z.number().optional(),
  emphasis: z.array(z.string()).max(12).default([]),
});
const scoreSchema = z.object({ scores: z.array(scoreItem) });
type ScoreItem = z.infer<typeof scoreItem>;

const to10 = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 5;
  return Math.max(0, Math.min(10, n > 10 ? n / 10 : n));
};

function salvageScores(text: string): { scores: ScoreItem[] } | null {
  const arr = firstArray(extractJson(text));
  const scores = arr
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      id: Number(r.id ?? r.candidate ?? -1),
      hook: to10(r.hook),
      flow: to10(r.flow ?? r.standalone),
      value: to10(r.value),
      shareability: to10(r.shareability ?? r.share),
      relevance: r.relevance === undefined ? undefined : to10(r.relevance),
      emphasis: Array.isArray(r.emphasis) ? r.emphasis.map(String) : [],
    }))
    .filter((r) => r.id >= 0);
  return scores.length ? { scores } : null;
}

export interface ScoreInput {
  id: number;
  durationSec: number;
  text: string;
}
export interface ScoreResult {
  scores: ClipScores;
  total: number;
  emphasis: string[];
}

export function buildScorePrompt(items: ScoreInput[], c: SelectContext) {
  return `You are judging candidate short-form clips cut from a longer video titled "${c.title}". Score each candidate independently with integers 0-10 (use the full range: 5 = an average short, 8+ = genuinely strong, 2- = should not be posted):
- hook: does the opening line make a scrolling viewer stop within 3 seconds?
- flow: does it stand alone? Starts without missing context, ends on a payoff, no dangling references.
- value: density of insight, emotion, humour, story or practical usefulness.
- shareability: would viewers comment on, share or save it?
${c.focus ? `- relevance: how directly it is about "${c.focus}".\n` : ""}Also return "emphasis": 2-8 single words copied exactly from that candidate's text that carry its meaning (numbers, key nouns, strong verbs). Never filler words or stop-words.

${items.map((it) => `### Candidate ${it.id} (${Math.round(it.durationSec)}s)\n${it.text}`).join("\n\n")}

Respond with JSON only:
{"scores":[{"id":${items[0]?.id ?? 0},"hook":7,"flow":6,"value":8,"shareability":5,${c.focus ? `"relevance":9,` : ""}"emphasis":["word","word"]}]}`;
}

/** Score candidates in small batches, `samples` times each, median per criterion. */
export async function scoreCandidates(o: LlmOpts, items: ScoreInput[], c: SelectContext, samples: number, concurrency: number, onProgress?: (done: number, total: number) => void): Promise<Map<number, ScoreResult>> {
  const BATCH = 4;
  const batches: ScoreInput[][] = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));
  const jobs = batches.flatMap((b) => Array.from({ length: samples }, () => b));
  let done = 0;
  const results = await mapLimit(jobs, concurrency, async (batch) => {
    // models number things from 1 and renumber per prompt: use local 1..k ids, map back afterwards
    const local = batch.map((it, i) => ({ ...it, id: i + 1 }));
    const r = await llmJson(o, buildScorePrompt(local, c), scoreSchema, "score", samples > 1 ? 0.7 : 0.2, salvageScores).catch((err) => {
      if (o.signal?.aborted) throw err;
      o.log?.warn({ err }, "scoring batch failed");
      return null;
    });
    onProgress?.(++done, jobs.length);
    const got = r?.scores ?? [];
    const idsOk = got.every((s) => s.id >= 1 && s.id <= batch.length) && new Set(got.map((s) => s.id)).size === got.length;
    if (!idsOk && got.length === batch.length) return got.map((s, i) => ({ ...s, id: batch[i]!.id })); // trust order instead
    if (!idsOk) o.log?.warn({ ids: got.map((s) => s.id), batch: batch.length }, "scoring batch returned unusable ids");
    return got.filter((s) => s.id >= 1 && s.id <= batch.length).map((s) => ({ ...s, id: batch[s.id - 1]!.id }));
  });
  const byId = new Map<number, ScoreItem[]>();
  for (const s of results.flat()) {
    if (!items.some((it) => it.id === s.id)) continue;
    byId.set(s.id, [...(byId.get(s.id) ?? []), s]);
  }
  const out = new Map<number, ScoreResult>();
  for (const it of items) {
    const ss = byId.get(it.id);
    if (!ss?.length) continue;
    const pick = (k: "hook" | "flow" | "value" | "shareability") => Number(median(ss.map((s) => to10(s[k]))).toFixed(1));
    const rel = c.focus ? Number(median(ss.map((s) => to10(s.relevance ?? 5))).toFixed(1)) : undefined;
    const scores: ClipScores = { hook: pick("hook"), flow: pick("flow"), value: pick("value"), shareability: pick("shareability"), ...(rel !== undefined ? { relevance: rel } : {}), samples: ss.length };
    // emphasis: words most samples agree on, restricted to words actually in the clip
    const inText = new Set(it.text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);
    const votes = new Map<string, number>();
    for (const s of ss) for (const w of new Set(s.emphasis.map((e) => e.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "")))) if (w && inText.has(w)) votes.set(w, (votes.get(w) ?? 0) + 1);
    const need = Math.ceil(ss.length / 2);
    const emphasis = [...votes.entries()].filter(([, v]) => v >= need).sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 8);
    out.set(it.id, { scores, total: rubricTotal(scores), emphasis });
  }
  return out;
}

// ---------- 5. rank ----------

const pairSchema = z.object({ winner: z.enum(["A", "B"]) });

export function buildPairPrompt(a: ScoreInput, b: ScoreInput, c: SelectContext) {
  return `Two candidate shorts were cut from the same video ("${c.title}"). Which one is more likely to perform better on TikTok / Shorts / Reels: stop scrollers in the first seconds, hold attention to the end, and get shared?${c.focus ? ` Prefer the one more clearly about "${c.focus}".` : ""}

### Clip A (${Math.round(a.durationSec)}s)
${a.text}

### Clip B (${Math.round(b.durationSec)}s)
${b.text}

Respond with JSON only: {"winner":"A"} or {"winner":"B"}`;
}

/** 1 = first wins, -1 = second wins, 0 = tie (the judge disagreed with itself when positions swapped). */
async function compare(o: LlmOpts, a: ScoreInput, b: ScoreInput, c: SelectContext): Promise<number> {
  const salvage = (t: string) => {
    const m = /"?winner"?\s*[:=]\s*"?([AB])/i.exec(t) ?? /^\s*([AB])\b/.exec(t);
    return m ? { winner: m[1]!.toUpperCase() as "A" | "B" } : null;
  };
  const [ab, ba] = await Promise.all([
    llmJson(o, buildPairPrompt(a, b, c), pairSchema, "pairwise", 0, salvage).catch(() => null),
    llmJson(o, buildPairPrompt(b, a, c), pairSchema, "pairwise", 0, salvage).catch(() => null),
  ]);
  if (ab?.winner === "A" && ba?.winner === "B") return 1;
  if (ab?.winner === "B" && ba?.winner === "A") return -1;
  return 0;
}

/** Judgments K sliding passes over n items make at most: Σ_{p<K} (n-1-p) pairs, 2 calls each (position swap). */
export function pairwiseCalls(n: number, passes: number) {
  let pairs = 0;
  for (let p = 0; p < Math.min(passes, n - 1); p++) pairs += n - 1 - p;
  return pairs * 2;
}

/**
 * K backward sliding passes (Qin et al. 2024, PRP-Sliding-K): pass p bubbles the best of the
 * remaining items up to position p, so K passes place the top K. One pass only guarantees the
 * leader; users see the top 3 first, hence the default of 3. Each pair is judged once (memoised):
 * a later pass that meets the same pair reuses the verdict. Costs at most `pairwiseCalls(n, K)`.
 * Returns the new order of ids.
 */
export async function pairwiseRank(
  o: LlmOpts,
  items: ScoreInput[],
  c: SelectContext,
  onProgress?: (done: number, total: number) => void,
  passes = 1,
  /** the judge; injectable so the eval can check placement without a model */
  judge: (a: ScoreInput, b: ScoreInput) => Promise<number> = (a, b) => compare(o, a, b, c),
): Promise<number[]> {
  const order = [...items];
  const k = Math.max(1, Math.min(passes, order.length - 1));
  const total = pairwiseCalls(order.length, k) / 2;
  const seen = new Map<string, number>(); // "a|b" → verdict for (a before b)
  let done = 0;
  for (let p = 0; p < k; p++) {
    for (let i = order.length - 1; i > p; i--) {
      if (o.signal?.aborted) return order.map((it) => it.id);
      const lo = order[i]!;
      const hi = order[i - 1]!;
      const key = `${lo.id}|${hi.id}`;
      const back = seen.get(`${hi.id}|${lo.id}`);
      const r = seen.get(key) ?? (back !== undefined ? -back : await judge(lo, hi));
      seen.set(key, r);
      if (r === 1) [order[i - 1], order[i]] = [lo, hi];
      onProgress?.(++done, total);
    }
  }
  return order.map((it) => it.id);
}
