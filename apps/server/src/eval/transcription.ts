/**
 * Transcription comparison matrix: WER and entity recall across whisper models × vocabulary bias × LLM
 * correction. For pass/fail regression checks use the `transcription` suite of the eval runner
 * (`pnpm eval transcription`); this script is for choosing models/options.
 *
 *   DATABASE_URL=x BETTER_AUTH_SECRET=xxxxxxxxxxxxxxxx OPENAI_BASE_URL=http://localhost:8000/v1 OPENAI_API_KEY=local \
 *   AI_MODEL=compat:qwen2.5:14b OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1 \
 *   pnpm --filter @reelsaw/server eval:transcription -- --models openai:Systran/faster-whisper-small,openai:Systran/faster-whisper-medium
 */
import fs from "node:fs/promises";
import path from "node:path";
import { transcribe } from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import { loadConfig } from "../config.js";
import { createLogger } from "../log.js";
import { createAi, providerOf } from "../ai/registry.js";
import { toWords } from "../pipeline/transcript.js";
import { extractEntities, biasProviderOptions, correctTranscript } from "../pipeline/entities.js";
import type { Word } from "@reelsaw/shared";

interface Case {
  id: string;
  meta: Record<string, unknown>;
  entities: string[];
  text: string;
}

const args = process.argv.slice(2);
const argv = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : def;
};
const casesPath = path.resolve(argv("cases", "../../eval/fixtures/transcription/cases.json"));
const models = argv("models", process.env.TRANSCRIPTION_MODEL ?? "openai:whisper-1").split(",");
const only = argv("only", "");

const config = loadConfig();
const ai = createAi(config, createLogger({ LOG_LEVEL: config.LOG_LEVEL, LOG_FORMAT: config.LOG_FORMAT }, { role: "eval" }));
const cases = (JSON.parse(await fs.readFile(casesPath, "utf8")) as Case[]).filter((c) => !only || c.id === only);
const audioDir = path.resolve(argv("audio", "../../eval/.cache/transcription-audio")); // eval/generate-audio.sh

const normTokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

function wer(ref: string[], hyp: string[]): number {
  const m = ref.length;
  const n = hyp.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    prev = cur;
  }
  return m ? prev[n]! / m : 0;
}

function countOccurrences(tokens: string[], entity: string): number {
  const e = normTokens(entity);
  let n = 0;
  for (let i = 0; i + e.length <= tokens.length; i++) if (e.every((t, k) => tokens[i + k] === t)) n++;
  return n;
}

/** recall = matched mentions / reference mentions; extra = hypothesis mentions beyond the reference (false insertions). */
function entityStats(ref: string[], hyp: string[], entities: string[]) {
  let refN = 0;
  let hit = 0;
  let extra = 0;
  for (const e of entities) {
    const r = countOccurrences(ref, e);
    const h = countOccurrences(hyp, e);
    refN += r;
    hit += Math.min(r, h);
    extra += Math.max(0, h - r);
  }
  return { refN, hit, extra, recall: refN ? hit / refN : 1 };
}

interface Row {
  model: string;
  bias: boolean;
  correct: boolean;
  wer: number;
  recall: number;
  extra: number;
  refN: number;
  corrections: number;
  pending: number;
  ms: number;
}

const rows: Row[] = [];
const lm = await ai.languageModel();

for (const modelId of models) {
  const model = await ai.transcriptionModel(modelId);
  const provider = providerOf(modelId);
  for (const bias of [false, true]) {
    // one transcription per (model, bias); correction evaluated on top of it
    const perCase: Array<{ c: Case; words: Word[]; ms: number }> = [];
    for (const c of cases) {
      const audio = await fs.readFile(path.join(audioDir, `${c.id}.mp3`));
      const entities = extractEntities(c.meta);
      const providerOptions = { [provider]: { ...(ai.transcriptionOptions(modelId)[provider] ?? {}), ...(bias ? biasProviderOptions(provider, entities) : {}) } } as Record<string, JSONObject>;
      const t0 = Date.now();
      const res = await transcribe({ model, audio, providerOptions, maxRetries: 1 });
      const words = toWords(res.segments.map((s) => ({ text: s.text, startSecond: s.startSecond, endSecond: s.endSecond })));
      perCase.push({ c, words, ms: Date.now() - t0 });
    }
    for (const correct of [false, true]) {
      let werSum = 0;
      let hit = 0;
      let refN = 0;
      let extra = 0;
      let corrections = 0;
      let pending = 0;
      let ms = 0;
      for (const { c, words, ms: tms } of perCase) {
        let w = words;
        ms += tms;
        if (correct) {
          const t0 = Date.now();
          const r = await correctTranscript(lm, words, extractEntities(c.meta), { title: String(c.meta.title ?? ""), uploader: String(c.meta.uploader ?? "") });
          ms += Date.now() - t0;
          w = r.words;
          corrections += r.applied.length;
          pending += r.flags.length - r.applied.length;
          if (process.env.EVAL_VERBOSE && r.flags.length) console.error(`    flags: ${r.flags.map((f) => `${f.heard}→${f.suggested} ${f.confidence} ${f.status}`).join("; ")}`);
        }
        const hyp = normTokens(w.map((x) => x.text).join(" "));
        const ref = normTokens(c.text);
        werSum += wer(ref, hyp);
        const es = entityStats(ref, hyp, c.entities);
        hit += es.hit;
        refN += es.refN;
        extra += es.extra;
        if (process.env.EVAL_VERBOSE) console.error(`  ${modelId} bias=${bias} correct=${correct} ${c.id}: wer=${wer(ref, hyp).toFixed(3)} entities=${es.hit}/${es.refN} extra=${es.extra}\n    ${w.map((x) => x.text).join(" ")}`);
      }
      rows.push({ model: modelId, bias, correct, wer: werSum / perCase.length, recall: refN ? hit / refN : 1, extra, refN, corrections, pending, ms });
    }
  }
}

console.log(`\nTranscription eval · ${cases.length} cases · ${rows[0]?.refN ?? 0} entity mentions · LLM ${config.AI_MODEL}\n`);
console.log("| model | vocab bias | LLM correction | WER | entity recall | false entity insertions | auto-fixed | flagged for review | time |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(`| ${r.model.replace("openai:Systran/", "")} | ${r.bias ? "yes" : "no"} | ${r.correct ? "yes" : "no"} | ${(r.wer * 100).toFixed(1)}% | ${(r.recall * 100).toFixed(0)}% | ${r.extra} | ${r.corrections} | ${r.pending} | ${(r.ms / 1000).toFixed(0)}s |`);
}
process.exit(0);
