#!/usr/bin/env node
// Fail when a vendor-specific agent file or folder is tracked. The repo stays agent agnostic
// (docs/PRINCIPLES.md, "One agent context"): AGENTS.md for instructions, .agents/ for skills.
// A tool that needs its own file gets a local, untracked pointer to AGENTS.md.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const VENDOR =
  /(^|\/)(CLAUDE\.md|GEMINI\.md|\.cursorrules|\.windsurfrules|\.clinerules|\.github\/copilot-instructions\.md)$|(^|\/)\.(claude|cursor|codex|windsurf|gemini|aider|continue|roo|cline)(\/|$)/;

const found = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => VENDOR.test(f));
if (found.length) {
  console.error(`Vendor-specific agent files are tracked. Use AGENTS.md and .agents/ instead:\n  ${found.join("\n  ")}`);
  process.exit(1);
}
if (!existsSync("AGENTS.md")) {
  console.error("AGENTS.md is missing");
  process.exit(1);
}
console.log("agent files ok");
