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
import { z } from "zod";
import type { Word, TranscriptFlag } from "@reelsaw/shared";
import { randomUUID } from "node:crypto";
import type { Logger } from "../log.js";

const STOP = new Set(
  "the a an and or but if then so of to in on at by for with from as is are was were be been this that these those it its i you he she we they my your our their me him her us them what which who whom how when where why not no yes do does did have has had will would can could should may might must new video today welcome back channel subscribe like comment share episode part here there now just really very also only even still more most many much some any every each all both few other another such own same into over under again further once before after above below up down out off than too very".split(
    /\s+/,
  ),
);

/** Everyday words: a transcriber hearing one of these is usually right, so we never auto-replace them. */
const COMMON = new Set(
  `about above across act add after again against age ago agree air allow almost alone along already also although always among amount animal answer anyone anything appear apply area around arrive art ask away baby back bad bag ball bank base beautiful because become bed before begin behind believe below best better between big bill bird bit black blue board boat body book both bottom box boy break bring brother build business busy buy call came car card care carry case cat catch cause center century certain chair chance change check child choose church city claim class clean clear close coffee cold college color come common company computer consider continue control cost could country couple course court cover create cross cry cut dark data daughter day dead deal death decide deep degree describe design develop die difference different difficult dinner direction discuss doctor dog door double doubt draw dream drive drop during early earth east easy eat economy edge education effect effort eight either else end energy enjoy enough enter entire environment especially even evening event ever every everyone everything evidence exactly example expect experience explain eye face fact fall family far fast father fear feel few field fight figure fill film final finally find fine finish fire firm first fish five floor fly focus follow food foot force forget form forward four free friend front full fund future game garden gas general girl give glass goal good government great green ground group grow guess gun guy hair half hand hang happen happy hard head health hear heart heat heavy help high history hit hold home hope hot hotel hour house huge human hundred husband idea image imagine important improve include increase indeed industry information inside instead interest issue item job join keep key kid kill kind kitchen know land language large last late later laugh law lay lead learn least leave left leg less let letter level lie life light line list listen little live local long look lose lot love low machine main major make man manage market matter maybe mean measure meet member memory mention message middle might million mind minute miss model moment money month morning mother mouth move movie music name nation natural near nearly need network never news next nice night none north note nothing notice number occur offer office often oil old once one open order organization others outside owner page pain paper parent part particular party pass past pay peace people perhaps person phone pick picture piece place plan plant play point police policy political poor popular position possible power practice prepare present president pressure pretty price private probably problem process produce product program project property protect prove provide public pull purpose push put quality question quickly quite race radio raise range rate rather reach read ready real reason receive recent record red reduce region relate remain remember remove report represent require research rest result return reveal rich right rise risk road rock role room rule run safe sale save say scene school science score sea season seat second section security seem sell send sense series serious serve service set seven several shake share shoot short shot show side sign simple simply since sing single sister sit site situation six size skill skin small smile social society soldier somebody someone something sometimes son song soon sort sound source south space speak special speech spend sport spring staff stage stand standard star state statement station stay step stock stop store story strategy street strong structure student study stuff style subject success suddenly suffer suggest summer support sure surface system table take talk task tax teach teacher team technology television tell ten tend term test thank theory thing think third thought thousand threat three throw time tiny today together tonight top total toward town trade traditional training travel treat tree trial trip trouble true truth try turn type under understand unit until upon usually value various view visit voice vote wait walk wall want war watch water way weapon wear week weight west western whatever whether while white whole whose wide wife win wind window wish within without woman wonder word work worker world worry write writer wrong yard year yet young`.split(
    /\s+/,
  ),
);

export function isCommonWord(w: string) {
  const n = norm(w);
  return STOP.has(n) || COMMON.has(n) || COMMON.has(n.replace(/s$/, "")) || COMMON.has(n.replace(/(ed|ing)$/, ""));
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
  return [...out].filter((e) => e.length >= 3 && e.length <= 40).filter((e) => !GENERIC_LEAD.has(e.split(/\s+/)[0]!.toLowerCase()) || e.split(/\s+/).length > 2);
}

/** Capitalized phrases that start with these are marketing copy, not names ("Try Copia", "Get started"). */
const GENERIC_LEAD = new Set("try get use watch subscribe join learn start check download visit follow click see read listen buy sign find free new how why what".split(" "));

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
  return [...out].filter((e) => {
    const k = e.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 60);
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
export async function filterProperNouns(model: LanguageModel, entities: string[], context: { title?: string; uploader?: string }, signal?: AbortSignal): Promise<string[]> {
  if (!entities.length) return [];
  try {
    const { output } = await generateText({
      model,
      temperature: 0,
      maxRetries: 1,
      abortSignal: signal,
      output: Output.object({ schema: properNounSchema, name: "names" }),
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

function norm(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
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

export interface Candidate {
  id: number;
  wordIndex: number; // first word index in `words`
  span: number; // how many words
  heard: string;
  entity: string;
  score: number;
  context: string;
}

/** Find transcript spans that sound like an entity but are not spelled like it. */
export function findCandidates(words: Word[], entities: string[], threshold = 0.62): Candidate[] {
  const out: Candidate[] = [];
  const ents = entities.map((e) => ({ e, tokens: e.split(/\s+/).length }));
  const entityNorms = new Set(entities.map(norm));
  let id = 0;
  for (let i = 0; i < words.length; i++) {
    for (const { e, tokens } of ents) {
      for (const span of new Set([tokens, Math.max(1, tokens - 1), tokens + 1])) {
        if (i + span > words.length) continue;
        const heard = words.slice(i, i + span).map((w) => w.text).join(" ");
        if (norm(heard) === norm(e)) continue; // already right
        if (entityNorms.has(norm(heard))) continue; // already spelled like another known name (Copia vs copiacash)
        const heardTokens = words.slice(i, i + span).map((w) => norm(w.text));
        if (heardTokens.every((t) => STOP.has(t))) continue; // "a day" is never a name
        const entityTokens = e.toLowerCase().split(/\s+/).map(norm);
        if (heardTokens.some((t) => entityTokens.includes(t))) continue; // already contains the name
        const s = similarity(heard, e);
        if (s < (span > 1 ? Math.max(threshold, 0.72) : threshold)) continue;
        // skip when the heard text is a common word and the entity is short (e.g. "see" vs "Seen")
        if (span === 1 && STOP.has(norm(heard)) && norm(e).length <= 4) continue;
        const context = words
          .slice(Math.max(0, i - 6), Math.min(words.length, i + span + 6))
          .map((w, k) => (k === Math.min(6, i) ? `[[${w.text}` : k === Math.min(6, i) + span - 1 ? `${w.text}]]` : w.text))
          .join(" ")
          .replace(/\[\[([^\]]*)\]\]/, "[[$1]]");
        out.push({ id: id++, wordIndex: i, span, heard, entity: e, score: Number(s.toFixed(2)), context });
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
}

/** Rebuild the corrected word list from the as-heard words plus every auto/accepted flag. */
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
      const trailing = /[.,!?;:]$/.exec(last.text)?.[0] ?? "";
      const text = f.replacement ?? f.suggested;
      if (text.trim()) out.push({ text: text + trailing, start: first.start, end: last.end });
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
  context: { title?: string; uploader?: string },
  opts: { signal?: AbortSignal; telemetry?: boolean; autoConfidence?: number; minFlagConfidence?: number; log?: Logger } = {},
): Promise<CorrectionResult> {
  const autoConfidence = opts.autoConfidence ?? 0.85;
  const minFlagConfidence = opts.minFlagConfidence ?? 0.4;
  entities = await filterProperNouns(model, entities, context, opts.signal);
  const candidates = findCandidates(words, entities);
  const none = { words, rawWords: words, flags: [], applied: [], candidates: candidates.length };
  if (!candidates.length) return none;

  const prompt = `You are reviewing speech-to-text errors in a transcript${context.title ? ` of the video "${context.title}"` : ""}${context.uploader ? ` by ${context.uploader}` : ""}.
Known names and terms that appear in this video: ${entities.join(", ")}.

For each candidate below, the transcriber heard the text in [[double brackets]]. Decide whether the speaker actually said the proposed name/term instead.
- replace=true only when the context makes the proposed term clearly more plausible than what was heard.
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
      abortSignal: opts.signal,
      output: Output.object({ schema: decisionSchema, name: "decisions" }),
      telemetry: { isEnabled: opts.telemetry ?? false, functionId: "transcribe.correct-entities", recordInputs: false, recordOutputs: false },
    });
    decisions = output.decisions;
  } catch (err) {
    opts.log?.warn({ err }, "entity correction pass failed, keeping transcript as heard");
    return none;
  }
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const flags: TranscriptFlag[] = [];
  let lastEnd = -1;
  for (const c of candidates.sort((a, b) => a.wordIndex - b.wordIndex)) {
    const d = byId.get(c.id);
    if (!d || !d.replace || d.confidence < minFlagConfidence) continue;
    if (c.wordIndex < lastEnd) continue; // overlapping candidate
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
      // replacing an everyday English word is never automatic, however confident the model is
      status: d.confidence >= autoConfidence && !c.heard.split(/\s+/).some((t) => isCommonWord(t)) ? "auto" : "pending",
    });
  }
  const applied = flags.filter((f) => f.status === "auto").map((f) => ({ heard: f.heard, entity: f.suggested, at: f.start }));
  return { words: applyFlags(words, flags), rawWords: words, flags, applied, candidates: candidates.length };
}
