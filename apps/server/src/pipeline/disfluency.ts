/**
 * Disfluency detection: fillers ("um"), repetitions ("the the"), and repairs / false starts
 * ("your pay actual pay dates"). Every result is a TranscriptFlag with an empty `suggested`
 * (= delete), so the review UI, applyFlags and re-render all work unchanged.
 *
 * Shape (after Shriberg's reparandum → interruption point → repair):
 *   1. rules find the certain cases (filled pauses, plain stutters "the the") and *candidates*
 *      (comma-separated repeats, function-word swaps);
 *   2. a deletions-only model rewrite proposes more candidates (false starts the rules can't see),
 *      kept only when the repair starts right after the deletion (a rough copy), never across a
 *      sentence boundary;
 *   3. a verifier pass asks the model, per candidate in context, whether removing it leaves the
 *      sentence grammatical with the same meaning (emphasis, quotes, lists and needed words are not
 *      disfluencies). Only "cut" verdicts become flags.
 * Prompted models over-delete (the usual failure in the literature), so precision is preferred:
 * a wrong jump cut is worse than a missed "um".
 */
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Word, TranscriptFlag } from "@reelsaw/shared";
import type { Logger } from "../log.js";

const FILLERS = new Set(["um", "uh", "umm", "uhh", "uhm", "er", "erm", "ah", "hmm", "mm", "mhm"]);
/** Closed-class words. Two adjacent words of the same class ("into between", "a the") may be a substitution repair. */
const PREPOSITIONS = new Set("about above across after against along among around at before behind below beneath beside between beyond by despite during except for from in inside into near of off on onto out outside over past since through throughout toward towards under underneath until unto up upon via with within without".split(" "));
const DETERMINERS = new Set("a an the my your his her its our their".split(" "));
/** Prepositions that double as verb particles ("laid out against", "pick up for"): never the first word of a repair. */
const PARTICLES = new Set("out up down over off in on through back along around away across by".split(" "));
/** Legitimate two-word prepositions; never treat these as repairs. */
const COMPOUNDS = new Set(["out of", "up to", "on to", "in between", "due to", "next to", "according to", "as to", "as for", "because of", "instead of", "ahead of", "along with", "apart from", "aside from", "away from", "close to", "far from", "inside of", "off of", "out from", "over to", "prior to", "thanks to", "together with", "up until", "up against", "down to", "in to", "on by", "by for", "for about", "at about", "in about", "from about", "to about", "of about", "in under", "at around", "for around", "in around", "to around", "from under", "from behind", "from within", "from across", "out at", "in for", "up for", "down for", "over for", "through to", "up with", "down with", "in with", "on with", "off with", "out with", "along to", "over with", "through with"]);
/** Words people double on purpose ("very, very", "really really", "blah blah", "no no no"): never a certain stutter. */
const EMPHATIC = new Set("very really so much many more most too way far long big little bad good super pretty totally always never ever no yes yeah yep okay ok blah bye ha haha hey wow please thank thanks again".split(" "));
/**
 * Words that cannot end a clause (nominative pronouns, conjunctions, articles, most prepositions).
 * "I, I think" / "and, and this" can only be a stutter; "show you, you don't" can be two clauses.
 */
const NEVER_CLAUSE_FINAL = new Set("i we they he she and but or nor so because if when while although though the a an my your our their his its of to in at on for with from into onto than as".split(" "));
const DISCOURSE = new Set(["like", "you know", "i mean", "you know like", "like you know"]);
const classOf = (w: string) => (PREPOSITIONS.has(w) ? "prep" : DETERMINERS.has(w) ? "det" : null);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9']+/g, "");
/** Short closed-class word: deleting one is only safe when the repair repeats or replaces it right away. */
const FUNCTION_WORDS = new Set([...PREPOSITIONS, ...DETERMINERS, ..."to like and or but so that this these those it i you we they he she me him her us them is was are were be been am do did does have has had will would can could just then than as if what which who how".split(" ")]);
export const isFunctionWord = (w: string) => FUNCTION_WORDS.has(norm(w)) || FILLERS.has(norm(w));
const endsSentence = (w: Word | undefined) => !!w && /[.!?]["')\]]?$/.test(w.text);
const endsClause = (w: Word | undefined) => !!w && /[,;:]["')\]]?$/.test(w.text);

export interface DisfluencyOptions {
  log?: Logger;
  signal?: AbortSignal;
  telemetry?: boolean;
  autoConfidence?: number;
  /** word indices already covered by other flags; never overlap them */
  reserved?: Set<number>;
  /** skip the model passes (rules only) */
  rulesOnly?: boolean;
  /** parallel model calls */
  concurrency?: number;
  /** contexts the user rejected before ("… [word] …"): shown to the verifier as things not to cut */
  rejectedExamples?: string[];
}

/** A span that might be a disfluency. `certain` ones skip verification. */
export interface Candidate {
  index: number;
  span: number;
  subkind: NonNullable<TranscriptFlag["subkind"]>;
  /** prior confidence before verification */
  prior: number;
  certain: boolean;
  why: string;
}

function mkFlag(words: Word[], c: { index: number; span: number; subkind: TranscriptFlag["subkind"] }, confidence: number, auto: number): TranscriptFlag {
  return {
    id: randomUUID(),
    kind: "disfluency",
    subkind: c.subkind,
    wordIndex: c.index,
    span: c.span,
    start: words[c.index]!.start,
    end: words[Math.min(words.length - 1, c.index + c.span - 1)]!.end,
    heard: words.slice(c.index, c.index + c.span).map((w) => w.text).join(" "),
    suggested: "",
    confidence: Number(confidence.toFixed(2)),
    status: confidence >= auto ? "auto" : "pending",
  };
}

/** Silence after word i (the interruption point): a pause there is evidence of a stutter or restart. */
const pauseAfter = (words: Word[], i: number) => (words[i + 1] ? Math.max(0, words[i + 1]!.start - words[i]!.end) : 0);

/** Rules: certain fillers and stutters, plus candidates that need a second look. No model. */
export function findRuleCandidates(words: Word[], reserved = new Set<number>()): Candidate[] {
  const out: Candidate[] = [];
  const taken = new Set(reserved);
  const claim = (i: number, span: number) => {
    for (let k = i; k < i + span; k++) taken.add(k);
  };
  for (let i = 0; i < words.length; i++) {
    if (taken.has(i)) continue;
    const w = norm(words[i]!.text);
    if (!w) continue;
    if (FILLERS.has(w)) {
      out.push({ index: i, span: 1, subkind: "filler", prior: 0.97, certain: true, why: "filled pause" });
      claim(i, 1);
      continue;
    }
    const n1 = words[i + 1] ? norm(words[i + 1]!.text) : "";
    // "the the", "I, I" → drop the first copy. A plain stutter is certain; a comma between the copies
    // can also be emphasis ("really, really") or two clauses meeting ("show you, you don't"): verify.
    if (n1 && n1 === w && !taken.has(i + 1) && !endsSentence(words[i])) {
      const comma = endsClause(words[i]);
      const emphatic = EMPHATIC.has(w);
      // a comma only creates doubt when the first copy could end a clause on its own
      const certain = !emphatic && (!comma || NEVER_CLAUSE_FINAL.has(w));
      if (emphatic) {
        // "very, very", "blah, blah": said on purpose; leave it alone (and skip the other copies too)
        let j = i;
        while (words[j + 1] && norm(words[j + 1]!.text) === w) j++;
        claim(i, j - i + 1);
        i = j;
        continue;
      }
      out.push({ index: i, span: 1, subkind: "repetition", prior: certain ? 0.96 : emphatic ? 0.55 : 0.75, certain, why: comma ? "repeat across a comma" : emphatic ? "repeated emphasis word" : "immediate repeat" });
      claim(i, 1);
      continue;
    }
    // "into between", "a the": the speaker swapped one function word for the same kind. Determiner
    // pairs are reliable; preposition pairs are usually a phrase ending then another starting
    // ("paid for out of", "proud of in"), so they only become candidates.
    const c0 = classOf(w);
    if (c0 && n1 && n1 !== w && classOf(n1) === c0 && !PARTICLES.has(w) && !COMPOUNDS.has(`${w} ${n1}`) && !taken.has(i + 1) && !endsClause(words[i]) && !endsSentence(words[i])) {
      out.push({ index: i, span: 1, subkind: "repair", prior: c0 === "det" ? 0.75 : 0.45, certain: false, why: `${c0 === "det" ? "determiner" : "preposition"} swapped for another` });
      claim(i, 1);
      continue;
    }
    // "I think I think", "in the in the" → drop the first bigram
    const n2 = words[i + 2] ? norm(words[i + 2]!.text) : "";
    const n3 = words[i + 3] ? norm(words[i + 3]!.text) : "";
    if (n1 && n2 === w && n3 === n1 && !taken.has(i + 1) && !endsSentence(words[i + 1])) {
      const comma = endsClause(words[i + 1]);
      const certain = !comma || NEVER_CLAUSE_FINAL.has(w);
      out.push({ index: i, span: 2, subkind: "repetition", prior: certain ? 0.94 : 0.75, certain, why: comma ? "phrase repeated across a comma" : "phrase repeated" });
      claim(i, 2);
      i += 1;
    }
  }
  return out;
}

function rewritePrompt(original: string) {
  return `Remove speech disfluencies from this transcript excerpt so it reads cleanly:
- fillers: um, uh, er, hmm
- repetitions: a word or phrase said twice in a row by accident ("the the", "I think I think" → keep one)
- false starts / repairs: an abandoned word or phrase the speaker immediately replaces ("your pay actual pay dates" → "your actual pay dates"; "on Tuesday, no, Wednesday" → "Wednesday")
Do NOT remove: words the grammar needs, intentional emphasis ("very, very", "really, really"), quoted speech, list items, or discourse words that carry meaning.
Rules: only delete words. Never add, reorder, reword or fix grammar. Keep punctuation and capitalization of the words you keep. When in doubt, keep the word. If nothing needs removing, return the text unchanged.

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
    else j++; // token only in the rewrite: an insertion, which we ignore
  }
  while (i < n) deleted.push(i++);
  return deleted;
}

/**
 * Does deleting words[i..i+span) look like a reparandum? The repair has to start right after it
 * (optionally after a filler) and roughly copy it: the same first word, or the same kind of
 * function word, or a restated content word within a few words. Never across a sentence end.
 */
export function roughCopy(words: Word[], i: number, span: number): { ok: boolean; prior: number; subkind: Candidate["subkind"] } {
  const removed = words.slice(i, i + span);
  const r = removed.map((w) => norm(w.text));
  if (r.some((t) => /[0-9]/.test(t))) return { ok: false, prior: 0, subkind: "repair" };
  if (r.every((t) => FILLERS.has(t))) return { ok: true, prior: 0.95, subkind: "filler" };
  // discourse markers ("and like throwing", "you know") often are fillers, but carry meaning just as
  // often (quotative "he was like", comparisons): a candidate for the verifier, never a certain cut
  if (DISCOURSE.has(r.join(" "))) return { ok: true, prior: 0.55, subkind: "filler" };
  // a reparandum never contains or ends a sentence: "…summer. The fifth…" is two sentences, not a repair
  if (removed.slice(0, -1).some((w) => endsSentence(w)) || endsSentence(removed.at(-1))) return { ok: false, prior: 0, subkind: "repair" };
  let j = i + span;
  while (words[j] && FILLERS.has(norm(words[j]!.text))) j++; // interregnum: "the, uh, the"
  const next = words.slice(j, j + 4).map((w) => norm(w.text));
  if (!next.length) return { ok: false, prior: 0, subkind: "repair" };
  // exact repeat: "is is", "it was, it was"
  if (r.join(" ") === next.slice(0, r.length).join(" ")) return { ok: true, prior: endsClause(removed.at(-1)) ? 0.75 : 0.9, subkind: "repetition" };
  const content = r.filter((t) => !FUNCTION_WORDS.has(t));
  if (!content.length) {
    // only short words: the repair must restart on the same word or swap in the same kind of word, immediately
    const first = r[0]!;
    const sameStart = next[0] === first || next[1] === first;
    const swap = r.length === 1 && classOf(first) !== null && classOf(first) === classOf(next[0]!) && !PARTICLES.has(first) && !COMPOUNDS.has(`${first} ${next[0]}`);
    if (sameStart) return { ok: true, prior: 0.7, subkind: "repair" };
    if (swap) return { ok: true, prior: 0.55, subkind: "repair" };
    return { ok: false, prior: 0, subkind: "repair" };
  }
  // content words must come back right away: "your pay actual pay dates"
  const restated = content.every((t) => next.includes(t));
  return restated ? { ok: true, prior: 0.8, subkind: "repair" } : { ok: false, prior: 0, subkind: "repair" };
}

async function mapWindows<T>(n: number, concurrency: number, fn: (k: number) => Promise<T>): Promise<Array<T | undefined>> {
  const out: Array<T | undefined> = new Array(n);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, n) }, async () => {
      while (next < n) {
        const k = next++;
        out[k] = await fn(k);
      }
    }),
  );
  return out;
}

/** Model rewrite → deletions → candidates that pass the rough-copy test. */
export async function findModelCandidates(model: LanguageModel, words: Word[], opts: DisfluencyOptions = {}): Promise<Candidate[]> {
  const reserved = opts.reserved ?? new Set<number>();
  const starts: number[] = [];
  for (let from = 0; from < words.length; from += WINDOW) starts.push(from);
  const rewrites = await mapWindows(starts.length, opts.concurrency ?? 3, async (k) => {
    if (opts.signal?.aborted) return undefined;
    const slice = words.slice(starts[k]!, starts[k]! + WINDOW);
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
      return output.cleaned;
    } catch (err) {
      opts.log?.warn({ err }, "disfluency model pass failed for a window, continuing");
      return undefined;
    }
  });
  const out: Candidate[] = [];
  starts.forEach((from, k) => {
    const cleaned = rewrites[k];
    if (cleaned === undefined) return;
    const slice = words.slice(from, from + WINDOW);
    const origNorm = slice.map((w) => norm(w.text));
    const cleanNorm = cleaned.split(/\s+/).map(norm).filter(Boolean);
    if (cleanNorm.length < origNorm.length * 0.6) return; // the model rewrote instead of trimming; distrust the window
    const spans: Array<{ i: number; span: number }> = [];
    for (const d of deletedIndices(origNorm, cleanNorm)) {
      const last = spans[spans.length - 1];
      if (last && last.i + last.span === d) last.span++;
      else spans.push({ i: d, span: 1 });
    }
    for (const sp of spans) {
      const i = from + sp.i;
      const span = Math.min(sp.span, 4);
      if ([...Array(span).keys()].some((q) => reserved.has(i + q))) continue;
      const rc = roughCopy(words, i, span);
      if (!rc.ok) continue;
      out.push({ index: i, span, subkind: rc.subkind, prior: rc.prior, certain: rc.subkind === "filler" && rc.prior >= 0.9, why: "model rewrite" });
    }
  });
  return out;
}

function verifyPrompt(items: Array<{ id: number; spoken: string; edited: string }>, rejected: string[]) {
  return `Each item shows a sentence as it was spoken (A) and the same sentence with a few words removed (B).
Answer "cut" if B is simply A without a speech disfluency: a filled pause, an accidental stutter, or an abandoned false start the speaker immediately corrected. Answer "keep" if removing the words changes the meaning, drops emphasis the speaker intended, breaks the grammar, or merges two separate clauses.

Examples:
- A: "we, we went home early" B: "we went home early" → cut (stutter)
- A: "it is, it is a big deal" B: "it is a big deal" → cut (stutter)
- A: "send the report to the client by Friday" B: "send the report the client by Friday" → keep (needed word)
- A: "I need the red, the blue folder" B: "I need the blue folder" → cut (false start, corrected)
- A: "it was so, so good" B: "it was so good" → keep (emphasis)
- A: "tell them, they won't mind" B: "tell them won't mind" → keep (two clauses)
- A: "she was looking for out of town jobs" B: "she was looking out of town jobs" → keep (needed word)
${rejected.length ? `\nThe user rejected these cuts before (keep):\n${rejected.map((r) => `- ${r}`).join("\n")}\n` : ""}
Items:
${items.map((it) => `${it.id}. A: "${it.spoken}"\n   B: "${it.edited}"`).join("\n")}`;
}

const verdictSchema = z.object({
  verdicts: z.array(z.object({ id: z.number().int(), verdict: z.enum(["cut", "keep"]), confidence: z.number().min(0).max(1).optional() })),
});

/** Second opinion on uncertain candidates, in batches. Returns verdicts by candidate position. */
export async function verifyCandidates(model: LanguageModel, words: Word[], cands: Candidate[], opts: DisfluencyOptions = {}): Promise<Map<number, { cut: boolean; confidence: number }>> {
  const result = new Map<number, { cut: boolean; confidence: number }>();
  const BATCH = 6;
  const batches: number[][] = [];
  for (let k = 0; k < cands.length; k += BATCH) batches.push(cands.slice(k, k + BATCH).map((_, q) => k + q));
  // the sentence around a candidate, as spoken and with the candidate removed
  const pair = (c: Candidate) => {
    let a = c.index;
    while (a > 0 && c.index - a < 18 && !endsSentence(words[a - 1])) a--;
    let b = c.index + c.span;
    while (b < words.length && b - (c.index + c.span) < 14 && !endsSentence(words[b - 1])) b++;
    const t = (ws: Word[]) => ws.map((w) => w.text).join(" ");
    return { spoken: t(words.slice(a, b)), edited: t([...words.slice(a, c.index), ...words.slice(c.index + c.span, b)]) };
  };
  const ask = async (ids: number[]) => {
    const { output } = await generateText({
      model,
      temperature: 0,
      maxRetries: 1,
      abortSignal: opts.signal,
      output: Output.object({ schema: verdictSchema, name: "verdicts" }),
      telemetry: { isEnabled: opts.telemetry ?? false, functionId: "transcribe.disfluencies.verify", recordInputs: false, recordOutputs: false },
      prompt: verifyPrompt(
        ids.map((id, q) => ({ id: q + 1, ...pair(cands[id]!) })),
        (opts.rejectedExamples ?? []).slice(0, 8),
      ),
    });
    for (const v of output.verdicts) {
      const id = ids[v.id - 1];
      if (id !== undefined) result.set(id, { cut: v.verdict === "cut", confidence: v.confidence ?? 0.8 });
    }
  };
  await mapWindows(batches.length, opts.concurrency ?? 3, async (k) => {
    try {
      await ask(batches[k]!);
    } catch {
      // small models sometimes break the schema on a batch: retry one at a time
      for (const id of batches[k]!) {
        try {
          await ask([id]);
        } catch (err) {
          opts.log?.warn({ err }, "disfluency verification failed for a candidate; dropped");
        }
      }
    }
  });
  return result;
}

/** One candidate cut and what happened to it (stage artifact for diagnosis / reports). */
export interface DisfluencyTraceEntry {
  wordIndex: number;
  span: number;
  text: string;
  subkind: string;
  source: "rule" | "model";
  certain: boolean;
  prior: number;
  why: string;
  verdict?: { cut: boolean; confidence: number } | null;
  outcome: string;
}

export async function detectDisfluencies(model: LanguageModel | null, words: Word[], opts: DisfluencyOptions = {}, trace?: DisfluencyTraceEntry[]): Promise<TranscriptFlag[]> {
  const auto = opts.autoConfidence ?? 0.85;
  const reserved = new Set(opts.reserved ?? []);
  const rules = findRuleCandidates(words, reserved);
  for (const c of rules) for (let k = 0; k < c.span; k++) reserved.add(c.index + k);
  const useModel = !!model && !opts.rulesOnly;
  const fromModel = useModel ? await findModelCandidates(model!, words, { ...opts, reserved }) : [];
  const all = [...rules, ...fromModel];
  const uncertain = all.filter((c) => !c.certain);
  const verdicts = useModel && uncertain.length ? await verifyCandidates(model!, words, uncertain, opts) : null;
  const flags: TranscriptFlag[] = [];
  const note = (c: Candidate, outcome: string, verdict?: { cut: boolean; confidence: number } | null) =>
    trace?.push({ wordIndex: c.index, span: c.span, text: words.slice(c.index, c.index + c.span).map((w) => w.text).join(" "), subkind: c.subkind, source: rules.includes(c) ? "rule" : "model", certain: c.certain, prior: c.prior, why: c.why, verdict, outcome });
  for (const c of all) {
    const pause = pauseAfter(words, c.index + c.span - 1);
    if (c.certain) {
      flags.push(mkFlag(words, c, c.prior, auto));
      note(c, flags.at(-1)!.status);
      continue;
    }
    if (verdicts) {
      const v = verdicts.get(uncertain.indexOf(c));
      if (!v?.cut) {
        note(c, v ? "verifier: keep" : "verifier failed", v ?? null);
        continue; // the verifier says keep (or failed): never cut on a guess
      }
      // agreement of rules/rewrite and verifier; a pause at the interruption point adds confidence.
      // Repairs always go to review; only verified stutters with a pause may apply automatically.
      // anything that needed a second opinion goes to review: only certain cases apply automatically
      const conf = Math.min(auto - 0.01, (c.prior + v.confidence) / 2 + (pause >= 0.15 ? 0.05 : 0));
      flags.push(mkFlag(words, c, conf, auto));
      note(c, flags.at(-1)!.status, v);
    } else if (c.prior >= 0.7) {
      // rules only: uncertain candidates go to review, never auto
      flags.push(mkFlag(words, c, Math.min(c.prior, auto - 0.01), auto));
      note(c, flags.at(-1)!.status);
    } else note(c, "low prior, no verifier");
  }
  return flags.sort((a, b) => a.wordIndex - b.wordIndex);
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
