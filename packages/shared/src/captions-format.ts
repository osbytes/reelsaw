/**
 * SRT / WebVTT: writing the captions of a render or a transcript, and reading a transcript back in.
 * Pure functions, no I/O. Times are seconds.
 */
import type { TranscriptSegment, Word } from "./index.js";

/** One line of captions to write; `text` defaults to the words joined by spaces. */
export interface CaptionLine {
  start: number;
  end: number;
  text?: string;
  words?: Array<{ text: string; start: number; end: number }>;
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export interface ParsedCues {
  cues: Cue[];
  /** things that were skipped or repaired, as sentences a person can read */
  warnings: string[];
}

export const MAX_CUES = 50_000;

const lineText = (l: CaptionLine) =>
  (l.text ?? (l.words ?? []).map((w) => w.text).join(" "))
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");

function stamp(sec: number, sep: "," | "."): string {
  const total = Math.max(0, Math.round((Number.isFinite(sec) ? sec : 0) * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60_000) % 60;
  const h = Math.floor(total / 3_600_000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms, 3)}`;
}

/** A cue's end is always after its start (players drop zero-length cues). */
const endOf = (l: CaptionLine) => (l.end > l.start ? l.end : l.start + 0.001);

/** Lines as an SRT file. Lines with no text are left out. */
export function toSrt(lines: CaptionLine[]): string {
  const out: string[] = [];
  let n = 0;
  for (const l of lines) {
    const text = lineText(l);
    if (!text) continue;
    n++;
    out.push(`${n}\n${stamp(l.start, ",")} --> ${stamp(endOf(l), ",")}\n${text}\n`);
  }
  return out.join("\n");
}

const vttEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Lines as a WebVTT file. With `wordTimes` each word after the first carries a timestamp tag
 * (`word <00:00:01.250>next`), the karaoke form players and editors highlight word by word.
 */
export function toVtt(lines: CaptionLine[], opts: { wordTimes?: boolean } = {}): string {
  const out: string[] = ["WEBVTT\n"];
  for (const l of lines) {
    const text = lineText(l);
    if (!text) continue;
    let body = vttEscape(text);
    const words = (l.words ?? []).filter((w) => w.text.trim());
    if (opts.wordTimes && words.length) {
      body = words.map((w, i) => (i === 0 ? vttEscape(w.text.trim()) : `<${stamp(Math.max(w.start, l.start), ".")}>${vttEscape(w.text.trim())}`)).join(" ");
    }
    out.push(`${stamp(l.start, ".")} --> ${stamp(endOf(l), ".")}\n${body}\n`);
  }
  return out.join("\n");
}

/**
 * The caption lines of a transcript: one per segment, carrying the words that fall inside it.
 * Words and segments are both in time order, so a single pass assigns each word by its midpoint.
 */
export function linesFromTranscript(segments: TranscriptSegment[], words: Word[]): CaptionLine[] {
  let wi = 0;
  return segments.map((s) => {
    const own: Word[] = [];
    for (; wi < words.length; wi++) {
      const w = words[wi]!;
      const mid = (w.start + w.end) / 2;
      if (mid >= s.end) break; // belongs to a later segment
      if (mid >= s.start) own.push(w); // words in a gap before the segment are left out
    }
    return { start: s.start, end: s.end, text: s.text, words: own };
  });
}

// ---------- parsing ----------

const TS = String.raw`(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?`;
const TIMING = new RegExp(String.raw`^\s*${TS}\s*-->\s*${TS}(?:\s.*)?$`);

function seconds(h: string | undefined, m: string, s: string, f: string | undefined): number {
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + (f ? Number(f.padEnd(3, "0")) / 1000 : 0);
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "", rlm: "" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Markup that carries no words: cue tags, word timestamps and SSA/ASS overrides such as {\an8}. */
function stripMarkup(s: string): string {
  return decodeEntities(
    s
      .replace(/<\d{1,2}:\d{2}(?::\d{2})?\.\d{1,3}>/g, "")
      .replace(/<\/?(?:b|i|u|c|v|ruby|rt|rp|lang|font)(?:[.\s][^>]*)?>/gi, "")
      .replace(/\{\\[^}]*\}/g, ""),
  );
}

function parseCues(raw: string, kind: "srt" | "vtt"): ParsedCues {
  const warnings: string[] = [];
  const lines = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const label = kind === "vtt" ? "WebVTT" : "SRT";
  const first = lines.find((l) => l.trim())?.trim() ?? "";
  if (kind === "vtt" && !first.startsWith("WEBVTT")) warnings.push("The file does not start with WEBVTT; read it as WebVTT anyway.");
  if (kind === "srt" && first.startsWith("WEBVTT")) warnings.push("The file is WebVTT; read it as SRT anyway.");

  const cues: Cue[] = [];
  let cur: { start: number; end: number; lines: string[] } | null = null;
  let skipped = 0;
  const flush = () => {
    if (!cur) return;
    const text = cur.lines
      .map((l) => stripMarkup(l).trim())
      .filter(Boolean)
      .join("\n");
    if (!text) skipped++;
    else if (!(cur.end > cur.start)) {
      skipped++;
      warnings.push(`Skipped a cue at ${stamp(cur.start, ".")} because it ends before it starts.`);
    } else {
      if (cues.length >= MAX_CUES) throw new Error(`That file has more than ${MAX_CUES.toLocaleString("en-US")} cues; split it and import the parts you need.`);
      cues.push({ start: cur.start, end: cur.end, text });
    }
    cur = null;
  };

  for (const line of lines) {
    const m = TIMING.exec(line);
    if (m) {
      // a cue that ran straight into the next one (no blank line): its last numeric line was the next cue's index
      if (cur && cur.lines.length > 1 && /^\s*\d+\s*$/.test(cur.lines[cur.lines.length - 1]!)) cur.lines.pop();
      flush();
      cur = { start: seconds(m[1], m[2]!, m[3]!, m[4]), end: seconds(m[5], m[6]!, m[7]!, m[8]), lines: [] };
    } else if (!line.trim()) flush();
    else if (cur) cur.lines.push(line);
    // before the first timing line, and between cues: headers, indices, identifiers, NOTE / STYLE / REGION blocks
  }
  flush();

  if (skipped) warnings.push(`Skipped ${skipped} empty or invalid ${skipped === 1 ? "cue" : "cues"}.`);
  if (cues.some((c, i) => i > 0 && c.start < cues[i - 1]!.start)) {
    cues.sort((a, b) => a.start - b.start || a.end - b.end);
    warnings.push("The cues were out of order; they were sorted by start time.");
  }
  if (!cues.length) warnings.push(`No ${label} cues found in that file.`);
  return { cues, warnings };
}

export function parseSrt(text: string): ParsedCues {
  return parseCues(text, "srt");
}

export function parseVtt(text: string): ParsedCues {
  return parseCues(text, "vtt");
}

/** `auto` decides from the WEBVTT header. */
export function parseCaptions(text: string, format: "auto" | "srt" | "vtt" = "auto"): ParsedCues & { format: "srt" | "vtt" } {
  const kind = format === "auto" ? (/^﻿?\s*WEBVTT/.test(text) ? "vtt" : "srt") : format;
  return { ...parseCues(text, kind), format: kind };
}

// ---------- cues → transcript ----------

const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;
const CJK_LANGUAGES = /^(zh|ja|yue)/i;

/** Whitespace-separated words; CJK text has none, so each character is a word. */
function tokens(text: string, language: string | undefined): string[] {
  const split = text.split(/\s+/).filter(Boolean);
  if (!(language && CJK_LANGUAGES.test(language)) && !CJK.test(text)) return split;
  return split.flatMap((t) => (CJK.test(t) ? (t.match(/[぀-ヿ㐀-鿿豈-﫿]|[^぀-ヿ㐀-鿿豈-﫿]+/g) ?? [t]) : [t]));
}

/**
 * Each cue becomes a segment and its words are spread over the cue by character length. An SRT / VTT
 * file has no word timing; that is good enough because the render force-aligns the words against the
 * audio before it draws karaoke captions, so only the cue edges have to be right here.
 * Cues that overlap (rolling captions) start their words after the previous cue's last word.
 */
export function cuesToTranscript(cues: Cue[], opts: { language?: string | undefined } = {}): { words: Word[]; segments: TranscriptSegment[] } {
  const words: Word[] = [];
  const segments: TranscriptSegment[] = [];
  let lastEnd = 0;
  for (const cue of cues) {
    const toks = tokens(cue.text, opts.language);
    if (!toks.length) continue;
    segments.push({ text: toks.join(" "), start: cue.start, end: cue.end });
    const from = cue.start >= lastEnd || lastEnd >= cue.end ? cue.start : lastEnd;
    const span = cue.end - from;
    const total = toks.reduce((n, t) => n + Math.max(1, t.length), 0);
    let used = 0;
    for (const t of toks) {
      const start = from + (span * used) / total;
      used += Math.max(1, t.length);
      words.push({ text: t, start, end: from + (span * used) / total });
    }
    lastEnd = cue.end;
  }
  return { words, segments };
}
