/**
 * transcription: WER and entity recall through the production setup (TRANSCRIPTION_MODEL, vocabulary
 * bias and LLM correction as configured). Two kinds of case:
 *
 *  - synthetic: macOS `say` (one voice) reading fabricated, name-dense text. Generated into the cache
 *    when missing. Measures the bias + correction path on clean audio, not speech recognition.
 *  - real (`source` set): a 2-minute slice of a real video, materialised from url + time range, graded
 *    against the video's HUMAN caption track (only the words inside the window are committed). Human
 *    tracks are clean verbatim (no um/uh, no restarts), so these cases report the raw WER and a WER
 *    after filler/repeat normalisation of both sides, plus a names-only error rate over the proper
 *    nouns of the reference.
 *
 * Grades WER, entity recall and false entity insertions; real cases can also list `corrections`
 * (a misspelling YouTube's own ASR made, and the right form) and report how many the output repeats.
 * Compare models/options with `--transcription-models a,b` (each model becomes its own case set).
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { extractEntities, biasProviderOptions, correctTranscript } from "../../pipeline/entities.js";
import { underlyingProvider } from "../../ai/registry.js";
import { isUnavailable, materialize, type CaseResult, type MediaSource, type Suite, type SummaryMetric } from "../framework.js";
import { evalAi, transcribeCached } from "../asr.js";

interface Case {
  id: string;
  meta: Record<string, unknown>;
  /** project vocabulary (the user's own list of names/terms), passed to entity extraction like the pipeline does */
  vocabulary?: string;
  entities: string[];
  /** reference transcript: the spoken text (synthetic) or the human caption words inside the window (real) */
  text: string;
  /** real audio: a slice of a video; absent = synthetic `say` audio */
  source?: MediaSource;
  /** spellings YouTube's ASR produced for names in this window, and the right form (real cases) */
  corrections?: Array<{ heard: string; expected: string }>;
  /** how the reference was produced, for re-checking */
  note?: string;
  /**
   * per-case thresholds. Synthetic defaults: wer ≤ 0.12, recall ≥ 0.8, no false insertions. Real
   * defaults: normalised wer ≤ 0.15, recall ≥ 0.6, ≤ 1 false insertion (`maxWer` applies to the normalised WER).
   */
  expect?: { maxWer?: number; minRecall?: number; maxFalseInsertions?: number };
}

/** Lowercase words without punctuation or diacritics ("Cortés" → "cortes"). */
export const normTokens = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

const FILLERS = new Set(["um", "uh", "er", "erm", "ah", "uhm", "hmm", "mm", "eh"]);

/**
 * Clean-verbatim normalisation for comparing a verbatim transcript with a human caption track: drop
 * fillers and collapse immediate repeats of 1-3 words ("I will I will" → "I will"). Applied to both
 * sides, so a legitimate "had had" collapses in the reference too.
 */
export function cleanVerbatim(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (FILLERS.has(t)) continue;
    out.push(t);
    for (let n = 1; n <= 3 && out.length >= 2 * n; n++) {
      const a = out.length - 2 * n;
      if (out.slice(a, a + n).every((x, k) => x === out[a + n + k])) {
        out.splice(a + n, n);
        break;
      }
    }
  }
  return out;
}

/** Word-level edit alignment: WER, and for each reference token whether the hypothesis has it at the aligned position. */
export function alignWords(ref: string[], hyp: string[]): { wer: number; matched: boolean[] } {
  const w = hyp.length + 1;
  const d = new Uint32Array((ref.length + 1) * w);
  for (let j = 0; j <= hyp.length; j++) d[j] = j;
  for (let i = 1; i <= ref.length; i++) {
    d[i * w] = i;
    for (let j = 1; j <= hyp.length; j++) d[i * w + j] = Math.min(d[(i - 1) * w + j]! + 1, d[i * w + j - 1]! + 1, d[(i - 1) * w + j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
  }
  const matched = new Array<boolean>(ref.length).fill(false);
  let i = ref.length;
  let j = hyp.length;
  while (i > 0 && j > 0) {
    const sub = d[(i - 1) * w + j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
    if (d[i * w + j] === sub) {
      matched[i - 1] = ref[i - 1] === hyp[j - 1];
      i--;
      j--;
    } else if (d[i * w + j] === d[(i - 1) * w + j]! + 1) i--;
    else j--;
  }
  return { wer: ref.length ? d[ref.length * w + hyp.length]! / ref.length : 0, matched };
}

export function wer(ref: string[], hyp: string[]): number {
  return alignWords(ref, hyp).wer;
}

/**
 * Proper nouns of a reference text, found by capitalisation: a capitalised word that does not start a
 * sentence (or a quotation) and is not "I". Returns the normalised tokens they produce.
 */
export function nameTokens(text: string): Set<string> {
  const out = new Set<string>();
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!.replace(/^["“‘(]+/, "");
    const prev = words[i - 1]!;
    if (/[.!?…:]["”’)]?$/.test(prev) || /^["“‘]/.test(words[i]!)) continue;
    if (!/^\p{Lu}/u.test(w) || /^I(['’].*)?$/.test(w)) continue;
    for (const t of normTokens(w)) out.add(t);
  }
  return out;
}

function count(tokens: string[], entity: string) {
  const e = normTokens(entity);
  let n = 0;
  for (let i = 0; i + e.length <= tokens.length; i++) if (e.every((t, k) => tokens[i + k] === t)) n++;
  return n;
}

export function entityStats(ref: string[], hyp: string[], entities: string[]) {
  let refN = 0;
  let hit = 0;
  let extra = 0;
  for (const e of entities) {
    const r = count(ref, e);
    const h = count(hyp, e);
    refN += r;
    hit += Math.min(r, h);
    extra += Math.max(0, h - r);
  }
  return { refN, hit, extra };
}

/** 16 kHz mono mp3 of the case's audio: `say` for synthetic cases, the materialised slice for real ones. */
async function audioFor(ctx: Parameters<Suite["run"]>[0], c: Case, audioDir: string): Promise<string | { skipped: string }> {
  const cfg = ctx.config();
  const file = path.join(audioDir, `${c.source ? c.source.id : c.id}.mp3`);
  if (existsSync(file)) return file;
  if (c.source) {
    let media: string;
    try {
      media = await materialize(ctx, c.source);
    } catch (err) {
      return { skipped: `media unavailable: ${(err as Error).message.slice(0, 140)}` };
    }
    await ctx.exec(cfg.FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", "-i", media, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3", file]);
    return file;
  }
  if (process.platform !== "darwin") return { skipped: "audio missing; generate on macOS with eval/generate-audio.sh" };
  const aiff = file.replace(/\.mp3$/, ".aiff");
  await ctx.exec("say", ["-v", "Samantha", "-r", "175", "-o", aiff, c.text]);
  await ctx.exec(cfg.FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", "-i", aiff, "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3", file]);
  await fs.rm(aiff, { force: true });
  return file;
}

const r3 = (x: number) => Number(x.toFixed(3));

export const transcriptionSuite: Suite = {
  name: "transcription",
  description: "WER + entity recall through the configured STT, bias and correction: synthetic `say` audio, and real speech graded against human captions",
  needs: ["models", "media"],
  async run(ctx) {
    const dir = ctx.fixtures("transcription");
    const cases = JSON.parse(await fs.readFile(path.join(dir, "cases.json"), "utf8")) as Case[];
    const cfg = ctx.config();
    const audioDir = path.join(ctx.cacheDir, "transcription-audio");
    await fs.mkdir(audioDir, { recursive: true });
    const models = (ctx.opt("transcription-models") ?? cfg.TRANSCRIPTION_MODEL).split(",");
    const lm = cfg.TRANSCRIPT_CORRECTION ? await evalAi(ctx).languageModel() : null;
    const out: CaseResult[] = [];
    for (const modelId of models) {
      for (const c of cases) {
        const id = models.length > 1 ? `${modelId.split(":").pop()}/${c.id}` : c.id;
        const synthetic = !c.source;
        try {
          const file = await audioFor(ctx, c, audioDir);
          if (typeof file !== "string") {
            out.push({ id, pass: false, skipped: file.skipped, metrics: { synthetic } });
            continue;
          }
          const audio = new Uint8Array(await fs.readFile(file));
          const entities = extractEntities(c.meta, c.vocabulary);
          const bias = cfg.TRANSCRIPT_BIAS ? biasProviderOptions(underlyingProvider(modelId), entities) : {};
          const heard = await transcribeCached(ctx, modelId, audio, bias as Record<string, unknown>);
          let words = heard.words;
          let applied = 0;
          if (lm) {
            const r = await correctTranscript(lm, words, entities, { title: String(c.meta.title ?? ""), uploader: String(c.meta.uploader ?? "") });
            words = r.words;
            applied = r.applied.length;
          }
          const ref = normTokens(c.text);
          const hyp = normTokens(words.map((w) => w.text).join(" "));
          const raw = alignWords(ref, hyp).wer;
          const es = entityStats(ref, hyp, c.entities);
          const recall = es.refN ? es.hit / es.refN : 1;
          const e = c.expect ?? {};
          if (synthetic) {
            const pass = raw <= (e.maxWer ?? 0.12) && recall >= (e.minRecall ?? 0.8) && es.extra <= (e.maxFalseInsertions ?? 0);
            out.push({ id, pass, metrics: { synthetic, wer: r3(raw), recall: Number(recall.toFixed(2)), entities: `${es.hit}/${es.refN}`, falseIns: es.extra, autoFixed: applied }, notes: pass ? "" : hyp.join(" ").slice(0, 160) });
            continue;
          }
          const cleanRef = cleanVerbatim(ref);
          const cleanHyp = cleanVerbatim(hyp);
          const al = alignWords(cleanRef, cleanHyp);
          const names = nameTokens(c.text);
          const nameIdx = cleanRef.flatMap((t, i) => (names.has(t) ? [i] : []));
          const nameErr = nameIdx.filter((i) => !al.matched[i]).length;
          const misheard = (c.corrections ?? []).reduce((n, k) => n + count(hyp, k.heard), 0);
          const pass = al.wer <= (e.maxWer ?? 0.15) && recall >= (e.minRecall ?? 0.6) && es.extra <= (e.maxFalseInsertions ?? 1);
          const missedNames = [...new Set(nameIdx.filter((i) => !al.matched[i]).map((i) => cleanRef[i]))].slice(0, 8).join(" ");
          out.push({
            id,
            pass,
            metrics: { synthetic, wer: r3(raw), werNorm: r3(al.wer), nameErr: `${nameErr}/${nameIdx.length}`, nameErrN: nameErr, nameN: nameIdx.length, recall: Number(recall.toFixed(2)), entities: `${es.hit}/${es.refN}`, falseIns: es.extra, misheard, autoFixed: applied },
            notes: missedNames ? `names missed: ${missedNames}` : "",
          });
        } catch (err) {
          if (isUnavailable(err)) out.push({ id, pass: false, skipped: `model unavailable: ${(err as Error).message.slice(0, 120)}`, metrics: { synthetic } });
          else out.push({ id, pass: false, notes: `error: ${(err as Error).message.slice(0, 160)}`, metrics: { synthetic } });
        }
      }
    }
    return out;
  },
  summarize(results) {
    const ran = results.filter((r) => !r.skipped && r.metrics?.wer !== undefined);
    const syn = ran.filter((r) => r.metrics?.synthetic !== false);
    const real = ran.filter((r) => r.metrics?.synthetic === false);
    const mean = (rs: CaseResult[], k: string) => Number((rs.reduce((a, r) => a + Number(r.metrics?.[k] ?? 0), 0) / (rs.length || 1)).toFixed(3));
    const sum = (rs: CaseResult[], k: string) => rs.reduce((a, r) => a + Number(r.metrics?.[k] ?? 0), 0);
    // unprefixed metrics are the synthetic (`say`) cases, as before real cases existed
    const out: Record<string, SummaryMetric> = {
      meanWer: { value: mean(syn, "wer"), better: "lower", tolerance: 0.02 },
      meanEntityRecall: { value: mean(syn, "recall"), better: "higher", tolerance: 0.05 },
      falseInsertions: { value: sum(syn, "falseIns"), better: "lower", tolerance: 0 },
    };
    if (real.length) {
      const nameN = sum(real, "nameN");
      const nameErr = sum(real, "nameErrN");
      Object.assign(out, {
        "real.meanWer": { value: mean(real, "wer"), better: "lower", tolerance: 0.02 },
        "real.meanWerNormalised": { value: mean(real, "werNorm"), better: "lower", tolerance: 0.02 },
        "real.nameErrorRate": { value: Number((nameErr / Math.max(1, nameN)).toFixed(3)), better: "lower", tolerance: 0.05, ratio: { k: nameErr, n: nameN } },
        "real.meanEntityRecall": { value: mean(real, "recall"), better: "higher", tolerance: 0.05 },
        "real.misheard": { value: sum(real, "misheard"), better: "lower", tolerance: 0 },
      } satisfies Record<string, SummaryMetric>);
    }
    return out;
  },
};
