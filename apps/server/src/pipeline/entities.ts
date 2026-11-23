/**
 * Entity-aware transcription.
 *  1. Pull proper nouns out of the video's metadata (channel, title, description, tags, chapters) and
 *     anything the user typed into "vocabulary".
 *  2. Hand them to the transcriber as vocabulary hints (every vendor has a knob for this).
 *  3. After transcription, find words that sound like an entity and let the language model confirm
 *     the substitution in context. Replacements are constrained to those candidates, so the model
 *     cannot rewrite the transcript, and timestamps are preserved.
 */
import { generateText, Output, type LanguageModel } from "ai";
import { abortOpt, callSignal } from "./steps.js";
import { z } from "zod";
import type { Word, TranscriptFlag } from "@reelsaw/shared";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Logger } from "../log.js";

const STOP = new Set(
  "the a an and or but if then so of to in on at by for with from as is are was were be been this that these those it its i you he she we they my your our their me him her us them what which who whom how when where why not no yes do does did have has had will would can could should may might must new video today welcome back channel subscribe like comment share episode part here there now just really very also only even still more most many much some any every each all both few other another such own same into over under again further once before after above below up down out off than too very".split(
    /\s+/,
  ),
);

/**
 * Everyday English comes from SCOWL (`wordlist-english`), not from a list typed here: an open vocabulary
 * typed by hand is never finished (docs/PRINCIPLES.md, "Vocabularies come from data"). Sizes 10-50 are the words
 * a standard dictionary has, inflections and casual spellings ("noticing", "heard", "gonna", "okay") included;
 * 55-70 add rare words, where a name is likelier than a word. Entries with a capital are SCOWL's names and
 * acronyms, and stay out. Loaded on first use: most processes never correct a transcript.
 */
const SCOWL_SIZES = [10, 20, 35, 40, 50] as const;
const SCOWL_DIALECTS = ["english", "american", "british", "canadian", "australian"] as const;
let everyday: Set<string> | null = null;
function everydayWords(): Set<string> {
  if (everyday) return everyday;
  const require = createRequire(import.meta.url);
  const out = new Set<string>();
  for (const dialect of SCOWL_DIALECTS)
    for (const size of SCOWL_SIZES)
      for (const w of require(`wordlist-english/${dialect}-words-${size}.json`) as string[]) if (w === w.toLowerCase()) out.add(norm(w));
  everyday = out;
  return out;
}

/** "Michelle's" → "Michelle": the possessive of a name is still that name. */
function stripPossessive(w: string): string {
  return w.replace(/[’‘`]/g, "'").replace(/'s?$/i, "");
}

/**
 * English contraction endings. A closed set fixed by the grammar, so it lives in code: "don't" is "do", "you're" is
 * "you", "can't" is "can". A name's possessive ("Ludwig's") stays a name. SCOWL lists no contractions.
 */
const CONTRACTION = /^(.+?)(n't|'re|'s|'ll|'ve|'d|'m)$/;
const NT_STEM: Record<string, string> = { ca: "can", wo: "will", sha: "shall", ai: "be" };

/**
 * Everyday English, the contractions a transcript is full of included. Anything this misses can be replaced by an
 * entity fix without review, so it errs towards "common": a dictionary word that is also a name ("Amber") waits
 * for review rather than changing on its own.
 */
export function isCommonWord(w: string): boolean {
  const lower = w
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
  const c = CONTRACTION.exec(lower);
  if (c) return isCommonWord(NT_STEM[c[1]!] ?? c[1]!);
  const n = norm(lower);
  return !!n && (STOP.has(n) || everydayWords().has(n));
}

export interface SourceMetaLike {
  title?: unknown;
  uploader?: unknown;
  description?: unknown;
  tags?: unknown;
  chapters?: unknown;
}

function cleanToken(t: string) {
  return t.replace(/^[^A-Za-z0-9@#]+|[^A-Za-z0-9]+$/g, "");
}

/** Proper-noun-ish phrases from free text: runs of Capitalized tokens, @handles, #tags, CamelCase, dotted names. */
export function entitiesFromText(input: string): string[] {
  const text = input.replace(/https?:\/\/\S+|\b[\w.-]+\.(com|io|app|ai|net|org|co|dev|me|tv)(\/\S*)?/gi, " "); // URLs and bare domains are not names
  const out = new Set<string>();
  // capitalized tokens seen mid-sentence anywhere in the text: evidence that a word is a name, not just sentence case
  const midSentence = new Set<string>();
  for (const line of text.split(/\n+/)) {
    const raw = line.split(/\s+/).filter(Boolean);
    raw.forEach((t, i) => {
      const prev = raw[i - 1];
      const startsSentence = i === 0 || /[.!?:]$/.test(prev ?? "");
      const c = cleanToken(t);
      if (!startsSentence && /^[A-Z][a-zA-Z0-9'’.-]*$/.test(c)) midSentence.add(c.toLowerCase());
    });
  }
  for (const line of text.split(/\n+/)) {
    const raw = line.split(/\s+/).filter(Boolean);
    let run: string[] = [];
    let runStartsSentence = false;
    const flush = () => {
      if (run.length) {
        // drop a sentence-initial first token unless it is also capitalized mid-sentence elsewhere ("Copia does…" / "…with Copia")
        if (runStartsSentence && !midSentence.has(run[0]!.toLowerCase())) run = run.slice(1);
        const phrase = run.join(" ");
        if (run.length && !(run.length === 1 && STOP.has(phrase.toLowerCase()))) out.add(phrase);
      }
      run = [];
    };
    raw.forEach((rt, i) => {
      const t = cleanToken(rt);
      if (!t) return flush();
      const prev = raw[i - 1];
      const startsSentence = i === 0 || /[.!?:]$/.test(prev ?? "");
      const capital = /^[A-Z][a-zA-Z0-9'’.-]*$/.test(t);
      const camel = /^[a-z]+[A-Z][A-Za-z0-9]*$/.test(t) || /^[A-Za-z0-9]+[.-][A-Za-z][A-Za-z0-9.-]*$/.test(t);
      const tagged = /^[@#][A-Za-z0-9_]{2,}$/.test(t);
      if (tagged || camel) {
        flush();
        out.add(t.replace(/^[@#]/, ""));
        return;
      }
      if (capital && !STOP.has(t.toLowerCase())) {
        if (!run.length) runStartsSentence = startsSentence;
        run.push(t);
      } else flush();
      if (/[.!?]$/.test(rt)) flush(); // sentence ended inside the run
    });
    flush();
  }
  return [...out]
    .filter((e) => e.length >= 3 && e.length <= 40)
    .filter((e) => !GENERIC_LEAD.has(e.split(/\s+/)[0]!.toLowerCase()) || e.split(/\s+/).length > 2);
}

/** Capitalized phrases that start with these are marketing copy, not names ("Try Copia", "Get started"). */
const GENERIC_LEAD = new Set(
  "try get use watch subscribe join learn start check download visit follow click see read listen buy sign find free new how why what".split(" "),
);

export function extractEntities(meta: SourceMetaLike | null | undefined, vocabulary?: string): string[] {
  const out = new Set<string>();
  for (const v of (vocabulary ?? "").split(/[,;\n]+/)) if (v.trim()) out.add(v.trim());
  if (typeof meta?.uploader === "string") out.add(meta.uploader.trim());
  const text = [meta?.title, meta?.description, ...(Array.isArray(meta?.tags) ? meta.tags : []), ...(Array.isArray(meta?.chapters) ? meta.chapters : [])]
    .filter((x): x is string => typeof x === "string")
    .join("\n");
  for (const e of entitiesFromText(text)) out.add(e);
  // dedupe case-insensitively, keep the first spelling, cap the list
  const seen = new Set<string>();
  return [...out]
    .filter((e) => {
      const k = e.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 60);
}

/** Vendor-specific vocabulary hint options keyed by provider id. */
export function biasProviderOptions(provider: string, entities: string[]): Record<string, unknown> {
  if (!entities.length) return {};
  const list = entities.join(", ");
  switch (provider) {
    case "openai":
    case "groq":
      // Whisper's initial prompt steers spelling; keep it short and name-dense
      return { prompt: `Names and terms in this recording: ${list}.` };
    case "deepgram":
      return { keyterm: entities.slice(0, 50).join(" ") };
    case "assemblyai":
      return { wordBoost: entities.slice(0, 50) };
    default:
      return {};
  }
}

// ---------- correction pass ----------

const properNounSchema = z.object({ names: z.array(z.string()) });

/**
 * Keep only entities that are actual names (people, brands, products, places, jargon with a fixed
 * spelling). Generic hashtags like "Budgeting" or "PersonalFinance" would otherwise trigger
 * corrections of ordinary words.
 */
export async function filterProperNouns(
  model: LanguageModel,
  entities: string[],
  context: { title?: string; uploader?: string | undefined },
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<string[]> {
  if (!entities.length) return [];
  try {
    const { output } = await generateText({
      model,
      temperature: 0,
      maxRetries: 1,
      ...abortOpt(callSignal(signal, timeoutMs)),
      output: Output.object({ schema: properNounSchema, name: "names" }),
      telemetry: { functionId: "transcribe.entity-names", recordInputs: false, recordOutputs: false },
      prompt: `From the list below, return only the items that are proper nouns or fixed-spelling terms a transcriber might misspell: people, companies, brands, products, places, software names, acronyms.
Drop generic topics, hashtags made of ordinary words, and plain English words or phrases.
${context.title ? `Video: "${context.title}"` : ""}${context.uploader ? ` by ${context.uploader}` : ""}

List: ${entities.join(" | ")}

Respond with JSON {"names":[...]} using the exact spellings from the list.`,
    });
    const keep = new Set(output.names.map((n) => n.toLowerCase()));
    const kept = entities.filter((e) => keep.has(e.toLowerCase()));
    return kept.length ? kept : entities.filter((e) => !isCommonWord(e));
  } catch {
    return entities.filter((e) => !isCommonWord(e));
  }
}

/** Letters and digits of any script, lowercased and without diacritics ("Zoë" matches "Zoe"). */
export function norm(s: string) {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

/** Rough "sounds alike" score in [0,1]: edit distance on a consonant skeleton plus plain similarity. */
export function similarity(a: string, b: string): number {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const plain = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
  const skel = (s: string) => s.replace(/[aeiouy]/g, "").replace(/(.)\1+/g, "$1");
  const sa = skel(na);
  const sb = skel(nb);
  const cons = sa && sb ? 1 - levenshtein(sa, sb) / Math.max(sa.length, sb.length) : 0;
  const prefix = na[0] === nb[0] ? 0.1 : 0;
  return Math.min(1, Math.max(plain, cons * 0.9) + prefix);
}

/**
 * Metaphone key (Lawrence Philips, 1990; the closed rule set, so it lives in code): how an English spelling sounds,
 * as consonant classes ("Monica" and "Monicah" → MNK, "stuff" and "Stav" → STF, "stop" STP vs "Steam" STM).
 * Vowels count only at the start, written "A".
 */
export function metaphone(input: string): string {
  const w = norm(input).replace(/[^a-z]/g, "");
  if (!w) return "";
  let s = w;
  if (/^(kn|gn|pn|ae|wr)/.test(s)) s = s.slice(1);
  if (s[0] === "x") s = `s${s.slice(1)}`;
  if (s.startsWith("wh")) s = `w${s.slice(2)}`;
  const isIn = (set: string, c: string | undefined) => !!c && set.includes(c);
  const V = (c: string | undefined) => isIn("aeiou", c);
  let out = "";
  for (const [i, c] of [...s].entries()) {
    const n = s[i + 1];
    const p = s[i - 1];
    if (c === p && c !== "c") continue;
    switch (c) {
      case "a":
      case "e":
      case "i":
      case "o":
      case "u":
        if (i === 0) out += "A";
        break;
      case "b":
        if (!(p === "m" && i === s.length - 1)) out += "B";
        break;
      case "c":
        if (n === "i" && s[i + 2] === "a") out += "X";
        else if (n === "h") out += p === "s" ? "K" : "X";
        else if (n === "i" || n === "e" || n === "y") {
          if (p !== "s") out += "S";
        } else out += "K";
        break;
      case "d":
        out += n === "g" && isIn("eiy", s[i + 2]) ? "J" : "T";
        break;
      case "g":
        if (n === "h" && i + 2 < s.length && !V(s[i + 2])) break; // "night"
        if (n === "n" && (i + 2 === s.length || s.slice(i + 2) === "ed")) break; // "sign", "signed"
        if (p === "d" && isIn("eiy", n)) break; // "dge": the d already said J
        out += isIn("eiy", n) ? "J" : "K";
        break;
      case "h":
        if (V(n) && !isIn("csptg", p)) out += "H";
        break;
      case "k":
        if (p !== "c") out += "K";
        break;
      case "p":
        out += n === "h" ? "F" : "P";
        break;
      case "q":
        out += "K";
        break;
      case "s":
        out += n === "h" || (n === "i" && (s[i + 2] === "o" || s[i + 2] === "a")) ? "X" : "S";
        break;
      case "t":
        if (n === "i" && (s[i + 2] === "o" || s[i + 2] === "a")) out += "X";
        else if (n === "h") out += "0";
        else if (!(n === "c" && s[i + 2] === "h")) out += "T";
        break;
      case "v":
        out += "F";
        break;
      case "w":
      case "y":
        if (V(n)) out += c.toUpperCase();
        break;
      case "x":
        out += "KS";
        break;
      case "z":
        out += "S";
        break;
      default:
        out += c.toUpperCase(); // f j l m n r
    }
  }
  return out.replace(/(.)\1+/g, "$1");
}

/**
 * An entity the correction pass may write into the transcript. The rest still steer the transcriber as vocabulary hints
 * but never replace what it heard:
 * - made only of everyday words ("Steam", "Server", "Discord", "God", "DOUBLE KILL", "Product School", "ProductManager"):
 *   a transcriber that hears the word writes it, so a "fix" would swap a different word in ("stop" → "Steam");
 * - letters and digits mixed ("b3d", "fnaf1", "BCON25"): handles and tags, not how anyone says the name;
 * - a capitalized run with no vowel ("GCMX"): spelled out letter by letter, never misheard as a word.
 */
export function isCorrectable(entity: string): boolean {
  const tokens = entity
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter(Boolean);
  if (!tokens.length) return false;
  if (tokens.some((t) => /\p{L}/u.test(t) && /\p{N}/u.test(t))) return false;
  if (tokens.every((t) => /^[A-Z]{2,}$/.test(t) && !/[AEIOUY]/.test(t))) return false;
  return !tokens.every((t) => isCommonWord(t));
}

/**
 * The transcriber wrote a capitalized word mid-sentence: it heard a name ("Rachel", "Texas"), so it is a real word too.
 * SCOWL's package lists no names, and the transcriber's own capital is the better evidence anyway.
 */
function heardAsName(token: string, prev: string | undefined): boolean {
  return /^\p{Lu}\p{Ll}/u.test(token) && prev !== undefined && !/[.!?]["')\]]*$/.test(prev);
}

/** A heard token that is a web address or handle ("aura.com", "Blender.org,", "@reelsaw"): said as written, not misheard. */
const ADDRESS = /^@|\p{L}\.\p{L}{2,}/u;

export interface Candidate {
  id: number;
  wordIndex: number; // first word index in `words`
  span: number; // how many words
  heard: string;
  entity: string;
  score: number;
  context: string;
  /**
   * The heard words are everyday English, or the heard text and the name contain one another ("ever" / "Server",
   * "Monica" / "Monicah"). Such a span is offered only when it sounds the same as the name, needs a sure model, and is
   * never applied without review.
   */
  realWord: boolean;
}

/** The key a rejected fix is remembered by: what was heard and what was proposed, spelling-insensitive. */
export function fixPairKey(heard: string, suggested: string): string {
  return `${norm(heard)}→${norm(suggested)}`;
}

/** Find transcript spans that sound like an entity but are not spelled like it. */
export function findCandidates(words: Word[], entities: string[], threshold = 0.62, opts: { rejected?: ReadonlySet<string> | undefined } = {}): Candidate[] {
  const out: Candidate[] = [];
  const correctable = entities.filter(isCorrectable);
  const ents = correctable.map((e) => ({ e, tokens: e.split(/\s+/).length, n: norm(e), key: metaphone(e) }));
  const entityNorms = new Set(entities.map(norm));
  let id = 0;
  for (let i = 0; i < words.length; i++) {
    for (const { e, tokens, n: en, key } of ents) {
      for (const span of new Set([tokens, Math.max(1, tokens - 1), tokens + 1])) {
        if (i + span > words.length) continue;
        const raw = words.slice(i, i + span).map((w) => w.text);
        const prev = words[i - 1]?.text;
        if (raw.some((t) => ADDRESS.test(t))) continue; // "aura.com", "Blender.org": the address as said
        const heard = raw.join(" ");
        const hn = norm(raw.map(stripPossessive).join(" "));
        if (!hn || hn === en) continue; // already right, possessive included ("Michelle's")
        if (entityNorms.has(hn)) continue; // already spelled like another known name (Copia vs copiacash)
        if (opts.rejected?.has(fixPairKey(heard, e))) continue; // the user said no to this exact fix before
        const heardTokens = raw.map((t) => norm(stripPossessive(t)));
        if (heardTokens.every((t) => STOP.has(t))) continue; // "a day" is never a name
        const entityTokens = e.toLowerCase().split(/\s+/).map(norm);
        if (heardTokens.some((t) => entityTokens.includes(t))) continue; // already contains the name
        const s = similarity(heard, e);
        if (s < (span > 1 ? Math.max(threshold, 0.72) : threshold)) continue;
        // skip when the heard text is a common word and the entity is short (e.g. "see" vs "Seen")
        if (span === 1 && STOP.has(norm(heard)) && norm(e).length <= 4) continue;
        // A real word is what the speaker most likely said: offer the name only when it sounds the same
        // ("Monica" → "Monicah", "stuff" → "Stav"), never on a loose look-alike ("stop" → "Steam", "Rachel" → "Michelle",
        // "Texas" → "Texan", "ever" → "Server"). A non-word ("Zorvacks", "Lashkarlands") is a transcriber's guess.
        // A name the transcriber already capitalized ("Rachel", "Texas", "Zorvacks") gets the same sound test but may still
        // apply on its own: a misheard name is often written as a name.
        const realWord = raw.every((t) => isCommonWord(t)) || hn.includes(en) || en.includes(hn);
        const asName = raw.every((t, k) => isCommonWord(t) || heardAsName(t, k ? raw[k - 1] : prev));
        if ((realWord || asName) && metaphone(raw.join("")) !== key) continue;
        const context = words
          .slice(Math.max(0, i - 6), Math.min(words.length, i + span + 6))
          .map((w, k) => (k === Math.min(6, i) ? `[[${w.text}` : k === Math.min(6, i) + span - 1 ? `${w.text}]]` : w.text))
          .join(" ")
          .replace(/\[\[([^\]]*)\]\]/, "[[$1]]");
        out.push({ id: id++, wordIndex: i, span, heard, entity: e, score: Number(s.toFixed(2)), context, realWord });
      }
    }
  }
  // one candidate per start position: keep the best-scoring entity
  const best = new Map<number, Candidate>();
  for (const c of out) {
    const prev = best.get(c.wordIndex);
    if (!prev || c.score > prev.score) best.set(c.wordIndex, c);
  }
  return [...best.values()].slice(0, 80);
}

/** Below this a fix over a real word is noise in the review list (the live model rated "stuff" → "Stav" 0.6). */
const REAL_WORD_MIN_CONFIDENCE = 0.8;

const decisionSchema = z.object({
  decisions: z.array(
    z.object({
      id: z.number(),
      replace: z.boolean(),
      confidence: z.number().min(0).max(1).describe("How sure you are that the speaker said the proposed term, 0-1"),
    }),
  ),
});

export interface CorrectionResult {
  words: Word[];
  rawWords: Word[];
  flags: TranscriptFlag[];
  applied: Array<{ heard: string; entity: string; at: number }>;
  candidates: number;
  /** every candidate and what happened to it (stage artifact for diagnosis / reports) */
  trace?: {
    entities: string[];
    candidates: Array<{ wordIndex: number; heard: string; proposed: string; replace?: boolean; confidence?: number; outcome: string }>;
  };
}

/** Rebuild the corrected word list from the as-heard words plus every auto/accepted flag. */
/** Replacement text → one caption word per token, the span's time shared out by token length. */
function spreadWords(text: string, start: number, end: number): Word[] {
  const toks = text.split(/\s+/).filter(Boolean);
  if (toks.length <= 1) return [{ text, start, end }];
  const total = toks.reduce((a, t) => a + t.length + 1, 0);
  const out: Word[] = [];
  let t = start;
  for (const [k, tok] of toks.entries()) {
    const e = k === toks.length - 1 ? end : t + ((end - start) * (tok.length + 1)) / total;
    out.push({ text: tok, start: Number(t.toFixed(3)), end: Number(e.toFixed(3)) });
    t = e;
  }
  return out;
}

export function applyFlags(rawWords: Word[], flags: TranscriptFlag[]): Word[] {
  const active = flags.filter((f) => f.status === "auto" || f.status === "accepted").sort((a, b) => a.wordIndex - b.wordIndex);
  const out: Word[] = [];
  let i = 0;
  let fi = 0;
  while (i < rawWords.length) {
    while (active[fi] && active[fi]!.wordIndex < i) fi++;
    const f = active[fi];
    if (f && f.wordIndex === i) {
      const first = rawWords[i]!;
      const last = rawWords[Math.min(rawWords.length - 1, i + f.span - 1)]!;
      if (f.kind === "loop") {
        // rawWords still has the full run; keep the short copy (or a typed caption across the hole)
        const text = (f.replacement ?? "").trim();
        const keepN = f.suggested.trim().split(/\s+/).filter(Boolean).length;
        if (text && text !== f.suggested.trim()) {
          out.push(...spreadWords(text, first.start, Math.max(last.end, f.end)));
        } else {
          for (let k = 0; k < keepN && i + k < rawWords.length; k++) out.push(rawWords[i + k]!);
        }
        i += f.span;
        fi++;
        continue;
      }
      // manual corrections are typed with their own punctuation; detector fixes inherit the sentence's
      const trailing = f.subkind === "manual" ? "" : (/[.,!?;:]$/.exec(last.text)?.[0] ?? "");
      const text = f.replacement ?? f.suggested;
      if (text.trim()) out.push(...spreadWords(text.trim() + (trailing && !/[.,!?;:]$/.test(text.trim()) ? trailing : ""), first.start, last.end));
      else if (trailing && out.length) out[out.length - 1] = { ...out[out.length - 1]!, text: out[out.length - 1]!.text.replace(/[.,!?;:]$/, "") + trailing }; // deletion: keep the sentence punctuation
      i += f.span;
      fi++;
    } else {
      out.push(rawWords[i]!);
      i++;
    }
  }
  return out;
}

/**
 * Ask the language model which candidate substitutions are right, then apply them. Multi-word
 * spans collapse into one word carrying the first start and last end time.
 */
export async function correctTranscript(
  model: LanguageModel,
  words: Word[],
  entities: string[],
  context: { title?: string; uploader?: string | undefined },
  opts: {
    signal?: AbortSignal /** limit on each model call, ms */;
    timeoutMs?: number;
    telemetry?: boolean;
    autoConfidence?: number;
    minFlagConfidence?: number;
    /** fixes this user rejected before, as `fixPairKey(heard, suggested)`: never proposed again */
    rejected?: ReadonlySet<string>;
    log?: Logger;
  } = {},
): Promise<CorrectionResult> {
  const autoConfidence = opts.autoConfidence ?? 0.85;
  const minFlagConfidence = opts.minFlagConfidence ?? 0.4;
  entities = await filterProperNouns(model, entities.filter(isCorrectable), context, opts.signal, opts.timeoutMs);
  const candidates = findCandidates(words, entities, undefined, { rejected: opts.rejected });
  const trace: NonNullable<CorrectionResult["trace"]> = {
    entities,
    candidates: candidates.map((c) => ({ wordIndex: c.wordIndex, heard: c.heard, proposed: c.entity, outcome: "model failed" })),
  };
  const none = { words, rawWords: words, flags: [], applied: [], candidates: candidates.length, trace };
  if (!candidates.length) return none;

  const prompt = `You are reviewing speech-to-text errors in a transcript${context.title ? ` of the video "${context.title}"` : ""}${context.uploader ? ` by ${context.uploader}` : ""}.
Known names and terms that appear in this video: ${entities.join(", ")}.

For each candidate below, the transcriber heard the text in [[double brackets]]. Decide whether the speaker actually said the proposed name/term instead.
- replace=true only when the context makes the proposed term clearly more plausible than what was heard.
- If the heard text is an ordinary word or name that makes sense in its sentence, the speaker most likely said it: replace=false.
- The proposed term must fit the sentence as a name: "stop following me" is never "Steam following me".
- confidence is your probability (0-1) that the proposed term is what was said. Be calibrated: common words that merely sound similar deserve low confidence.

Candidates:
${candidates.map((c) => `#${c.id}: heard "${c.heard}" → proposed "${c.entity}" | context: …${c.context}…`).join("\n")}

Respond with JSON: {"decisions":[{"id":0,"replace":true,"confidence":0.9}, ...]} covering every candidate id.`;

  let decisions: Array<{ id: number; replace: boolean; confidence: number }> = [];
  try {
    const { output } = await generateText({
      model,
      prompt,
      temperature: 0,
      maxRetries: 2,
      ...abortOpt(callSignal(opts.signal, opts.timeoutMs)),
      output: Output.object({ schema: decisionSchema, name: "decisions" }),
      telemetry: { isEnabled: opts.telemetry ?? false, functionId: "transcribe.correct-entities", recordInputs: false, recordOutputs: false },
    });
    decisions = output.decisions;
  } catch (err) {
    opts.log?.warn({ err }, "entity correction pass failed, keeping transcript as heard");
    return none;
  }
  const byId = new Map(decisions.map((d) => [d.id, d]));
  // a real word that sounds like the name is still most likely the word: show it only when the model is sure
  const floor = (c: Candidate) => (c.realWord ? Math.max(minFlagConfidence, REAL_WORD_MIN_CONFIDENCE) : minFlagConfidence);
  const flags: TranscriptFlag[] = [];
  let lastEnd = -1;
  const traced = new Map(candidates.map((c, i) => [c, trace.candidates[i]!]));
  for (const c of candidates.sort((a, b) => a.wordIndex - b.wordIndex)) {
    const d = byId.get(c.id);
    const tr = traced.get(c)!;
    Object.assign(tr, {
      replace: d?.replace,
      confidence: d?.confidence,
      outcome: !d ? "no decision" : !d.replace ? "kept as heard" : d.confidence < floor(c) ? "low confidence" : "flagged",
    });
    if (!d?.replace || d.confidence < floor(c)) continue;
    if (c.wordIndex < lastEnd) {
      tr.outcome = "overlaps an earlier fix";
      continue; // overlapping candidate
    }
    lastEnd = c.wordIndex + c.span;
    flags.push({
      id: randomUUID(),
      kind: "entity",
      wordIndex: c.wordIndex,
      span: c.span,
      start: words[c.wordIndex]!.start,
      end: words[Math.min(words.length - 1, c.wordIndex + c.span - 1)]!.end,
      heard: c.heard,
      suggested: c.entity,
      confidence: Number(d.confidence.toFixed(2)),
      // replacing a real word is never automatic, however confident the model is
      status: d.confidence >= autoConfidence && !c.realWord && !c.heard.split(/\s+/).some((t) => isCommonWord(t)) ? "auto" : "pending",
    });
  }
  const applied = flags.filter((f) => f.status === "auto").map((f) => ({ heard: f.heard, entity: f.suggested, at: f.start }));
  for (const f of flags) for (const tr of trace.candidates) if (tr.wordIndex === f.wordIndex && tr.outcome === "flagged") tr.outcome = f.status;
  return { words: applyFlags(words, flags), rawWords: words, flags, applied, candidates: candidates.length, trace };
}
