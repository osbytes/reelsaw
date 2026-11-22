#!/usr/bin/env node
// The duplication ledger ("Generalise on the third use", docs/PRINCIPLES.md). Code that copies or
// mirrors existing code on purpose says so at the copy with a comment naming the original:
//
//   // dup-of: apps/server/src/clips/export.ts#buildManifest
//
// This script groups those markers by target. Uses = markers + the original, so two markers on
// one target is the third use: time to merge them, or to add a `dup-ok: <reason>` comment on the
// same line or the line after a marker saying why they stay apart. A marker whose path no longer
// exists is stale.
//
//   node scripts/dup-ledger.mjs           report
//   node scripts/dup-ledger.mjs --check   exit 1 when a target is due or a marker is stale
//   node scripts/dup-ledger.mjs --json    machine-readable, for the audit journal
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const DUE_AT_USES = 3;
// the path must contain a slash or a dot, so prose that mentions "dup-of:" is not a marker
const MARKER = /dup-of:\s*([\w@.-]*[/.][\w@./-]*)(?:#([\w$.-]+))?/;
const WAIVER = /dup-ok:\s*\S/;
const TEXT_FILE = /\.(c|m)?(j|t)sx?$|\.(css|sql|ya?ml|sh|py)$/;

const args = new Set(process.argv.slice(2));
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => TEXT_FILE.test(f) && !f.endsWith("dup-ledger.mjs"));

/** @type {Map<string, { path: string, copies: { at: string, waived: boolean }[] }>} */
const targets = new Map();

for (const file of files) {
  if (!existsSync(file)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    const m = MARKER.exec(line);
    if (!m) return;
    const [, path, symbol] = m;
    const key = symbol ? `${path}#${symbol}` : path;
    const entry = targets.get(key) ?? { path, copies: [] };
    entry.copies.push({ at: `${file}:${i + 1}`, waived: WAIVER.test(line) || WAIVER.test(lines[i + 1] ?? "") });
    targets.set(key, entry);
  });
}

const report = [...targets.entries()]
  .map(([key, t]) => {
    const uses = t.copies.length + 1;
    const waived = t.copies.some((c) => c.waived);
    return { key, uses, due: uses >= DUE_AT_USES && !waived, waived, stale: !existsSync(t.path), copies: t.copies.map((c) => c.at) };
  })
  .sort((a, b) => b.uses - a.uses);

if (args.has("--json")) {
  console.log(JSON.stringify({ targets: report.length, due: report.filter((r) => r.due).length, report }, null, 2));
} else if (report.length === 0) {
  console.log("dup-ledger: no dup-of markers");
} else {
  for (const r of report) {
    const state = r.stale ? "STALE (target missing)" : r.due ? `DUE (${r.uses} uses)` : r.waived ? `waived (${r.uses} uses)` : `${r.uses} uses`;
    console.log(`${state}  ${r.key}`);
    for (const at of r.copies) console.log(`    ${at}`);
  }
}

const failing = report.filter((r) => r.due || r.stale);
if (args.has("--check") && failing.length > 0) {
  console.error(`dup-ledger: ${failing.length} target(s) due or stale. Merge them, or add a dup-ok: reason.`);
  process.exit(1);
}
