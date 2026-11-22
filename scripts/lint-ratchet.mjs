#!/usr/bin/env node
// Lint ratchet: per-rule counts of the Biome diagnostics that are not errors yet, of Knip's unused exports and
// types (knip.json), and of user-facing literals in the web app (i18n/*, scripts/i18n-literals.mjs), may only go
// down. Knip's other kinds (unused files, dependencies, unlisted imports) and i18n/physical-css have a baseline of
// 0, so any new one fails.
// biome.json keeps a rule at "warn" while old code still breaks it (or "off" with the rule listed in
// TRACKED below); this script fails CI when any count rises above scripts/lint-baseline.json, and
// when one falls below it, so the baseline is lowered in the same change that removed the
// violations. A rule whose count reaches 0 moves to "error" in biome.json and leaves the baseline.
//
//   node scripts/lint-ratchet.mjs            check against the baseline
//   node scripts/lint-ratchet.mjs --update   rewrite the baseline (only ever to lower it, in review)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { i18nFindings } from "./i18n-literals.mjs";

const BASELINE = "scripts/lint-baseline.json";
// rules off in biome.json because old code breaks them too often to show as warnings, counted here
const TRACKED = ["style/noNonNullAssertion"];
const BIOME = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
const KNIP = fileURLToPath(new URL("../node_modules/knip/bin/knip.js", import.meta.url)); // knip exports no subpaths

function diagnostics(extra) {
  let out;
  try {
    // the package's Node launcher, so no shell or .cmd shim is involved on Windows
    out = execFileSync(process.execPath, [BIOME, "lint", "--reporter=json", "--max-diagnostics=none", "--colors=off", ...extra], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    out = e.stdout; // biome exits non-zero when there are errors; the report is still on stdout
  }
  return JSON.parse(out).diagnostics ?? [];
}

const counts = {};
const add = (d) => {
  if (d.severity === "error" || !d.category?.startsWith("lint/")) return;
  const rule = d.category.slice("lint/".length);
  counts[rule] = (counts[rule] ?? 0) + 1;
};
for (const d of diagnostics([])) add(d);
for (const rule of TRACKED) for (const d of diagnostics([`--only=${rule}`])) if (d.category === `lint/${rule}`) add(d);

// Knip: unused files, dependencies, exports and types (knip.json says what is an entry point)
function knip() {
  let out;
  try {
    out = execFileSync(process.execPath, [KNIP, "--reporter", "json", "--no-progress", "--no-exit-code"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (e) {
    out = e.stdout;
  }
  return JSON.parse(out);
}
const k = knip();
if (k.files?.length) counts["knip/files"] = k.files.length;
for (const issue of k.issues ?? [])
  for (const [kind, v] of Object.entries(issue)) {
    const n = Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0;
    if (n && kind !== "file") counts[`knip/${kind}`] = (counts[`knip/${kind}`] ?? 0) + n;
  }

// strings and layout that bypass internationalisation in the web app (scripts/i18n-literals.mjs, docs/I18N.md)
for (const f of i18nFindings()) counts[f.kind] = (counts[f.kind] ?? 0) + 1;

const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
if (process.argv.includes("--update")) {
  writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`lint-ratchet: wrote ${BASELINE}`);
  process.exit(0);
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
const problems = [];
for (const rule of new Set([...Object.keys(baseline), ...Object.keys(sorted)])) {
  const was = baseline[rule] ?? 0;
  const now = sorted[rule] ?? 0;
  const find = rule.startsWith("i18n/") ? "node scripts/i18n-literals.mjs --list" : rule.startsWith("knip/") ? "pnpm exec knip" : `biome lint --only=${rule}`;
  if (now > was) problems.push(`${rule}: ${now} (baseline ${was}). New code must not add these; fix them (${find} lists them).`);
  else if (now < was) problems.push(`${rule}: ${now}, below the baseline ${was}. Lower it: node scripts/lint-ratchet.mjs --update`);
}
if (problems.length) {
  console.error(`lint-ratchet:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`lint-ratchet: ok (${Object.values(sorted).reduce((a, b) => a + b, 0)} old findings across ${Object.keys(sorted).length} rules)`);
