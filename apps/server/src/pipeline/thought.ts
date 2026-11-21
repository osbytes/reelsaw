/**
 * A clip ends on a complete thought (and starts at the start of one). Pure word-level logic, no I/O.
 *
 * Where a sentence ends, in order of trust:
 *  1. the language's sentence-ending punctuation on the word (Unicode Sentence_Terminal: "." "?" "।" "。" "؟");
 *  2. a pause of at least the transcript's sentence pause after a word that is not a connector;
 *  3. in a language with capitals, the next word starts with one (not "I"), after a real gap, and the word is not a
 *     connector. Many STT models return no punctuation but still capitalise sentence starts.
 * Connectors ("and", "so", "the", …) are English words: they never end an English sentence, whatever follows them.
 * Anything else is "inside a sentence".
 *
 * The rules come from the transcript and its language (sentenceRules). A transcript with almost no punctuation (Hindi
 * from most STT models) has only pauses to go on, and in a script without capitals that is a weak signal: on real STT
 * timing a third of sentence ends have no gap at all and 2% of gaps inside sentences are longer than half a second,
 * so no pause length finds more than about half of the ends (the selection eval, hindi-unpunctuated). The pause stays
 * 0.6 s, the length that keeps the most clip edges on a sentence there, and the stage says it is degraded.
 */
import { CONNECTOR_WORDS, endsSentence, languageProfile, spokenLanguageCode, type Word } from "@reelsaw/shared";

/** How sentences end in one transcript (sentenceRules). */
export interface SentenceRules {
  /** a pause at least this long ends a sentence (after a word that is not a connector) */
  pauseSec: number;
  /** the transcript carries sentence punctuation; false when STT left it out, so pauses decide */
  punctuated: boolean;
  /** the English connector words apply */
  connectors: boolean;
  /** a capital after a gap starts a sentence (the language has case) */
  capitals: boolean;
}

/** A punctuated transcript has at least this share of words ending a sentence (English speech runs at 1 in 10-20). */
const PUNCTUATED_SHARE = 1 / 40;

/** How sentences end in this transcript: from its language (case, connectors) and its own punctuation and pauses. */
export function sentenceRules(words: readonly Word[], lang?: string | null): SentenceRules {
  const code = spokenLanguageCode(lang);
  const ends = words.reduce((n, w) => n + (endsSentence(w.text) ? 1 : 0), 0);
  const punctuated = words.length === 0 || ends / words.length >= PUNCTUATED_SHARE;
  return {
    punctuated,
    pauseSec: 0.6,
    connectors: code === undefined || code === "en",
    capitals: code === undefined || languageProfile(code).cased,
  };
}

/** The rules every transcript had before languages: English, a fixed pause, punctuation trusted alone for segments. */
export const fixedSentenceRules = (pauseSec = 0.6): SentenceRules => ({ pauseSec, punctuated: true, connectors: true, capitals: true });
const englishRules = fixedSentenceRules;

export interface ThoughtLimits {
  /** Length bounds of the span itself (the caller subtracts any padding it adds afterwards). */
  minSec: number;
  maxSec: number;
  /** Furthest the end may move forward to finish the sentence. */
  maxExtendSec?: number;
  /** Furthest the start may move to reach a sentence start. */
  maxStartShiftSec?: number;
  /** A pull-back must keep at least this share of the clip. */
  keepFraction?: number;
  /** Pause that ends a sentence when nothing else does. */
  pauseSec?: number;
  /** How this transcript's sentences end (sentenceRules); default: English rules with `pauseSec`. */
  rules?: SentenceRules;
  /** Never move outside these times (a user's selection). */
  bounds?: [number, number] | undefined;
}

export type EndSignal = "punctuation" | "pause" | "capital" | "transcript-end";

export interface BoundaryChange {
  edge: "start" | "end";
  from: number;
  to?: number;
  /** extend/pull-back for the end, earlier/later for the start; "left" when nothing safe was found. */
  action: "extend" | "pull-back" | "earlier" | "later" | "left";
  /** The signal that marks the new boundary, or why it was left alone. */
  reason: string;
}

export interface ThoughtResult {
  start: number;
  end: number;
  changes: BoundaryChange[];
}

const norm = (t: string) =>
  t
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");

export const isConnector = (text: string) => CONNECTOR_WORDS.has(norm(text));

/** Starts with a capital letter, but "I", "I'm" are capitals everywhere. */
function startsSentence(text: string) {
  const t = text.replace(/^["'“‘([]+/, "");
  return /^\p{Lu}/u.test(t) && !/^I(['’]|$)/.test(t);
}

/**
 * How the sentence ends after word `i`, or undefined when the word sits inside a sentence. `rules` are the
 * transcript's (sentenceRules), or a pause length for English rules.
 */
export function sentenceEndAfter(words: readonly Word[], i: number, rules: SentenceRules | number = 0.6): EndSignal | undefined {
  const r = typeof rules === "number" ? englishRules(rules) : rules;
  const w = words[i];
  if (!w) return undefined;
  if (endsSentence(w.text)) return "punctuation";
  if (r.connectors && isConnector(w.text)) return undefined;
  const next = words[i + 1];
  if (!next) return "transcript-end";
  const gap = next.start - w.end;
  if (gap >= r.pauseSec) return "pause";
  if (r.capitals && gap >= 0.05 && startsSentence(next.text)) return "capital";
  return undefined;
}

const startsAt = (words: readonly Word[], i: number, rules: SentenceRules) => i === 0 || sentenceEndAfter(words, i - 1, rules) !== undefined;

/**
 * Move a clip's edges so it starts at a sentence start and ends at a sentence end.
 *  - end inside a sentence: extend to the next sentence end if within `maxExtendSec` and under
 *    `maxSec`; else pull back to the previous one if that keeps `keepFraction` of the clip (and
 *    `minSec`); else leave it and say why.
 *  - start inside a sentence: the nearest sentence start within `maxStartShiftSec`, earlier first.
 * Precision over recall: when nothing safe is found the edge stays where it was.
 */
export function finishThought(words: Word[], start: number, end: number, limits: ThoughtLimits): ThoughtResult {
  const { minSec, maxSec, maxExtendSec = 8, maxStartShiftSec = 3, keepFraction = 0.7, pauseSec = 0.6, bounds } = limits;
  const rules = limits.rules ?? englishRules(pauseSec);
  const changes: BoundaryChange[] = [];
  const lo = bounds?.[0] ?? -Infinity;
  const hi = bounds?.[1] ?? Infinity;
  // words in the clip: those whose middle falls inside it
  let first = words.findIndex((w) => (w.start + w.end) / 2 > start);
  let last = -1;
  for (let i = words.length - 1; i >= 0; i--) {
    if ((words[i]!.start + words[i]!.end) / 2 < end) {
      last = i;
      break;
    }
  }
  if (first < 0 || last < first) return { start, end, changes };

  // start first: it fixes the length budget for the end
  if (!startsAt(words, first, rules)) {
    const from = start;
    let moved = false;
    for (let k = first - 1; k >= 0 && !moved; k--) {
      const t = words[k]!.start;
      if (start - t > maxStartShiftSec || t < lo) break;
      if (end - t > maxSec) break;
      if (startsAt(words, k, rules)) {
        start = t;
        first = k;
        moved = true;
        changes.push({ edge: "start", from, to: t, action: "earlier", reason: k === 0 ? "transcript-start" : sentenceEndAfter(words, k - 1, rules)! });
      }
    }
    for (let k = first + 1; k <= last && !moved; k++) {
      const t = words[k]!.start;
      if (t - start > maxStartShiftSec) break;
      if (end - t < Math.max(minSec, keepFraction * (end - start))) break;
      if (startsAt(words, k, rules)) {
        start = t;
        first = k;
        moved = true;
        changes.push({ edge: "start", from, to: t, action: "later", reason: sentenceEndAfter(words, k - 1, rules)! });
      }
    }
    if (!moved) changes.push({ edge: "start", from, action: "left", reason: `no sentence start within ${maxStartShiftSec}s that fits` });
  }

  if (sentenceEndAfter(words, last, rules) === undefined) {
    const from = end;
    const len = end - start;
    let moved = false;
    for (let j = last + 1; j < words.length && !moved; j++) {
      const t = words[j]!.end;
      if (t - from > maxExtendSec || t - start > maxSec || t > hi) break;
      const signal = sentenceEndAfter(words, j, rules);
      if (signal) {
        end = t;
        moved = true;
        changes.push({ edge: "end", from, to: t, action: "extend", reason: signal });
      }
    }
    for (let j = last - 1; j >= first && !moved; j--) {
      const t = words[j]!.end;
      if (t - start < Math.max(minSec, keepFraction * len)) break;
      const signal = sentenceEndAfter(words, j, rules);
      if (signal) {
        end = t;
        moved = true;
        changes.push({ edge: "end", from, to: t, action: "pull-back", reason: signal });
      }
    }
    if (!moved)
      changes.push({
        edge: "end",
        from,
        action: "left",
        reason: `no sentence end within +${maxExtendSec}s or keeping ${Math.round(keepFraction * 100)}% of the clip`,
      });
  }
  return { start, end, changes };
}
