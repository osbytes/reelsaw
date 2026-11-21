import { endsSentence, joinWords, languageProfile, segmentWords, type Word, type TranscriptSegment } from "@reelsaw/shared";
import { collapseDecoderLoops } from "./asr-loops.js";
import { sentenceEndAfter, sentenceRules, type SentenceRules } from "./thought.js";

export interface RawSegment {
  text: string;
  startSecond: number;
  endSecond: number;
}

/** Decide whether a provider gave us word-level or phrase-level segments. */
export function looksWordLevel(segments: RawSegment[]): boolean {
  if (segments.length < 5) return false;
  const singleTokens = segments.filter((s) => !/\s/.test(s.text.trim())).length;
  return singleTokens / segments.length > 0.8;
}

/**
 * Words with times from what the STT model returned. Phrase-level segments are split into words by the language's
 * own rules: spaces for most, a dictionary (Intl.Segmenter) for scripts written without them (Japanese, Thai), where
 * splitting on spaces made a whole sentence one word.
 */
export function toWords(segments: RawSegment[], opts?: { collapseLoops?: boolean; language?: string | null | undefined }): Word[] {
  let words: Word[];
  if (looksWordLevel(segments)) {
    words = segments.map((s) => ({ text: s.text.trim(), start: s.startSecond, end: Math.max(s.endSecond, s.startSecond) })).filter((w) => w.text.length > 0);
  } else {
    words = [];
    const lang = opts?.language;
    const unspaced = !!lang && !languageProfile(lang).spaced;
    for (const seg of segments) {
      const tokens = unspaced ? segmentWords(seg.text, lang) : seg.text.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) continue;
      const dur = Math.max(0.05, seg.endSecond - seg.startSecond);
      const totalChars = tokens.reduce((n, t) => n + t.length, 0) || 1;
      let cursor = seg.startSecond;
      for (const t of tokens) {
        const share = (t.length / totalChars) * dur;
        words.push({ text: t, start: cursor, end: cursor + share });
        cursor += share;
      }
    }
  }
  return opts?.collapseLoops === false ? words : collapseDecoderLoops(words);
}

/**
 * Group words into sentence-ish segments for the LLM and for boundary snapping. A segment ends where the sentence
 * does (thought.ts sentenceRules: the language's punctuation, or, in a transcript without any, the pauses its speaker
 * makes between sentences), at a long silence, or at `maxWords`.
 */
export function toSentences(
  words: Word[],
  opts = { maxWords: 28, maxGap: 1.2 },
  language?: string | null,
  rules: SentenceRules = sentenceRules(words, language),
): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let buf: Word[] = [];
  const flush = () => {
    if (!buf.length) return;
    out.push({
      text: joinWords(
        buf.map((w) => w.text),
        language,
      ),
      start: buf[0]!.start,
      end: buf[buf.length - 1]!.end,
    });
    buf = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const prev = buf[buf.length - 1];
    if (prev && w.start - prev.end > opts.maxGap) flush();
    buf.push(w);
    // punctuation alone ends a segment where the transcript has it, as before; where it has none, the pauses do
    const ends = rules.punctuated ? endsSentence(w.text) : sentenceEndAfter(words, i, rules) !== undefined;
    if (ends || buf.length >= opts.maxWords) flush();
  }
  flush();
  return out;
}

export function offsetSegments(segments: RawSegment[], offset: number): RawSegment[] {
  return segments.map((s) => ({ text: s.text, startSecond: s.startSecond + offset, endSecond: s.endSecond + offset }));
}

export function fmtTs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}
