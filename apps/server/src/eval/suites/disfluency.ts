/**
 * disfluency: precision/recall of disfluency detection on real transcript windows.
 *
 * Fixtures are ±30-word windows around candidates the app flagged, labelled by the user's own
 * review (accepted = real disfluency, rejected = false positive) plus a few hand labels for
 * unreviewed repetitions (intentional emphasis such as "really, really" is `keep`).
 *   expect=cut  → the detector must flag (overlap) the target span
 *   expect=keep → it must not
 * Runs the production `detectDisfluencies`. Without a language model (--offline or unreachable) it
 * runs rules only and says so. Model calls are cached by prompt, so reruns are free and stable.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";
import type { Word } from "@reelsaw/shared";
import { detectDisfluencies } from "../../pipeline/disfluency.js";
import { isUnavailable, type CaseResult, type EvalContext, type Suite } from "../framework.js";
import { evalAi } from "../asr.js";

interface Case {
  id: string;
  expect: "cut" | "keep";
  kind: string;
  target: { index: number; span: number };
  label: string;
  words: Word[];
}

/** Cache generate calls by their full params: same prompt → same answer, no model needed on reruns. */
function cachedModel(ctx: EvalContext, model: LanguageModel): LanguageModel {
  const middleware: LanguageModelMiddleware = {
    wrapGenerate: async ({ doGenerate, params, model: m }) => {
      const key = ["disfluency-llm", m.provider, m.modelId, params.prompt, params.temperature ?? null, params.responseFormat ?? null];
      return ctx.cached(key, async () => JSON.parse(JSON.stringify(await doGenerate())) as Awaited<ReturnType<typeof doGenerate>>);
    },
  };
  return wrapLanguageModel({ model: model as Parameters<typeof wrapLanguageModel>[0]["model"], middleware }) as LanguageModel;
}

export const disfluencySuite: Suite = {
  name: "disfluency",
  description: "disfluency detection precision/recall on reviewed real-transcript cases (rules + model)",
  needs: [],
  async run(ctx) {
    const spec = JSON.parse(await fs.readFile(path.join(ctx.fixtures("disfluency"), "cases.json"), "utf8")) as { cases: Case[] };
    let model: LanguageModel | null = null;
    let mode = "rules";
    if (!ctx.offline) {
      try {
        model = cachedModel(ctx, await evalAi(ctx).languageModel());
        mode = "rules+model";
      } catch (err) {
        ctx.log.warn({ err: (err as Error).message }, "no language model; rules only");
      }
    }
    const auto = ctx.config().TRANSCRIPT_AUTO_FIX_CONFIDENCE;
    const out: CaseResult[] = [];
    for (const c of spec.cases) {
      try {
        const flags = await detectDisfluencies(model, c.words, { autoConfidence: auto, concurrency: 1 });
        const a = c.target.index;
        const b = c.target.index + c.target.span - 1;
        const hit = flags.find((f) => f.wordIndex <= b && f.wordIndex + f.span - 1 >= a);
        const flagged = !!hit;
        const pass = c.expect === "cut" ? flagged : !flagged;
        const others = flags.filter((f) => f !== hit).length;
        out.push({
          id: c.id,
          pass,
          metrics: {
            expect: c.expect,
            got: flagged ? `${hit!.subkind} ${Math.round(hit!.confidence * 100)}%${hit!.status === "auto" ? " auto" : ""}` : "-",
            outcome: c.expect === "cut" ? (flagged ? "TP" : "FN") : flagged ? "FP" : "TN",
            mode,
            otherFlags: others,
          },
          notes: `${c.kind} · ${c.label} · “…${c.words.slice(Math.max(0, a - 5), a).map((w) => w.text).join(" ")} [${c.words.slice(a, b + 1).map((w) => w.text).join(" ")}] ${c.words.slice(b + 1, b + 6).map((w) => w.text).join(" ")}…”`,
        });
      } catch (err) {
        if (isUnavailable(err)) out.push({ id: c.id, pass: false, skipped: `model unavailable: ${(err as Error).message.slice(0, 100)}` });
        else out.push({ id: c.id, pass: false, notes: `error: ${(err as Error).message.slice(0, 160)}` });
      }
    }
    return out;
  },
  summarize(results) {
    const n = (o: string) => results.filter((r) => r.metrics?.outcome === o).length;
    const tp = n("TP");
    const fp = n("FP");
    const fn = n("FN");
    const autoFp = results.filter((r) => r.metrics?.outcome === "FP" && String(r.metrics?.got).endsWith("auto")).length;
    return {
      precision: { value: Number((tp / Math.max(1, tp + fp)).toFixed(2)), better: "higher", tolerance: 0.03 },
      recall: { value: Number((tp / Math.max(1, tp + fn)).toFixed(2)), better: "higher", tolerance: 0.03 },
      falsePositives: { value: fp, better: "lower" },
      // wrong cuts applied without review are the costly ones
      autoFalsePositives: { value: autoFp, better: "lower" },
    };
  },
};
