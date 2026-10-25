#!/usr/bin/env node
/**
 * Cross-platform runners for lefthook.yml. Git for Windows invokes hooks through `sh -c "…"`,
 * which breaks bash `{ echo; exit 0; }` and nested quotes (`command -v` skip). Node spawn is the
 * same on Windows, macOS and Linux: missing binary → skip with a note; otherwise forward the exit.
 *
 *   node scripts/hook.mjs optional gitleaks git --pre-commit --staged --redact --no-banner .
 *   node scripts/hook.mjs signoff .git/COMMIT_EDITMSG
 */
import { spawnSync } from "node:child_process";

const [kind, ...rest] = process.argv.slice(2);

function run(bin, args, opts = {}) {
  return spawnSync(bin, args, { stdio: "inherit", windowsHide: true, ...opts });
}

function missing(result) {
  return Boolean(result.error && (result.error.code === "ENOENT" || result.error.code === "EINVAL"));
}

if (kind === "optional") {
  const [bin, ...args] = rest;
  if (!bin) {
    console.error("usage: node scripts/hook.mjs optional <bin> [args…]");
    process.exit(2);
  }
  const result = run(bin, args);
  if (missing(result)) {
    console.log(`${bin} not installed: this check is skipped. CI still runs it.`);
    process.exit(0);
  }
  process.exit(result.status ?? 1);
}

if (kind === "signoff") {
  const file = rest[0];
  if (!file) {
    console.error("usage: node scripts/hook.mjs signoff <commit-message-file>");
    process.exit(2);
  }
  const name = spawnSync("git", ["config", "user.name"], { encoding: "utf8", windowsHide: true });
  const email = spawnSync("git", ["config", "user.email"], { encoding: "utf8", windowsHide: true });
  const who = name.stdout.trim();
  const addr = email.stdout.trim();
  if (!who || !addr) {
    console.error("git user.name and user.email must be set for the DCO trailer");
    process.exit(1);
  }
  const result = run("git", [
    "interpret-trailers",
    "--in-place",
    "--if-exists",
    "addIfDifferent",
    "--trailer",
    `Signed-off-by: ${who} <${addr}>`,
    file,
  ]);
  if (missing(result)) {
    console.error("git not installed");
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

console.error("usage: node scripts/hook.mjs optional <bin> [args…] | signoff <commit-message-file>");
process.exit(2);
