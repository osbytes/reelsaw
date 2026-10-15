/**
 * Eval runner.
 *
 *   pnpm --filter @reelsaw/server eval [suite...] [--offline] [--update] [--json out.json] [--verbose] [--list]
 *   docker compose exec -e EVAL_DIR=/data/eval app node /app/server/dist/eval/run.js [suite...]
 *
 * Prints a table per suite, writes eval/reports/<timestamp>.{json,md}, compares with
 * eval/baselines/<suite>.json and exits 1 on regressions. `--update` accepts the current results as
 * the new baseline. See docs/EVALS.md.
 */
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, type Config } from "../config.js";
import { createLogger } from "../log.js";
import { compare, exec, findEvalRoot, fmt, makeCache, type Baseline, type CaseResult, type EvalContext, type SummaryMetric } from "./framework.js";
import { suites } from "./suites/index.js";

const argv = process.argv.slice(2);
const valueOf = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--") && valueOf(argv[i - 1]!.slice(2)) === a));

const root = findEvalRoot();

// ---- environment: the repo .env (for model ids/keys), reachable from the host, no DB needed ----
const inContainer = existsSync("/.dockerenv");
const envFile = path.join(path.dirname(root), ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || process.env[m[1]!] !== undefined) continue;
    const raw = m[2]!;
    process.env[m[1]!] = /^["']/.test(raw) ? raw.replace(/^(["'])(.*)\1.*$/, "$2") : raw.replace(/\s+#.*$/, "").trim();
  }
}
if (!inContainer) {
  // compose service names only resolve inside the network; the stack publishes them on localhost
  for (const k of Object.keys(process.env)) {
    const v = process.env[k];
    if (v && /:\/\/(speaches|ollama|host\.docker\.internal|db|minio)(:|\/)/.test(v)) process.env[k] = v.replace(/:\/\/(speaches|ollama|host\.docker\.internal|db|minio)(?=[:/])/, "://localhost");
  }
}
process.env.DATABASE_URL ||= "postgres://eval@localhost/eval"; // never connected to
process.env.BETTER_AUTH_SECRET ||= "eval-only-secret-not-used-anywhere";
process.env.REELSAW_CLI = "1";

let config: Config | undefined;
const getConfig = () => (config ??= loadConfig(process.env));
const log = createLogger({ LOG_LEVEL: has("verbose") ? "debug" : process.env.EVAL_LOG_LEVEL || "warn", LOG_FORMAT: "auto" }, { role: "eval" });

async function main() {
  if (has("list")) {
    for (const s of suites) console.log(`${s.name.padEnd(14)} needs: ${s.needs.join(", ") || "nothing"}\n${" ".repeat(14)} ${s.description}`);
    return;
  }
  const offline = has("offline");
  const update = has("update");
  const selected = positional.length ? suites.filter((s) => positional.includes(s.name)) : suites;
  const unknown = positional.filter((p) => !suites.some((s) => s.name === p));
  if (unknown.length) throw new Error(`unknown suite(s): ${unknown.join(", ")}; known: ${suites.map((s) => s.name).join(", ")}`);

  const cacheDir = path.join(root, ".cache");
  const ctx: EvalContext = {
    root,
    fixtures: (suite) => path.join(root, "fixtures", suite),
    cacheDir,
    offline,
    verbose: has("verbose"),
    opt: (name) => valueOf(name),
    config: getConfig,
    log,
    cached: makeCache(cacheDir),
    exec,
  };

  const report: Array<{ suite: string; results: CaseResult[]; metrics: Record<string, SummaryMetric>; regressions: string[]; improvements: string[]; ms: number; skipped?: string }> = [];
  let failed = false;
  for (const s of selected) {
    process.stdout.write(`\n▶ ${s.name}: ${s.description}\n`);
    if (offline && (s.needs.includes("models") || s.needs.includes("network"))) {
      console.log(`  skipped (--offline; needs ${s.needs.join(", ")})`);
      report.push({ suite: s.name, results: [], metrics: {}, regressions: [], improvements: [], ms: 0, skipped: "offline" });
      continue;
    }
    const t0 = Date.now();
    let results: CaseResult[];
    try {
      results = await s.run(ctx);
    } catch (err) {
      results = [{ id: "(suite)", pass: false, notes: `suite crashed: ${(err as Error).message}` }];
    }
    const metrics = s.summarize ? s.summarize(results.filter((r) => !r.skipped)) : {};
    const basePath = path.join(root, "baselines", `${s.name}.json`);
    const baseline = existsSync(basePath) ? (JSON.parse(await fs.readFile(basePath, "utf8")) as Baseline) : null;
    const cmp = compare(baseline, results, metrics);
    const ms = Date.now() - t0;
    printTable(results);
    for (const [k, m] of Object.entries(metrics)) console.log(`  ${k.padEnd(28)} ${fmt(m.value)}${baseline?.metrics[k] ? `  (baseline ${fmt(baseline.metrics[k]!.value)})` : ""}`);
    for (const r of cmp.regressions) console.log(`  ✗ REGRESSION ${r}`);
    for (const r of cmp.improvements) console.log(`  ✓ improved ${r}`);
    if (!baseline) console.log(`  (no baseline yet; run with --update to record one)`);
    console.log(`  ${(ms / 1000).toFixed(1)}s`);
    if (cmp.regressions.length) failed = true;
    if (update) {
      const next: Baseline = {
        updatedAt: new Date().toISOString(),
        // skipped cases keep their previous state so an offline run never erases them
        cases: { ...(baseline?.cases ?? {}), ...Object.fromEntries(results.filter((r) => !r.skipped && r.id !== "(suite)").map((r) => [r.id, r.pass])) },
        metrics: { ...(baseline?.metrics ?? {}), ...metrics },
      };
      await fs.mkdir(path.dirname(basePath), { recursive: true });
      await fs.writeFile(basePath, JSON.stringify(next, null, 2) + "\n");
      console.log(`  baseline updated: ${path.relative(path.dirname(root), basePath)}`);
    }
    report.push({ suite: s.name, results, metrics, ...cmp, ms });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const repDir = path.join(root, "reports");
  await fs.mkdir(repDir, { recursive: true });
  const json = JSON.stringify({ at: new Date().toISOString(), offline, report }, null, 2);
  await fs.writeFile(path.join(repDir, `${stamp}.json`), json);
  await fs.writeFile(path.join(repDir, `${stamp}.md`), markdown(report));
  const jsonOut = valueOf("json");
  if (jsonOut) await fs.writeFile(path.resolve(jsonOut), json);
  console.log(`\nreport: ${path.relative(process.cwd(), path.join(repDir, `${stamp}.md`))}`);
  if (failed && !update) {
    console.log("✗ regressions found");
    process.exitCode = 1;
  }
}

function printTable(results: CaseResult[]) {
  const metricKeys = [...new Set(results.flatMap((r) => Object.keys(r.metrics ?? {})))].slice(0, 6);
  const head = ["case", "result", ...metricKeys, "notes"];
  const rows = results.map((r) => [r.id, r.skipped ? "skip" : r.pass ? "pass" : "FAIL", ...metricKeys.map((k) => fmt(r.metrics?.[k] ?? "")), (r.skipped ?? r.notes ?? "").replace(/\s+/g, " ")]);
  const w = head.map((h, i) => Math.min(i === head.length - 1 ? 90 : 34, Math.max(h.length, ...rows.map((r) => r[i]!.length))));
  console.log("  " + head.map((h, i) => h.padEnd(w[i]!)).join("  "));
  for (const r of rows) console.log("  " + r.map((x, i) => x.slice(0, w[i]).padEnd(w[i]!)).join("  "));
}

function markdown(report: Array<{ suite: string; results: CaseResult[]; metrics: Record<string, SummaryMetric>; regressions: string[]; improvements: string[]; ms: number; skipped?: string }>) {
  const out = [`# Eval report ${new Date().toISOString()}`, ""];
  for (const r of report) {
    out.push(`## ${r.suite}${r.skipped ? ` (skipped: ${r.skipped})` : ""}`, "");
    if (r.regressions.length) out.push(...r.regressions.map((x) => `- ✗ ${x}`), "");
    if (r.improvements.length) out.push(...r.improvements.map((x) => `- ✓ ${x}`), "");
    if (Object.keys(r.metrics).length) out.push("| metric | value |", "|---|---|", ...Object.entries(r.metrics).map(([k, m]) => `| ${k} | ${fmt(m.value)} |`), "");
    if (r.results.length) {
      out.push("| case | result | metrics | notes |", "|---|---|---|---|");
      for (const c of r.results) out.push(`| ${c.id} | ${c.skipped ? "skip" : c.pass ? "pass" : "**FAIL**"} | ${Object.entries(c.metrics ?? {}).map(([k, v]) => `${k}=${fmt(v)}`).join(", ")} | ${(c.skipped ?? c.notes ?? "").replace(/\|/g, "/")} |`);
      out.push("");
    }
  }
  return out.join("\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
