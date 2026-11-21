/**
 * What a language's writing needs, from the platform's Unicode data rather than lists typed here: one answer every
 * stage reads (the server's capability registry, apps/server/src/pipeline/language.ts) instead of each one assuming
 * Latin script and English punctuation.
 *   - script: CLDR's likely subtags (`Intl.Locale#maximize`): "hi" → Deva, "ja" → Jpan, "ar" → Arab;
 *   - direction: `Intl.Locale#getTextInfo` (CLDR layout data, also generated into LANGUAGE_DATA for runtimes
 *     without it);
 *   - letters and sentence-ending punctuation: CLDR's exemplar characters (language-data.ts, generated from the
 *     pinned `cldr-misc-full`); a language CLDR has no characters for borrows those of its script's main language
 *     (`und-Latn` → English), so it is still checked against its script;
 *   - case: whether any of its letters has an upper-case form (Hindi, Arabic, Thai, Japanese: none);
 *   - word and sentence segmentation: `Intl.Segmenter`.
 */
import { LANGUAGE_DATA } from "./language-data.js";

export interface LanguageProfile {
  /** canonical code ("hi") */
  code: string;
  /** ISO 15924 script ("Deva"); undefined when CLDR does not know the language */
  script: string | undefined;
  direction: "ltr" | "rtl";
  /** has upper and lower case, so an upper-cased hook means something */
  cased: boolean;
  /** words are separated by spaces (not Chinese, Japanese, Thai, Lao, Khmer, Burmese, Tibetan, …) */
  spaced: boolean;
  /** the letters and marks the language is written with (CLDR main exemplars) */
  letters: string;
  /** whose CLDR characters `letters` are: the language's own, or its script's main language's when CLDR has none */
  lettersFrom: string;
  /** the punctuation that ends a sentence in it ("।" in Hindi, "。" in Japanese, "؟" in Arabic) */
  terminals: string;
  /** a line of its own text to draw: its name for itself and its letters */
  sample: string;
}

/**
 * Scripts written without spaces between words: Unicode gives their characters the line-breaking classes ID
 * (ideographs, kana) or SA (South-East Asian, broken by dictionary) in UAX #14, so a line may break between any two
 * of them, and words are found by a dictionary (`Intl.Segmenter`), never by spaces. Closed: fixed by UAX #14.
 */
const UNSPACED_SCRIPTS = new Set([
  "Hani",
  "Hans",
  "Hant",
  "Hira",
  "Kana",
  "Jpan",
  "Thai",
  "Laoo",
  "Khmr",
  "Mymr",
  "Tibt",
  "Lana",
  "Tale",
  "Talu",
  "Tavt",
  "Yiii",
]);

function scriptOf(code: string): string | undefined {
  try {
    const s = new Intl.Locale(code).maximize().script;
    return s && s !== "Zzzz" ? s : undefined;
  } catch {
    return undefined;
  }
}

function textDirection(code: string): "ltr" | "rtl" | undefined {
  try {
    const l = new Intl.Locale(code) as Intl.Locale & { getTextInfo?: () => { direction?: string }; textInfo?: { direction?: string } };
    const d = (l.getTextInfo?.() ?? l.textInfo)?.direction;
    return d === "rtl" || d === "ltr" ? d : undefined;
  } catch {
    return undefined;
  }
}

/** The language whose CLDR characters stand in for `code`'s: its own, else its script's main language's. */
function dataSource(code: string, script: string | undefined): string | undefined {
  if (LANGUAGE_DATA[code]) return code;
  if (!script) return undefined;
  try {
    const main = new Intl.Locale(`und-${script}`).maximize().language;
    return LANGUAGE_DATA[main] ? main : undefined;
  } catch {
    return undefined;
  }
}

function autonym(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: "language", fallback: "none" }).of(code) ?? "";
  } catch {
    return "";
  }
}

const cache = new Map<string, LanguageProfile>();

/** The profile of a canonical language code (spokenLanguageCode gives one). Pure apart from a cache. */
export function languageProfile(code: string): LanguageProfile {
  const hit = cache.get(code);
  if (hit) return hit;
  const script = scriptOf(code);
  const from = dataSource(code, script);
  const data = from ? LANGUAGE_DATA[from] : undefined;
  const letters = data?.letters ?? "";
  const direction = textDirection(code) ?? (data?.rtl ? "rtl" : "ltr");
  const cased = [...letters].some((c) => c.toLocaleUpperCase(code) !== c || c.toLocaleLowerCase(code) !== c);
  const name = autonym(code);
  const profile: LanguageProfile = {
    code,
    script,
    direction,
    cased,
    spaced: !script || !UNSPACED_SCRIPTS.has(script),
    letters,
    lettersFrom: from ?? code,
    // a language CLDR knows nothing about still ends sentences somewhere: Unicode's terminals stand in (endsSentence)
    terminals: data?.terminals ?? "",
    sample: [name, letters].filter(Boolean).join(" "),
  };
  cache.set(code, profile);
  return profile;
}

/** What separates two words in running text: a space, or nothing for scripts written without them. */
export const wordJoiner = (lang: string | null | undefined) => (lang && !languageProfile(lang).spaced ? "" : " ");

/** Words as running text in their language ("今日 は" → "今日は"); spaces for an unknown language. */
export function joinWords(texts: readonly string[], lang: string | null | undefined): string {
  return texts.join(wordJoiner(lang));
}

/** Upper case as the language writes it (Turkish "i" → "İ"); unchanged for a script without case. */
export function upperCase(text: string, lang: string | null | undefined): string {
  if (!lang) return text.toUpperCase();
  return languageProfile(lang).cased ? text.toLocaleUpperCase(lang) : text;
}

/**
 * Ends a sentence: Unicode's Sentence_Terminal ("." "?" "!" "।" "。" "؟" "။" …) before any closing quotes and
 * brackets. The property, not a typed list, so every script's full stop counts.
 */
const TERMINAL = /\p{Sentence_Terminal}[\p{Pe}\p{Pf}"'’”]*$/u;
export const endsSentence = (text: string) => TERMINAL.test(text);
/** Ends a clause: Unicode's Terminal_Punctuation that does not end a sentence ("," ";" ":" "،" "、" "，"). */
const CLAUSE = /(?!\p{Sentence_Terminal})\p{Terminal_Punctuation}[\p{Pe}\p{Pf}"'’”]*$/u;
export const endsClause = (text: string) => CLAUSE.test(text);

/**
 * How wide text sets, in Latin-letter units: ideographs, kana and hangul are full width (2), combining marks
 * (Devanagari vowel signs, Arabic harakat) sit on the letter before them (0). From Unicode properties.
 */
const WIDE = /[\p{Unified_Ideograph}\p{scx=Hira}\p{scx=Kana}\p{scx=Hang}　-〿！-｠]/u;
export function textWidth(text: string): number {
  let n = 0;
  for (const c of text) n += /\p{M}/u.test(c) ? 0 : WIDE.test(c) ? 2 : 1;
  return n;
}

const segmenters = new Map<string, Intl.Segmenter>();
function segmenter(lang: string, granularity: "word" | "sentence"): Intl.Segmenter {
  const key = `${lang}:${granularity}`;
  let s = segmenters.get(key);
  if (!s) {
    s = new Intl.Segmenter(lang, { granularity });
    segmenters.set(key, s);
  }
  return s;
}

/**
 * Text as words, by the language's own rules (`Intl.Segmenter`: a dictionary for Thai and Japanese, spaces for most
 * others). Punctuation stays on the word before it, as transcripts and subtitles carry it ("बात।", "です。").
 */
export function segmentWords(text: string, lang: string | null | undefined): string[] {
  const out: string[] = [];
  let pending = "";
  let afterSpace = true;
  for (const s of segmenter(lang || "und", "word").segment(text)) {
    if (/^\s+$/u.test(s.segment)) {
      // punctuation between spaces ("a - b") stays on the word before it
      if (pending && out.length) out[out.length - 1] += pending;
      else if (pending) out.push(pending);
      pending = "";
      afterSpace = true;
      continue;
    }
    if (s.isWordLike) {
      out.push(pending + s.segment);
      pending = "";
    } else if (out.length && !afterSpace && !pending && !/^[\p{Ps}\p{Pi}]/u.test(s.segment)) {
      out[out.length - 1] += s.segment;
    } else {
      pending += s.segment; // an opening quote or bracket, or punctuation after a space, goes with the word after it
    }
    afterSpace = false;
  }
  if (pending) out.push(pending);
  return out;
}

/** Sentences of running text by Unicode's sentence rules (`Intl.Segmenter`), each with its end offset. */
export function segmentSentences(text: string, lang: string | null | undefined): Array<{ text: string; end: number }> {
  return [...segmenter(lang || "und", "sentence").segment(text)].map((s) => ({ text: s.segment, end: s.index + s.segment.length }));
}
