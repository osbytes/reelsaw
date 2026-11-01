/**
 * harvest-decisions: candidate disfluency cases from an export of the decision log (docs/specs/decision-log.md).
 *
 *   npx tsx src/eval/tools/harvest-decisions.ts <export.jsonl> [--out ../../eval/fixtures/disfluency/candidates.json] [--max 50]
 *
 * The export comes from `reelsaw decisions export <email> --out f.jsonl` (or MCP `export_decisions`). Every explicit
 * decision about a cut becomes a case in the cases.json shape, with `source` provenance (link at the moment, project,
 * date, videoId, sha256), split dev / heldout by project, deduped against itself and against the committed
 * cases.json. Candidates are not fixtures: a person reads each one, drops the ones the text alone cannot settle (or
 * marks them `uncertain`), and moves the rest into cases.json (docs/EVALS.md, "Cases from user decisions").
 * Without `--out` it prints a summary only. The decision ids in the case ids make a promoted case traceable.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { caseKey, disfluencyCases, parseExport, type DisfluencyCase } from "../../decisions/cases.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const COMMITTED = path.resolve(here, "../../../../../eval/fixtures/disfluency/cases.json");

export async function harvest(
  exportFile: string,
  committedFile = COMMITTED,
): Promise<{ cases: DisfluencyCase[]; rows: number; bad: number; skippedCommitted: number }> {
  const { rows, bad } = parseExport(await fs.readFile(exportFile, "utf8"));
  const committed: Array<Pick<DisfluencyCase, "words" | "target">> = existsSync(committedFile)
    ? (JSON.parse(await fs.readFile(committedFile, "utf8")) as { cases: Array<Pick<DisfluencyCase, "words" | "target">> }).cases
    : [];
  const exclude = committed.map(caseKey);
  const all = disfluencyCases(rows);
  const cases = disfluencyCases(rows, exclude);
  return { cases, rows: rows.length, bad, skippedCommitted: all.length - cases.length };
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith("--"));
  const opt = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (!file) throw new Error("usage: harvest-decisions.ts <export.jsonl> [--out candidates.json] [--max 50]");
  const max = Number(opt("max") ?? 0) || Infinity;
  const r = await harvest(file);
  const cases = r.cases.slice(0, max);
  const count = (f: (c: DisfluencyCase) => boolean) => cases.filter(f).length;
  console.log(
    `${r.rows} decisions${r.bad ? ` (${r.bad} unreadable lines)` : ""} → ${r.cases.length} new cut/keep cases (${r.skippedCommitted} already committed or duplicated)`,
  );
  console.log(
    `  cut ${count((c) => c.expect === "cut")} · keep ${count((c) => c.expect === "keep")} · dev ${count((c) => c.split === "dev")} · heldout ${count((c) => c.split === "heldout")}${cases.length < r.cases.length ? ` (first ${cases.length})` : ""}`,
  );
  const out = opt("out");
  if (!out) return;
  await fs.writeFile(
    out,
    JSON.stringify(
      {
        note: `Candidates harvested from user decisions on ${new Date().toISOString().slice(0, 10)}. Read each one before moving it into cases.json; never commit user data you were not given to share.`,
        cases,
      },
      null,
      1,
    ) + "\n",
  );
  console.log(`  wrote ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
