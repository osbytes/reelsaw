#!/usr/bin/env node
// Clone report for a pull request ("Generalise on the third use", docs/PRINCIPLES.md): runs jscpd over
// apps/ and packages/ and lists the clone pairs that touch a file this branch changed. It reports and
// never fails. A clone a reviewer accepts gets a `dup-of:` marker so scripts/dup-ledger.mjs counts it.
//
//   node scripts/clones.mjs [base]     base defaults to origin/main; writes Markdown to stdout, and to
//                                      $GITHUB_STEP_SUMMARY when set
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// the bin named in the package's own package.json (the package exports no subpaths to resolve)
const pkgDir = fileURLToPath(new URL("../node_modules/jscpd/", import.meta.url));
const JSCPD = join(pkgDir, JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).bin.jscpd);
const base = process.argv[2] ?? "origin/main";
const posix = (p) => p.replaceAll("\\", "/");
const changed = new Set(
  execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean),
);

const pairs = [];
for (const root of ["apps", "packages"]) {
  const out = mkdtempSync(join(tmpdir(), "clones-"));
  try {
    // jscpd names files relative to the path it was given, so each root runs on its own
    execFileSync(
      process.execPath,
      [
        JSCPD,
        "--min-tokens",
        "50",
        "--reporters",
        "json",
        "--output",
        out,
        "--silent",
        "--format",
        "typescript,tsx,javascript",
        "--ignore",
        "**/dist/**,**/node_modules/**",
        root,
      ],
      { stdio: "ignore" },
    );
    const report = JSON.parse(readFileSync(join(out, "jscpd-report.json"), "utf8"));
    for (const d of report.duplicates) {
      const a = `${root}/${posix(d.firstFile.name)}`;
      const b = `${root}/${posix(d.secondFile.name)}`;
      if (changed.has(a) || changed.has(b))
        pairs.push({ a: `${a}:${d.firstFile.start}-${d.firstFile.end}`, b: `${b}:${d.secondFile.start}-${d.secondFile.end}`, lines: d.lines });
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const md = pairs.length
  ? `### Clones touching changed files (${pairs.length})\n\nReport only. Merge a third use, or mark an accepted copy with \`// dup-of: <path>#<symbol>\`.\n\n| Lines | Here | And |\n| --- | --- | --- |\n${pairs
      .sort((x, y) => y.lines - x.lines)
      .map((p) => `| ${p.lines} | \`${p.a}\` | \`${p.b}\` |`)
      .join("\n")}\n`
  : "### Clones touching changed files\n\nNone.\n";
process.stdout.write(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
