/**
 * One place for comparing words that were *heard* with words that were *expected* (the seam
 * verifier, caption-to-audio matching, eval grading). Recognisers disagree with transcripts about
 * form, not content: "seven" vs "7", "Don't" vs "dont", "Twenty-one" vs "21", curly vs straight
 * apostrophes. Everything is reduced to a canonical token so those never count as a mismatch.
 */

const UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const UNIT_VALUE = new Map(UNITS.map((w, i) => [w, i] as const));
const TENS_VALUE = new Map(TENS.flatMap((w, i) => (w ? [[w, i * 10] as const] : [])));

/** Lower-case, curly apostrophes straightened, only letters and digits kept ("don't" = "dont"). */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, "")
    .replace(/'/g, "");
}

/** The canonical form of one word: digits for a single number word ("seven" → "7"), plain text otherwise. */
export function normalizeToken(text: string): string {
  const p = plain(text);
  const u = UNIT_VALUE.get(p);
  if (u !== undefined) return String(u);
  const t = TENS_VALUE.get(p);
  if (t !== undefined) return String(t);
  if (p === "hundred") return "100";
  if (p === "thousand") return "1000";
  return p;
}

/** Folds a run of number words ("twenty one", "two hundred", "one thousand five hundred") into one number. */
function numberRun(words: string[], from: number): { value: number; len: number } | null {
  let total = 0;
  let cur = 0;
  let len = 0;
  let thousands = false;
  for (let i = from; i < words.length; i++) {
    const w = plain(words[i]!);
    const unit = UNIT_VALUE.get(w);
    const tens = TENS_VALUE.get(w);
    if (unit !== undefined) {
      // a unit starts a number, or follows tens ("twenty one") or hundred ("two hundred five")
      const afterTens = cur % 100 >= 20 && cur % 10 === 0;
      const afterHundred = cur > 0 && cur % 100 === 0;
      const fresh = len === 0 || (thousands && cur === 0);
      if (!fresh && !((afterTens || afterHundred) && unit > 0 && unit < 10)) break;
      cur += unit;
    } else if (tens !== undefined) {
      if (!(len === 0 || (thousands && cur === 0)) && cur % 100 !== 0) break;
      cur += tens;
    } else if (w === "hundred") {
      if (len === 0 || cur === 0 || cur >= 100 || cur % 100 === 0) break;
      cur *= 100;
    } else if (w === "thousand") {
      if (thousands || len === 0) break;
      total += cur * 1000;
      cur = 0;
      thousands = true;
    } else break;
    len++;
  }
  return len ? { value: total + cur, len } : null;
}

export interface NormalizedToken {
  token: string;
  /** index of the first source word this token came from, and how many source words it covers */
  from: number;
  count: number;
}

/**
 * Canonical tokens for a list of words, keeping track of which source words each came from (a
 * spoken "twenty one" and a written "21" are both one token). Words that normalise to nothing
 * (pure punctuation) are dropped.
 */
export function normalizeWithSpans(words: string[]): NormalizedToken[] {
  const out: NormalizedToken[] = [];
  // split hyphenated source words first so "twenty-one" is two number words
  const flat: Array<{ text: string; src: number }> = [];
  words.forEach((w, src) => {
    for (const part of w.split(/[-–—\s]+/).filter(Boolean)) flat.push({ text: part, src });
  });
  const texts = flat.map((f) => f.text);
  for (let i = 0; i < flat.length; ) {
    const run = numberRun(texts, i);
    if (run && run.len > 1) {
      const from = flat[i]!.src;
      out.push({ token: String(run.value), from, count: flat[i + run.len - 1]!.src - from + 1 });
      i += run.len;
      continue;
    }
    const token = normalizeToken(flat[i]!.text);
    if (token) out.push({ token, from: flat[i]!.src, count: 1 });
    i++;
  }
  return out;
}

/** Canonical tokens for a list of words (see {@link normalizeWithSpans}). */
export function normalizeTokens(words: string[]): string[] {
  return normalizeWithSpans(words).map((t) => t.token);
}

/** Are two words the same word once form differences are ignored? */
export function sameWord(a: string, b: string): boolean {
  return normalizeToken(a) === normalizeToken(b);
}
