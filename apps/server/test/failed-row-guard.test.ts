/**
 * A project or clip becomes failed only with its cause (failedRow in pipeline/common.ts, or an explicit failureCause
 * next to the status): a write that leaves the cause out reads as platform, and the Failed work list then offers
 * Retry for a failure it cannot fix. Scans the source for `status: … "failed"` and checks each one.
 * node --import tsx --test test/failed-row-guard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = path.join(import.meta.dirname, "..", "src");

/** Files whose `status: "failed"` is not a project or clip row, with what it is. */
const OTHER_TABLES: Record<string, string> = {
  "pipeline/refine.ts": "a refine step's status in the transcript's refine map",
  "pipeline/steps.ts": "a stage step row (stage_steps)",
  "webhooks/deliver.ts": "a webhook delivery",
  "dev/scenarios.ts": "a scenario spec; the insert sets failureCause from it",
};

/** Single lines that are not a row write either: `file: trimmed line` → what it is. */
const OTHER_LINES: Record<string, string> = {
  'report/import.ts: status: terminal ? project.status : "failed",': "the import summary printed to the operator, not the row",
};

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}

describe("failed project and clip rows carry their cause", () => {
  it('every status: … "failed" write sets failureCause beside it, or is another table', () => {
    const bare: string[] = [];
    for (const file of files(src)) {
      const rel = path.relative(src, file).split(path.sep).join("/");
      if (rel in OTHER_TABLES) continue;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/status:\s*[^,\n]*"failed"/.test(line) || line.trim().startsWith("*") || line.trim().startsWith("//")) return;
        if (/\|\s*"failed"|"failed"\s*\|/.test(line)) return; // a type union, not a value
        if (`${rel}: ${line.trim()}` in OTHER_LINES) return;
        // the cause sits on the same line (failedRow) or within the next few properties of the same object
        if (!lines.slice(i, i + 5).some((l) => l.includes("failureCause"))) bare.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(bare, [], "use failedRow(err) (pipeline/common.ts), or set failureCause next to the status");
  });
});
