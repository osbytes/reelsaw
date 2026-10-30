/**
 * A clip ends on a complete thought (and starts at the start of one). Pure word-level logic, no I/O.
 *
 * Where a sentence ends, in order of trust:
 *  1. terminal punctuation on the word;
 *  2. a pause of at least `pauseSec` after a word that is not a connector ("and", "so", "the", …);
 *  3. the next word starts with a capital letter (not "I"), after a real gap, and the word is not a
 *     connector. Many STT models return no punctuation but still capitalise sentence starts.
 * Connectors never end a sentence, whatever follows them. Anything else is "inside a sentence".
 */
import { CONNECTOR_WORDS, type Word } from "@reelsaw/shared";

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

const TERMINAL = /[.!?…]["'’”)\]]*$/;
const norm = (t: string) => t.toLowerCase().replace(/[’‘]/g, "'").replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");

export const isConnector = (text: string) => CONNECTOR_WORDS.has(norm(text));

/** Starts with a capital letter, but "I", "I'm" are capitals everywhere. */
function startsSentence(text: string) {
  const t = text.replace(/^["'“‘([]+/, "");
  return /^\p{Lu}/u.test(t) && !/^I(['’]|$)/.test(t);
}

/** How the sentence ends after word `i`, or undefined when the word sits inside a sentence. */
export function sentenceEndAfter(words: Word[], i: number, pauseSec = 0.6): EndSignal | undefined {
  const w = words[i];
  if (!w) return undefined;
  if (TERMINAL.test(w.text)) return "punctuation";
  if (isConnector(w.text)) return undefined;
  const next = words[i + 1];
  if (!next) return "transcript-end";
  const gap = next.start - w.end;
  if (gap >= pauseSec) return "pause";
  if (gap >= 0.05 && startsSentence(next.text)) return "capital";
  return undefined;
}

const startsAt = (words: Word[], i: number, pauseSec: number) => i === 0 || sentenceEndAfter(words, i - 1, pauseSec) !== undefined;

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
  if (!startsAt(words, first, pauseSec)) {
    const from = start;
    let moved = false;
    for (let k = first - 1; k >= 0 && !moved; k--) {
      const t = words[k]!.start;
      if (start - t > maxStartShiftSec || t < lo) break;
      if (end - t > maxSec) break;
      if (startsAt(words, k, pauseSec)) {
        start = t;
        first = k;
        moved = true;
        changes.push({ edge: "start", from, to: t, action: "earlier", reason: k === 0 ? "transcript-start" : sentenceEndAfter(words, k - 1, pauseSec)! });
      }
    }
    for (let k = first + 1; k <= last && !moved; k++) {
      const t = words[k]!.start;
      if (t - start > maxStartShiftSec) break;
      if (end - t < Math.max(minSec, keepFraction * (end - start))) break;
      if (startsAt(words, k, pauseSec)) {
        start = t;
        first = k;
        moved = true;
        changes.push({ edge: "start", from, to: t, action: "later", reason: sentenceEndAfter(words, k - 1, pauseSec)! });
      }
    }
    if (!moved) changes.push({ edge: "start", from, action: "left", reason: `no sentence start within ${maxStartShiftSec}s that fits` });
  }

  if (sentenceEndAfter(words, last, pauseSec) === undefined) {
    const from = end;
    const len = end - start;
    let moved = false;
    for (let j = last + 1; j < words.length && !moved; j++) {
      const t = words[j]!.end;
      if (t - from > maxExtendSec || t - start > maxSec || t > hi) break;
      const signal = sentenceEndAfter(words, j, pauseSec);
      if (signal) {
        end = t;
        moved = true;
        changes.push({ edge: "end", from, to: t, action: "extend", reason: signal });
      }
    }
    for (let j = last - 1; j >= first && !moved; j--) {
      const t = words[j]!.end;
      if (t - start < Math.max(minSec, keepFraction * len)) break;
      const signal = sentenceEndAfter(words, j, pauseSec);
      if (signal) {
        end = t;
        moved = true;
        changes.push({ edge: "end", from, to: t, action: "pull-back", reason: signal });
      }
    }
    if (!moved) changes.push({ edge: "end", from, action: "left", reason: `no sentence end within +${maxExtendSec}s or keeping ${Math.round(keepFraction * 100)}% of the clip` });
  }
  return { start, end, changes };
}
