/**
 * Bundled assets are found relative to the code (lib/assets.ts), never from the working directory: the image runs
 * from /app with the assets at /app/server/assets, so a `process.cwd()` path works in tests and `pnpm dev` and is
 * missing in production (the word-timestamp clip failed every boot that way).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bundledAssetPath } from "../src/lib/assets.js";

function* sources(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (p.endsWith(".ts")) yield p;
  }
}

describe("bundled assets", () => {
  it("no source file builds an assets path from the working directory", () => {
    const offenders: string[] = [];
    for (const f of sources(path.resolve("src"))) {
      if (f.endsWith(path.join("lib", "assets.ts"))) continue;
      if (/process\.cwd\(\)[^;\n]*["'`]assets\b/.test(fs.readFileSync(f, "utf8"))) offenders.push(path.relative(process.cwd(), f));
    }
    assert.deepEqual(offenders, [], "use bundledAssetPath (lib/assets.ts)");
  });

  it("finds the word-timestamp clip, the catalog and the watermark", () => {
    for (const rel of ["probe/word-timestamps.mp3", "catalog/index.json", "watermark.png"]) assert.ok(fs.existsSync(bundledAssetPath(rel)), rel);
  });
});
