/**
 * decisions: live replay of what users actually decided (docs/specs/decision-log.md). Reads an export of the
 * decision log (`reelsaw decisions export <email> --out f.jsonl`, or MCP `export_decisions`) from
 * `EVAL_DECISIONS=<path>` or `--decisions <path>`, turns explicit decisions about cuts into disfluency cases
 * (`decisions/cases.ts`) and runs today's detector over them: agreement with users as precision / recall, split by
 * project. User data never goes in git, so the suite has no baseline and is skipped without a file.
 */
import fs from "node:fs/promises";
import type { CaseResult, Suite } from "../framework.js";
import { disfluencyCases, parseExport } from "../../decisions/cases.js";
import { runDisfluencyCases, summarizeDisfluency } from "./disfluency.js";

export const decisionsSuite: Suite = {
  name: "decisions",
  description: "today's disfluency detector against users' recorded accept / reject / manual-cut decisions (EVAL_DECISIONS=export.jsonl)",
  needs: [],
  offlineBaseline: true,
  noBaseline: true,
  async run(ctx): Promise<CaseResult[]> {
    const file = ctx.opt("decisions") ?? process.env.EVAL_DECISIONS;
    if (!file) return [{ id: "(suite)", pass: false, skipped: "no decisions export: set EVAL_DECISIONS=<file.jsonl> or pass --decisions <file>" }];
    const { rows, bad } = parseExport(await fs.readFile(file, "utf8"));
    if (bad) ctx.log.warn({ bad }, "export lines that are not decisions were skipped");
    const cases = disfluencyCases(rows);
    if (!cases.length) return [{ id: "(suite)", pass: false, skipped: `no explicit cut decisions among ${rows.length} rows` }];
    const only = ctx.opt("split");
    return runDisfluencyCases(
      ctx,
      cases.filter((c) => !only || c.split === only),
    );
  },
  summarize: summarizeDisfluency,
};
