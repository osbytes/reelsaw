/**
 * Eval runner.
 *
 *   pnpm --filter @reelsaw/server eval [suite...] [--offline] [--update] [--json out.json] [--verbose] [--list]
 *   pnpm --filter @reelsaw/server eval [suite...] --matrix eval/bench/models.json [--profiles a,b] [--no-cache]
 *   pnpm --filter @reelsaw/server eval [suite...] --set AI_MODEL=gateway:openai/gpt-4o-mini [--set K=V ...]
 *   docker compose exec -e EVAL_DIR=/data/eval app node /app/server/dist/eval/run.js [suite...]
 *
 * Prints a table per suite, writes eval/reports/<timestamp>.{json,md}, compares with
 * eval/baselines/<suite>.json and exits 1 on regressions. `--update` accepts the current results as
 * the new baseline, but refuses while there are regressions unless `--accept-regressions "<reason>"`
 * is given (the reason is stored in the baseline). `--split dev|heldout` selects a subset in suites
 * that have one (disfluency); such runs never update baselines.
 *
 * A matrix run repeats the selected suites once per profile (a named set of env overrides such as
 * AI_MODEL / TRANSCRIPTION_MODEL), meters every model call (latency, tokens, cost, failures) and
 * ends with one comparison table per suite. Profiles are never compared with the baselines; the
 * baselines describe the default .env. See docs/EVALS.md.
 */
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, type Config } from "../config.js";
import { createLogger } from "../log.js";
import { createAi } from "../ai/registry.js";
import { compare, describeInterval, exec, findEvalRoot, fmt, makeCache, type Baseline, type CaseResult, type EvalContext, type SummaryMetric } from "./framework.js";
import { createMeter, meteredModel, type MeterSummary } from "./meter.js";
import { parseProfiles, type Profile } from "./profiles.js";
import { suites } from "./suites/index.js";

const BOOL_FLAGS = new Set(["offline", "update", "verbose", "list", "no-cache"]);
const argv = process.argv.slice(2);
const valuesOf = (name: string) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? [argv[i + 1]!] : []));
const valueOf = (name: string) => valuesOf(name)[0];
const has = (name: string) => argv.includes(`--${name}`);
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--") && !BOOL_FLAGS.has(argv[i - 1]!.slice(2))));

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

const log = createLogger({ LOG_LEVEL: has("verbose") ? "debug" : process.env.EVAL_LOG_LEVEL || "warn", LOG_FORMAT: "auto" }, { role: "eval" });

interface SuiteReport {
  profile: string;
  suite: string;
  results: CaseResult[];
  metrics: Record<string, SummaryMetric>;
  regressions: string[];
  improvements: string[];
  ms: number;
  skipped?: string;
  meter: { llm: MeterSummary; stt: MeterSummary };
}

async function main() {
  if (has("list")) {
    for (const s of suites) console.log(`${s.name.padEnd(14)} needs: ${s.needs.join(", ") || "nothing"}\n${" ".repeat(14)} ${s.description}`);
    return;
  }
  const offline = has("offline");
  const update = has("update");
  const acceptReason = valueOf("accept-regressions")?.trim() || undefined;
  if (has("accept-regressions") && !acceptReason) throw new Error('--accept-regressions needs a reason: --accept-regressions "why these regressions are fine"');
  if (acceptReason && !update) throw new Error("--accept-regressions only makes sense with --update");
  const noCache = has("no-cache");
  const selected = positional.length ? suites.filter((s) => positional.includes(s.name)) : suites;
  const unknown = positional.filter((p) => !suites.some((s) => s.name === p));
  if (unknown.length) throw new Error(`unknown suite(s): ${unknown.join(", ")}; known: ${suites.map((s) => s.name).join(", ")}`);

  const profiles = parseProfiles({ matrix: valueOf("matrix"), profiles: valueOf("profiles"), set: valuesOf("set") });
  const matrix = profiles.length > 0;
  if (matrix && update) throw new Error("--update records the default .env configuration; it cannot be combined with --matrix / --set");
  if (!matrix) profiles.push({ name: "default", env: {} });
  if (matrix && noCache) console.log("--no-cache: model calls are not served from eval/.cache (timings are real; results are still stored)");

  // sanitise process.env once (empty strings → unset) so profile copies start clean
  loadConfig(process.env);

  const cacheDir = path.join(root, ".cache");
  const report: SuiteReport[] = [];
  let failed = false;
  for (const profile of profiles) {
    if (matrix) process.stdout.write(`\n━━ profile ${profile.name}: ${Object.entries(profile.env).map(([k, v]) => `${k}=${v}`).join(" ") || "(no overrides)"}\n`);
    let config: Config | undefined;
    const getConfig = () => (config ??= loadConfig({ ...process.env, ...profile.env }));
    const meter = createMeter();
    const ai = createAi(getConfig(), log.child({ module: "ai", profile: profile.name }));
    const ctx: EvalContext = {
      root,
      fixtures: (suite) => path.join(root, "fixtures", suite),
      cacheDir,
      offline,
      verbose: has("verbose"),
      opt: (name) => valueOf(name),
      profile: profile.name,
      config: getConfig,
      ai: { ...ai, languageModel: async (id) => meteredModel(meter, await ai.languageModel(id)) },
      meter,
      log,
      cached: makeCache(cacheDir, !noCache),
      exec,
    };

    for (const s of selected) {
      process.stdout.write(`\n▶ ${s.name}: ${s.description}\n`);
      const empty = { llm: meter.summary("llm"), stt: meter.summary("stt") };
      if (offline && (s.needs.includes("models") || s.needs.includes("network"))) {
        console.log(`  skipped (--offline; needs ${s.needs.join(", ")})`);
        report.push({ profile: profile.name, suite: s.name, results: [], metrics: {}, regressions: [], improvements: [], ms: 0, skipped: "offline", meter: empty });
        continue;
      }
      meter.mark();
      const t0 = Date.now();
      let results: CaseResult[];
      try {
        results = await s.run(ctx);
      } catch (err) {
        results = [{ id: "(suite)", pass: false, notes: `suite crashed: ${(err as Error).message}` }];
      }
      const ms = Date.now() - t0;
      // a suite whose every case was skipped measured nothing: no metrics, so nothing to "regress"
      const ran = results.filter((r) => !r.skipped);
      const metrics = s.summarize && ran.length ? s.summarize(ran) : {};
      const meterSummary = { llm: meter.summary("llm"), stt: meter.summary("stt") };
      // baselines describe the default configuration only
      const basePath = path.join(root, "baselines", `${s.name}${offline && s.offlineBaseline ? ".offline" : ""}.json`);
      const baseline = !matrix && existsSync(basePath) ? (JSON.parse(await fs.readFile(basePath, "utf8")) as Baseline) : null;
      const cmp = compare(baseline, results, metrics);
      printTable(results);
      for (const [k, m] of Object.entries(metrics)) {
        const ci = describeInterval(m);
        console.log(`  ${k.padEnd(28)} ${fmt(m.value)}${ci ? `  ${ci}` : ""}${baseline?.metrics[k] ? `  (baseline ${fmt(baseline.metrics[k]!.value)})` : ""}`);
      }
      const calls = describeMeter(meterSummary);
      if (calls) console.log(`  ${"calls".padEnd(28)} ${calls}`);
      for (const r of cmp.regressions) console.log(`  ✗ REGRESSION ${r}`);
      for (const r of cmp.improvements) console.log(`  ✓ improved ${r}`);
      if (!baseline && !matrix) console.log(`  (no baseline yet; run with --update to record one)`);
      console.log(`  ${(ms / 1000).toFixed(1)}s`);
      const accepting = update && cmp.regressions.length > 0 && acceptReason !== undefined;
      if (cmp.regressions.length && !accepting) failed = true;
      if (update && cmp.regressions.length && !accepting) {
        console.log(`  ✗ baseline NOT updated: ${cmp.regressions.length} regression(s) above. Fix them, or record them on purpose with --accept-regressions "<reason>" (the reason is stored in the baseline).`);
      } else if (update && has("split")) {
        console.log("  baseline NOT updated: --split runs score a subset; rerun without --split to update");
      } else if (update && !ran.length) {
        console.log("  baseline NOT updated: every case was skipped");
      } else if (update) {
        const at = new Date().toISOString();
        const accepted = cmp.regressions.map((r) => {
          const m = /^case (\S+)/.exec(r);
          return m ? { id: m[1]!, reason: acceptReason!, at } : { metric: r.split(" ")[0]!, reason: acceptReason!, at };
        });
        const next: Baseline = {
          updatedAt: at,
          ...(accepted.length || baseline?.acceptedRegressions?.length ? { acceptedRegressions: [...(baseline?.acceptedRegressions ?? []), ...accepted] } : {}),
          // skipped cases keep their previous state so an offline run never erases them
          cases: { ...(baseline?.cases ?? {}), ...Object.fromEntries(results.filter((r) => !r.skipped && r.id !== "(suite)").map((r) => [r.id, r.pass])) },
          metrics: { ...(baseline?.metrics ?? {}), ...metrics },
        };
        await fs.mkdir(path.dirname(basePath), { recursive: true });
        await fs.writeFile(basePath, JSON.stringify(next, null, 2) + "\n");
        console.log(`  baseline updated: ${path.relative(path.dirname(root), basePath)}`);
      }
      report.push({ profile: profile.name, suite: s.name, results, metrics, ...cmp, ms, meter: meterSummary });
    }
  }

  if (matrix) {
    console.log("\n━━ comparison");
    for (const s of selected) {
      const rows = report.filter((r) => r.suite === s.name && !r.skipped);
      if (!rows.length) continue;
      console.log(`\n${s.name}`);
      printComparison(rows);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const repDir = path.join(root, "reports");
  await fs.mkdir(repDir, { recursive: true });
  const json = JSON.stringify({ at: new Date().toISOString(), offline, noCache, profiles, report }, null, 2);
  await fs.writeFile(path.join(repDir, `${stamp}.json`), json);
  await fs.writeFile(path.join(repDir, `${stamp}.md`), markdown(report, profiles, matrix));
  const jsonOut = valueOf("json");
  if (jsonOut) await fs.writeFile(path.resolve(jsonOut), json);
  console.log(`\nreport: ${path.relative(process.cwd(), path.join(repDir, `${stamp}.md`))}`);
  if (failed) {
    console.log("✗ regressions found");
    process.exitCode = 1;
  }
}

const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
const tokens = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const usd = (n: number | undefined) => (n === undefined ? "" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`);

/** One line: "llm 12 (p50 1.20s, p95 3.4s, 12k in / 1.1k out, $0.012, 1 failed) · stt 4 (p50 2.1s, 18.0x realtime)" */
function describeMeter(m: { llm: MeterSummary; stt: MeterSummary }): string {
  const parts: string[] = [];
  if (m.llm.calls) {
    const bits = [`p50 ${secs(m.llm.p50Ms)}`, `p95 ${secs(m.llm.p95Ms)}`, `${tokens(m.llm.inputTokens)} in / ${tokens(m.llm.outputTokens)} out`];
    if (m.llm.costUsd !== undefined) bits.push(usd(m.llm.costUsd));
    if (m.llm.errors) bits.push(`${m.llm.errors} failed`);
    parts.push(`llm ${m.llm.calls} (${bits.join(", ")})`);
  }
  if (m.stt.calls) {
    const bits = [`p50 ${secs(m.stt.p50Ms)}`];
    if (m.stt.sttRealtimeFactor !== undefined) bits.push(`${m.stt.sttRealtimeFactor}x realtime`);
    if (m.stt.costUsd !== undefined) bits.push(usd(m.stt.costUsd));
    if (m.stt.errors) bits.push(`${m.stt.errors} failed`);
    parts.push(`stt ${m.stt.calls} (${bits.join(", ")})`);
  }
  return parts.join(" · ");
}

/** Columns shared by every row of a suite comparison: pass rate, the suite's summary metrics, then speed and cost. */
function comparisonColumns(rows: SuiteReport[]): Array<{ head: string; cell: (r: SuiteReport) => string }> {
  const metricKeys = [...new Set(rows.flatMap((r) => Object.keys(r.metrics)))];
  const anyLlm = rows.some((r) => r.meter.llm.calls);
  const anyStt = rows.some((r) => r.meter.stt.calls);
  const anyCost = rows.some((r) => r.meter.llm.costUsd !== undefined || r.meter.stt.costUsd !== undefined);
  const cols: Array<{ head: string; cell: (r: SuiteReport) => string }> = [
    { head: "profile", cell: (r) => r.profile },
    { head: "pass", cell: (r) => `${r.results.filter((x) => x.pass && !x.skipped).length}/${r.results.filter((x) => !x.skipped).length}` },
    ...metricKeys.map((k) => ({ head: k, cell: (r: SuiteReport) => (r.metrics[k] ? fmt(r.metrics[k]!.value) : "") })),
    { head: "wall", cell: (r) => secs(r.ms) },
  ];
  if (anyLlm) cols.push({ head: "llm calls", cell: (r) => (r.meter.llm.calls ? `${r.meter.llm.calls}${r.meter.llm.errors ? ` (${r.meter.llm.errors} failed)` : ""}` : "cached") }, { head: "llm p50", cell: (r) => (r.meter.llm.calls ? secs(r.meter.llm.p50Ms) : "") }, { head: "llm p95", cell: (r) => (r.meter.llm.calls ? secs(r.meter.llm.p95Ms) : "") }, { head: "tokens in/out", cell: (r) => (r.meter.llm.calls ? `${tokens(r.meter.llm.inputTokens)}/${tokens(r.meter.llm.outputTokens)}` : "") });
  if (anyStt) cols.push({ head: "stt calls", cell: (r) => (r.meter.stt.calls ? `${r.meter.stt.calls}${r.meter.stt.errors ? ` (${r.meter.stt.errors} failed)` : ""}` : "cached") }, { head: "stt p50", cell: (r) => (r.meter.stt.calls ? secs(r.meter.stt.p50Ms) : "") }, { head: "x realtime", cell: (r) => (r.meter.stt.sttRealtimeFactor !== undefined ? String(r.meter.stt.sttRealtimeFactor) : "") });
  if (anyCost) cols.push({ head: "cost", cell: (r) => usd(r.meter.llm.costUsd === undefined && r.meter.stt.costUsd === undefined ? undefined : (r.meter.llm.costUsd ?? 0) + (r.meter.stt.costUsd ?? 0)) });
  return cols;
}

function printComparison(rows: SuiteReport[]) {
  const cols = comparisonColumns(rows);
  const cells = rows.map((r) => cols.map((c) => c.cell(r)));
  const w = cols.map((c, i) => Math.min(40, Math.max(c.head.length, ...cells.map((r) => r[i]!.length))));
  console.log("  " + cols.map((c, i) => c.head.padEnd(w[i]!)).join("  "));
  for (const r of cells) console.log("  " + r.map((x, i) => x.slice(0, w[i]).padEnd(w[i]!)).join("  "));
}

function printTable(results: CaseResult[]) {
  const metricKeys = [...new Set(results.flatMap((r) => Object.keys(r.metrics ?? {})))].slice(0, 6);
  const head = ["case", "result", ...metricKeys, "notes"];
  const rows = results.map((r) => [r.id, r.skipped ? "skip" : r.pass ? "pass" : "FAIL", ...metricKeys.map((k) => fmt(r.metrics?.[k] ?? "")), (r.skipped ?? r.notes ?? "").replace(/\s+/g, " ")]);
  const w = head.map((h, i) => Math.min(i === head.length - 1 ? 90 : 34, Math.max(h.length, ...rows.map((r) => r[i]!.length))));
  console.log("  " + head.map((h, i) => h.padEnd(w[i]!)).join("  "));
  for (const r of rows) console.log("  " + r.map((x, i) => x.slice(0, w[i]).padEnd(w[i]!)).join("  "));
}

function markdown(report: SuiteReport[], profiles: Profile[], matrix: boolean) {
  const out = [`# Eval report ${new Date().toISOString()}`, ""];
  if (matrix) {
    out.push("## Profiles", "", "| profile | overrides |", "|---|---|");
    for (const p of profiles) out.push(`| ${p.name} | ${Object.entries(p.env).map(([k, v]) => `\`${k}=${v}\``).join(" ") || "(none)"} |`);
    out.push("", "## Comparison", "");
    for (const suite of [...new Set(report.map((r) => r.suite))]) {
      const rows = report.filter((r) => r.suite === suite && !r.skipped);
      if (!rows.length) continue;
      const cols = comparisonColumns(rows);
      out.push(`### ${suite}`, "", `| ${cols.map((c) => c.head).join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`);
      for (const r of rows) out.push(`| ${cols.map((c) => c.cell(r)).join(" | ")} |`);
      out.push("");
    }
    out.push("## Details", "");
  }
  for (const r of report) {
    out.push(`## ${matrix ? `${r.profile} · ` : ""}${r.suite}${r.skipped ? ` (skipped: ${r.skipped})` : ""}`, "");
    if (r.regressions.length) out.push(...r.regressions.map((x) => `- ✗ ${x}`), "");
    if (r.improvements.length) out.push(...r.improvements.map((x) => `- ✓ ${x}`), "");
    if (Object.keys(r.metrics).length) out.push("| metric | value | 95% interval |", "|---|---|---|", ...Object.entries(r.metrics).map(([k, m]) => `| ${k} | ${fmt(m.value)} | ${describeInterval(m).replace("95% CI ", "")} |`), "");
    const calls = describeMeter(r.meter);
    if (calls) out.push(`Calls: ${calls}`, "");
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
