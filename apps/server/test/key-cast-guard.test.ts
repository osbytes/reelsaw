/**
 * `Object.keys` returns `string[]` and `Object.entries` `[string, V][]` on purpose (an object may hold more keys than
 * its type lists), so `Object.keys(x) as K[]` is a cast that stops the checker exactly where a key goes missing
 * (docs/PRINCIPLES.md, "No type ascriptions"). Objects built from a literal in our code use ts-extras' `objectKeys` /
 * `objectEntries`; anything else is parsed. Scans the apps, the shared package and the server scripts.
 * node --import tsx --test test/key-cast-guard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..", "..", "..");
const SCANNED = ["apps/server/src", "apps/server/scripts", "apps/web/src", "packages/shared/src"];
const CAST = /Object\.(?:keys|entries)\([^)]*\)\s+as\s/;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "dist" ? [] : files(p);
    return /\.(ts|tsx|mjs)$/.test(e.name) ? [p] : [];
  });
}

describe("Object.keys / Object.entries casts", () => {
  it("uses objectKeys / objectEntries instead of casting the result", () => {
    const hits = SCANNED.flatMap((d) => files(path.join(root, d))).flatMap((f) =>
      fs
        .readFileSync(f, "utf8")
        .split("\n")
        .flatMap((line, i) => (CAST.test(line) ? [`${path.relative(root, f)}:${i + 1}`] : [])),
    );
    assert.deepEqual(hits, [], "use objectKeys / objectEntries from ts-extras");
  });
});
