/**
 * packages/shared/src/index.ts builds schemas from what it imports (createProjectInputSchema from ranges.ts's
 * rangeSchema) when it loads. A module it imports values from must not import index.ts back: in the bundled server the
 * cycle loads index first and the value is still undefined ("Cannot read properties of undefined (reading '_zod')",
 * every create_project refused). Such a module imports the file that defines what it needs (format.ts, …) instead.
 * node --import tsx --test test/shared-import-cycle.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const src = path.join(import.meta.dirname, "..", "..", "..", "packages", "shared", "src");
const index = fs.readFileSync(path.join(src, "index.ts"), "utf8");

describe("shared index import cycles", () => {
  it("no module index.ts imports values from imports index.ts back", () => {
    // value imports only: `import type { … }` and `export * from` do not run anything at load
    const valueImports = [...index.matchAll(/^import (?!type )[^;]*? from "\.\/([\w-]+)\.js";/gm)].flatMap((m) => (m[1] ? [m[1]] : []));
    assert.ok(valueImports.includes("ranges"), "the scan sees index.ts's imports");
    const cyclic = valueImports.filter((name) => /from "\.\/index\.js"/.test(fs.readFileSync(path.join(src, `${name}.ts`), "utf8")));
    assert.deepEqual(cyclic, [], `these import index.ts back: ${cyclic.join(", ")}`);
  });
});
