/**
 * Disfluency detection: fillers ("um"), repetitions ("the the"), and repairs / false starts
 * ("your pay actual pay dates"). Rules handle the unambiguous cases with near-certain confidence;
 * a deletions-only language-model pass handles repairs. Every result is a TranscriptFlag with an
 * empty `suggested` (= delete), so the review UI, applyFlags and re-render all work unchanged.
 */
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Word, TranscriptFlag } from "@reelsaw/shared";
import type { Logger } from "../log.js";

const FILLERS = new Set(["um", "uh", "umm", "uhh", "uhm", "er", "erm", "ah", "hmm", "mm", "mhm"]);
/** Closed-class words. Two adjacent words of the same class ("into between", "a the") are a substitution repair. */
const PREPOSITIONS = new Set("about above across after against along among around at before behind below beneath beside between beyond by despite during except for from in inside into like near of off on onto out outside over past since through throughout to toward towards under underneath until unto up upon via with within without".split(" "));
const DETERMINERS = new Set("a an the my your his her its our their".split(" "));
/** Prepositions that double as verb particles ("laid out against", "pick up for"): never the first word of a repair. */
const PARTICLES = new Set("out up down over off in on through back along around away across by".split(" "));
/** Legitimate two-word prepositions; never treat these as repairs. */
const COMPOUNDS = new Set(["out of", "up to", "on to", "in between", "due to", "next to", "according to", "as to", "as for", "because of", "instead of", "ahead of", "along with", "apart from", "aside from", "away from", "close to", "far from", "inside of", "off of", "out from", "over to", "prior to", "thanks to", "together with", "up until", "up against", "down to", "in to", "on by", "by for", "for about", "at about", "in about", "from about", "to about", "of about", "in under", "at around", "for around", "in around", "to around", "from under", "from behind", "from within", "from across", "out at", "in for", "up for", "down for", "over for", "through to", "up with", "down with", "in with", "on with", "off with", "out with", "along to", "over with", "through with"]);
const classOf = (w: string) => (PREPOSITIONS.has(w) ? "prep" : DETERMINERS.has(w) ? "det" : null);
export const isFunctionWord = (w: string) => classOf(norm(w)) !== null || FILLERS.has(norm(w));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9']+/g, "");

export interface DisfluencyOptions {
  log?: Logger;
  signal?: AbortSignal;
  telemetry?: boolean;
  autoConfidence?: number;
  /** word indices already covered by other flags; never overlap them */
  reserved?: Set<number>;
  /** skip the LLM pass (rules only) */
  rulesOnly?: boolean;
  /** parallel model windows */
  concurrency?: number;
}

function mkFlag(words: Word[], index: number, span: number, subkind: TranscriptFlag["subkind"], confidence: number, auto: number): TranscriptFlag {
  return {
    id: randomUUID(),
    kind: "disfluency",
    subkind,
    wordIndex: index,
    span,
    start: words[index]!.start,
    end: words[Math.min(words.length - 1, index + span - 1)]!.end,
    heard: words.slice(index, index + span).map((w) => w.text).join(" "),
    suggested: "",
    confidence,
    status: confidence >= auto ? "auto" : "pending",
  };
}

/** Rule-based pass: fillers and immediate repeats. High precision, no model. */
export function detectByRules(words: Word[], reserved = new Set<number>(), auto = 0.85): TranscriptFlag[] {
  const out: TranscriptFlag[] = [];
  const taken = new Set(reserved);
  const claim = (i: number, span: number) => {
    for (let k = i; k < i + span; k++) taken.add(k);
  };
  for (let i = 0; i < words.length; i++) {
    if (taken.has(i)) continue;
    const w = norm(words[i]!.text);
    if (!w) continue;
    if (FILLERS.has(w)) {
      out.push(mkFlag(words, i, 1, "filler", 0.97, auto));
      claim(i, 1);
      continue;
    }
    // "the the", "I I" → drop the first copy (the second carries the sentence-final punctuation)
    const n1 = words[i + 1] ? norm(words[i + 1]!.text) : "";
    if (n1 && n1 === w && !taken.has(i + 1) && !/[.!?]$/.test(words[i]!.text)) {
      out.push(mkFlag(words, i, 1, "repetition", 0.96, auto));
      claim(i, 1);
      continue;
    }
    // "into between", "a the", "and but" → the speaker swapped one function word for another: drop the first
    const c0 = classOf(w);
    if (c0 && n1 && n1 !== w && classOf(n1) === c0 && !PARTICLES.has(w) && !COMPOUNDS.has(`${w} ${n1}`) && !taken.has(i + 1) && !/[.!?,]$/.test(words[i]!.text)) {
      out.push(mkFlag(words, i, 1, "repair", 0.6, auto));
      claim(i, 1);
      continue;
    }
    // "I think I think", "in the in the" → drop the first bigram
    const n2 = words[i + 2] ? norm(words[i + 2]!.text) : "";
    const n3 = words[i + 3] ? norm(words[i + 3]!.text) : "";
    if (n1 && n2 === w && n3 === n1 && !taken.has(i + 1) && !/[.!?]$/.test(words[i + 1]!.text)) {
      out.push(mkFlag(words, i, 2, "repetition", 0.94, auto));
      claim(i, 2);
      i += 1;
    }
  }
  return out;
}

function rewritePrompt(original: string) {
  return `Remove speech disfluencies from this transcript excerpt so it reads cleanly:
- fillers: um, uh, er, hmm
- repetitions: a word or phrase said twice in a row ("the the", "I think I think" → keep one)
- false starts / repairs: an abandoned word or phrase the speaker immediately replaces ("your pay actual pay dates" → "your actual pay dates"; "disappear into between now and" → "disappear between now and"; "on Tuesday, no, Wednesday" → "Wednesday")
Rules: only delete words. Never add, reorder, reword or fix grammar. Keep punctuation and capitalization of the words you keep. If nothing needs removing, return the text unchanged.

Text:
${original}`;
}

const rewriteSchema = z.object({ cleaned: z.string().describe("the same words with disfluencies removed; nothing added or reordered") });

const WINDOW = 120;

/** Longest-common-subsequence alignment of normalized tokens; returns original indices NOT present in the rewrite. */
export function deletedIndices(original: string[], rewritten: string[]): number[] {
  const n = original.length;
  const m = rewritten.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = original[i] === rewritten[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const deleted: number[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (original[i] === rewritten[j]) {
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) deleted.push(i++);
    else j++; // token only in the rewrite: an insertion, which we ignore (and which disqualifies nothing by itself)
  }
  while (i < n) deleted.push(i++);
  return deleted;
}

/**
 * Model pass for false starts the rules can't see. The model rewrites a window cleanly; we diff
 * tokens and keep only deletions. A deletion survives only if every removed word is a filler or
 * is restated within the next few words (the repair). Repairs land as "pending" for review.
 */
export async function detectByModel(model: LanguageModel, words: Word[], opts: DisfluencyOptions = {}): Promise<TranscriptFlag[]> {
  const auto = opts.autoConfidence ?? 0.85;
  const reserved = opts.reserved ?? new Set<number>();
  const out: TranscriptFlag[] = [];
  const starts: number[] = [];
  for (let from = 0; from < words.length; from += WINDOW) starts.push(from);
  const rewrites = new Map<number, string>();
  const concurrency = opts.concurrency ?? 3;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, starts.length) }, async () => {
      for (;;) {
        const from = starts.shift();
        if (from === undefined || opts.signal?.aborted) return;
        const slice = words.slice(from, from + WINDOW);
        try {
          const { output } = await generateText({
            model,
            temperature: 0,
            maxRetries: 1,
            abortSignal: opts.signal,
            output: Output.object({ schema: rewriteSchema, name: "cleaned" }),
            telemetry: { isEnabled: opts.telemetry ?? false, functionId: "transcribe.disfluencies", recordInputs: false, recordOutputs: false },
            prompt: rewritePrompt(slice.map((w) => w.text).join(" ")),
          });
          rewrites.set(from, output.cleaned);
        } catch (err) {
          opts.log?.warn({ err }, "disfluency model pass failed for a window, continuing");
        }
      }
    }),
  );
  for (let from = 0; from < words.length; from += WINDOW) {
    const cleaned = rewrites.get(from);
    if (cleaned === undefined) continue;
    const slice = words.slice(from, from + WINDOW);
    {
    }
    const origNorm = slice.map((w) => norm(w.text));
    const cleanNorm = cleaned.split(/\s+/).map(norm).filter(Boolean);
    if (cleanNorm.length < origNorm.length * 0.6) continue; // the model rewrote instead of trimming; distrust the whole window
    const del = deletedIndices(origNorm, cleanNorm);
    // group consecutive deletions into spans
    const spans: Array<{ i: number; span: number }> = [];
    for (const d of del) {
      const last = spans[spans.length - 1];
      if (last && last.i + last.span === d) last.span++;
      else spans.push({ i: d, span: 1 });
    }
    for (const sp of spans) {
      const i = from + sp.i;
      const span = Math.min(sp.span, 4);
      if ([...Array(span).keys()].some((k) => reserved.has(i + k))) continue;
      const removed = words.slice(i, i + span).map((w) => norm(w.text));
      const following = words.slice(i + span, i + span + 6).map((w) => norm(w.text));
      if (removed.some((t) => /[0-9]/.test(t))) continue;
      const allFillers = removed.every((t) => FILLERS.has(t));
      const restated = removed.every((t) => FILLERS.has(t) || following.includes(t));
      const nextKept = words[i + span] ? norm(words[i + span]!.text) : "";
      // "into" before "between": a lone function word is a repair only if what follows is the same class
      const substitution = removed.length === 1 && classOf(removed[0]!) !== null && classOf(removed[0]!) === classOf(nextKept) && !PARTICLES.has(removed[0]!) && !COMPOUNDS.has(`${removed[0]} ${nextKept}`);
      if (!restated && !substitution) continue; // anything else that vanishes would change meaning: never accepted from the model
      const subkind: TranscriptFlag["subkind"] = allFillers ? "filler" : removed.length === 1 && removed[0] === nextKept ? "repetition" : "repair";
      const confidence = subkind === "filler" ? 0.95 : subkind === "repetition" ? 0.92 : restated ? 0.8 : 0.7;
      out.push(mkFlag(words, i, span, subkind, confidence, auto));
      for (let k = 0; k < span; k++) reserved.add(i + k);
    }
  }
  return out;
}

export async function detectDisfluencies(model: LanguageModel | null, words: Word[], opts: DisfluencyOptions = {}): Promise<TranscriptFlag[]> {
  const reserved = new Set(opts.reserved ?? []);
  const rules = detectByRules(words, reserved, opts.autoConfidence);
  for (const f of rules) for (let k = 0; k < f.span; k++) reserved.add(f.wordIndex + k);
  const modelFlags = model && !opts.rulesOnly ? await detectByModel(model, words, { ...opts, reserved }) : [];
  return [...rules, ...modelFlags].sort((a, b) => a.wordIndex - b.wordIndex);
}

/** Time ranges (clip-relative) to cut out of a clip for the applied disfluency flags. */
export function cutRanges(flags: TranscriptFlag[], clipStart: number, clipEnd: number, pad = 0, minCut = 0.05): Array<{ start: number; end: number }> {
  const ranges = flags
    .filter((f) => f.kind === "disfluency" && (f.status === "auto" || f.status === "accepted"))
    .map((f) => ({ start: Math.max(clipStart, f.start - pad), end: Math.min(clipEnd, f.end + pad) }))
    .filter((r) => r.end - r.start >= minCut && r.end > clipStart && r.start < clipEnd)
    .map((r) => ({ start: r.start - clipStart, end: r.end - clipStart }))
    .sort((a, b) => a.start - b.start);
  // merge overlaps
  const merged: typeof ranges = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 0.01) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/** Keep-segments after removing `cuts` from [0, duration], plus a function mapping old time → new time. */
export function cutPlan(duration: number, cuts: Array<{ start: number; end: number }>) {
  const keep: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.start > cursor) keep.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < duration) keep.push({ start: cursor, end: duration });
  const newDuration = keep.reduce((n, k) => n + (k.end - k.start), 0);
  const mapTime = (t: number): number => {
    let acc = 0;
    for (const k of keep) {
      if (t < k.start) return acc; // inside a cut before this segment: snap to the cut point
      if (t <= k.end) return acc + (t - k.start);
      acc += k.end - k.start;
    }
    return acc;
  };
  return { keep, newDuration, mapTime };
}
