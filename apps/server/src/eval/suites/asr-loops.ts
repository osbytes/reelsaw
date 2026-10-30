/**
 * asr-loops: Whisper (and similar decoder ASR) runaway repeats, collapsed without a model.
 *
 * Cases are word lists (or one phrase-level segment) labelled with what must survive. The triathlon
 * report (2026-10-24, dee69555) is the source of the two loop shapes; keep-cases are the spoken
 * emphasis and 2-copy repeats this must not eat (disfluency.ts EMPHATIC, "had had" from the
 * caption-diff set). See pipeline/asr-loops.ts for the Whisper compression-ratio grounding.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Word } from "@reelsaw/shared";
import { collapseDecoderLoopsWithStats, flagsFromCollapse, tokenKey } from "../../pipeline/asr-loops.js";
import { applyFlags } from "../../pipeline/entities.js";
import { toWords, type RawSegment } from "../../pipeline/transcript.js";
import type { CaseResult, FixtureSource, Suite } from "../framework.js";

type Repeat = { repeat: string; n: number; start: number; end: number };
type PhraseRepeat = { phrase: string[]; n: number; start: number; end: number };
type WordSpec = Word | Repeat | PhraseRepeat;

interface Case {
  id: string;
  note: string;
  source?: FixtureSource;
  words?: WordSpec[];
  /** phrase-level ASR segment(s); run through toWords (which collapses) */
  segments?: RawSegment[];
  expect: {
    unchanged?: boolean;
    /** longest consecutive run of this token after collapse, case-insensitive */
    maxRun?: { token: string; n: number };
    contains?: string;
    droppedAtLeast?: number;
    /** exact joined text after collapse (keep-cases) */
    text?: string;
  };
}

function isTokenRepeat(w: WordSpec): w is Repeat {
  return "repeat" in w;
}
function isPhraseRepeat(w: WordSpec): w is PhraseRepeat {
  return "phrase" in w;
}

function expand(specs: WordSpec[]): Word[] {
  const out: Word[] = [];
  for (const s of specs) {
    if (isTokenRepeat(s)) {
      const step = s.n > 1 && s.end > s.start ? (s.end - s.start) / s.n : 0;
      for (let i = 0; i < s.n; i++) {
        const t0 = s.start + i * step;
        out.push({ text: s.repeat, start: t0, end: t0 + step });
      }
      continue;
    }
    if (isPhraseRepeat(s)) {
      const total = s.n * s.phrase.length;
      const step = total > 1 && s.end > s.start ? (s.end - s.start) / total : 0;
      let k = 0;
      for (let i = 0; i < s.n; i++) {
        for (const text of s.phrase) {
          const t0 = s.start + k * step;
          out.push({ text, start: t0, end: t0 + step });
          k++;
        }
      }
      continue;
    }
    out.push(s);
  }
  return out;
}

function joined(words: Word[]): string {
  return words.map((w) => w.text).join(" ");
}

function maxRun(words: Word[], token: string): number {
  const want = tokenKey(token);
  let best = 0;
  let cur = 0;
  for (const w of words) {
    if (tokenKey(w.text) === want) {
      cur++;
      if (cur > best) best = cur;
    } else cur = 0;
  }
  return best;
}

export const asrLoopsSuite: Suite = {
  name: "asr-loops",
  description: "ASR decoder-loop collapse: runaway unigram/n-gram repeats are trimmed; short emphatic repeats and 2-copy phrases are kept",
  needs: [],
  async run(ctx) {
    const spec = JSON.parse(await fs.readFile(path.join(ctx.fixtures("asr-loops"), "cases.json"), "utf8")) as { cases: Case[] };
    return spec.cases.map((c) => grade(c));
  },
};

function grade(c: Case): CaseResult {
  const input = c.segments ? toWords(c.segments, { collapseLoops: false }) : expand(c.words ?? []);
  const result = collapseDecoderLoopsWithStats(input);
  const out = result.words;
  const flags = flagsFromCollapse(input, result);
  const text = joined(out);
  const dropped = input.length - out.length;
  const notes: string[] = [];
  let pass = true;
  if (c.expect.unchanged) {
    if (dropped !== 0 || text !== joined(input)) {
      pass = false;
      notes.push(`changed: dropped ${dropped}`);
    }
    if (flags.length) {
      pass = false;
      notes.push(`unexpected ${flags.length} loop flag(s)`);
    }
  }
  if (c.expect.text !== undefined && text !== c.expect.text) {
    pass = false;
    notes.push(`text ${JSON.stringify(text)} ≠ ${JSON.stringify(c.expect.text)}`);
  }
  if (c.expect.contains && !text.toLowerCase().includes(c.expect.contains.toLowerCase())) {
    pass = false;
    notes.push(`missing ${JSON.stringify(c.expect.contains)}`);
  }
  if (c.expect.maxRun) {
    const n = maxRun(out, c.expect.maxRun.token);
    if (n > c.expect.maxRun.n) {
      pass = false;
      notes.push(`run of "${c.expect.maxRun.token}" is ${n}, want ≤ ${c.expect.maxRun.n}`);
    }
  }
  if (c.expect.droppedAtLeast !== undefined && dropped < c.expect.droppedAtLeast) {
    pass = false;
    notes.push(`dropped ${dropped}, want ≥ ${c.expect.droppedAtLeast}`);
  }
  if (!c.expect.unchanged && dropped > 0 && !flags.length) {
    pass = false;
    notes.push("collapsed with no transcript flag");
  }
  if (flags.length) {
    if (joined(applyFlags(input, flags)) !== text) {
      pass = false;
      notes.push("applyFlags(raw, flags) ≠ collapsed words");
    }
    if (
      joined(
        applyFlags(
          input,
          flags.map((f) => ({ ...f, status: "rejected" as const })),
        ),
      ) !== joined(input)
    ) {
      pass = false;
      notes.push("rejecting the loop flag did not restore as-heard words");
    }
  }
  return { id: c.id, pass, metrics: { in: input.length, out: out.length, dropped, flags: flags.length }, notes: notes.join("; ") };
}
