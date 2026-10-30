import type { Word, TranscriptSegment } from "@reelsaw/shared";
import { collapseDecoderLoops } from "./asr-loops.js";

export interface RawSegment {
  text: string;
  startSecond: number;
  endSecond: number;
}

export const SENTENCE_END = /[.!?…。！？｡।॥؟۔]["')\]」』）”’]?$/u;

/** Decide whether a provider gave us word-level or phrase-level segments. */
export function looksWordLevel(segments: RawSegment[]): boolean {
  if (segments.length < 5) return false;
  const singleTokens = segments.filter((s) => !/\s/.test(s.text.trim())).length;
  return singleTokens / segments.length > 0.8;
}

export function toWords(segments: RawSegment[], opts?: { collapseLoops?: boolean }): Word[] {
  let words: Word[];
  if (looksWordLevel(segments)) {
    words = segments.map((s) => ({ text: s.text.trim(), start: s.startSecond, end: Math.max(s.endSecond, s.startSecond) })).filter((w) => w.text.length > 0);
  } else {
    words = [];
    for (const seg of segments) {
      const tokens = seg.text.trim().split(/\s+/).filter(Boolean);
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

/** Group words into sentence-ish segments for the LLM and for boundary snapping. */
export function toSentences(words: Word[], opts = { maxWords: 28, maxGap: 1.2 }): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let buf: Word[] = [];
  const flush = () => {
    if (!buf.length) return;
    out.push({
      text: buf.map((w) => w.text).join(" "),
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
    if (SENTENCE_END.test(w.text) || buf.length >= opts.maxWords) flush();
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
