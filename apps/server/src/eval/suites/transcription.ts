/**
 * transcription: synthesized speech with known entities (names, brands) through the production setup
 * (TRANSCRIPTION_MODEL, vocabulary bias and LLM correction as configured). Grades WER, entity recall
 * and false entity insertions. Audio is generated with macOS `say` into the cache when missing.
 * Compare models/options with `--transcription-models a,b` (each model becomes its own case set).
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { extractEntities, biasProviderOptions, correctTranscript } from "../../pipeline/entities.js";
import { underlyingProvider } from "../../ai/registry.js";
import { isUnavailable, type CaseResult, type Suite } from "../framework.js";
import { evalAi, transcribeCached } from "../asr.js";

interface Case {
  id: string;
  meta: Record<string, unknown>;
  entities: string[];
  text: string;
  /** per-case thresholds (defaults: wer ≤ 0.12, recall ≥ 0.8, no false insertions) */
  expect?: { maxWer?: number; minRecall?: number; maxFalseInsertions?: number };
}

export const normTokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

export function wer(ref: string[], hyp: string[]): number {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    prev = cur;
  }
  return ref.length ? prev[hyp.length]! / ref.length : 0;
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

export const transcriptionSuite: Suite = {
  name: "transcription",
  description: "WER + entity recall on synthesized speech through the configured STT, bias and correction",
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
        const file = path.join(audioDir, `${c.id}.mp3`);
        if (!existsSync(file)) {
          if (process.platform !== "darwin") {
            out.push({ id, pass: false, skipped: "audio missing; generate on macOS with eval/generate-audio.sh" });
            continue;
          }
          const aiff = file.replace(/\.mp3$/, ".aiff");
          await ctx.exec("say", ["-v", "Samantha", "-r", "175", "-o", aiff, c.text]);
          await ctx.exec(cfg.FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", "-i", aiff, "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3", file]);
          await fs.rm(aiff, { force: true });
        }
        try {
          const audio = new Uint8Array(await fs.readFile(file));
          const entities = extractEntities(c.meta);
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
          const w = wer(ref, hyp);
          const es = entityStats(ref, hyp, c.entities);
          const recall = es.refN ? es.hit / es.refN : 1;
          const e = c.expect ?? {};
          const pass = w <= (e.maxWer ?? 0.12) && recall >= (e.minRecall ?? 0.8) && es.extra <= (e.maxFalseInsertions ?? 0);
          out.push({ id, pass, metrics: { wer: Number(w.toFixed(3)), recall: Number(recall.toFixed(2)), entities: `${es.hit}/${es.refN}`, falseIns: es.extra, autoFixed: applied }, notes: pass ? "" : hyp.join(" ").slice(0, 160) });
        } catch (err) {
          if (isUnavailable(err)) out.push({ id, pass: false, skipped: `model unavailable: ${(err as Error).message.slice(0, 120)}` });
          else out.push({ id, pass: false, notes: `error: ${(err as Error).message.slice(0, 160)}` });
        }
      }
    }
    return out;
  },
  summarize(results) {
    const n = results.length || 1;
    const sum = (k: string) => results.reduce((a, r) => a + Number(r.metrics?.[k] ?? 0), 0);
    return {
      meanWer: { value: Number((sum("wer") / n).toFixed(3)), better: "lower", tolerance: 0.02 },
      meanEntityRecall: { value: Number((sum("recall") / n).toFixed(3)), better: "higher", tolerance: 0.05 },
      falseInsertions: { value: sum("falseIns"), better: "lower", tolerance: 0 },
    };
  },
};
