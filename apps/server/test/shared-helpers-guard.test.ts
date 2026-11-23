/**
 * Generic formatting lives once, in packages/shared/src/format.ts (docs/PRINCIPLES.md, "A general helper gets a
 * general name in a shared place"). Local copies drift: before this guard the code had eight `plural`s, seven
 * byte/MB formatters (two of them both called `formatBytes`, disagreeing) and six day formatters, plus 140 inline
 * "${n} clip${n === 1 ? '' : 's'}" and "clip(s)" spellings. Scans both apps for a local definition of a shared
 * helper (or a name it went by) and for the inline spellings, and checks the shared ones say what they should.
 * node --import tsx --test test/shared-helpers-guard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { formatBytes, formatDay, formatMb, plural, pluralWord, utcDay } from "@reelsaw/shared";

const root = path.join(import.meta.dirname, "..", "..", "..");
const SCANNED = ["apps/server/src", "apps/web/src"];
const shared = fs.readFileSync(path.join(root, "packages/shared/src/format.ts"), "utf8");

/** Every helper format.ts exports, and names the same helper has gone by in this repo. */
const NAMES = [
  ...[...shared.matchAll(/^export function (\w+)/gm)].map((m) => m[1]!),
  ...["pluralize", "gb", "fmtBytes", "fmtSize", "formatSize", "humanBytes", "day", "dayOf", "shortDay", "fmtDate", "formatDate"],
];
/** A function declaration, or a const bound to an arrow function: `function gb(`, `const day = (iso) =>`. */
const definition = new RegExp(
  String.raw`(?:^|\s)(?:function\s+(${NAMES.join("|")})\s*\(|const\s+(${NAMES.join("|")})\s*=\s*(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>)`,
);
/** The noun plural written inline instead of `plural`/`pluralWord`. Verb agreement ("use${n === 1 ? 's' : ''}") is not this. */
const INLINE = [
  /=== 1 \? "" : "e?s"/,
  /(?:!== 1|> 1) \? "e?s" : ""/,
  /\$\{[^}]+\} [\w-]+(?: [\w-]+)?\(s\)/,
  // the whole word both ways: `n === 1 ? "item" : "items"`, `deliver${n === 1 ? "y" : "ies"}`
  /=== 1 \? "(\w*)" : "\1(?:e?s|ies)"/,
  /=== 1 \? "y" : "ies"/,
];
/** A date written for people without formatDay: the viewer's locale and the server's fixed form both live there. */
const LOCAL_DATE = /\.toLocaleDateString\(/;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

const sources = SCANNED.flatMap((d) => files(path.join(root, d))).map((file) => ({
  rel: path.relative(root, file).split(path.sep).join("/"),
  lines: fs.readFileSync(file, "utf8").split("\n"),
}));

describe("generic helpers are shared, not local", () => {
  it("no app defines its own copy of a format.ts helper", () => {
    const local = sources.flatMap(({ rel, lines }) => lines.flatMap((l, i) => (definition.test(l) ? [`${rel}:${i + 1}: ${l.trim()}`] : [])));
    assert.deepEqual(local, [], `import these from @reelsaw/shared (packages/shared/src/format.ts) instead:\n${local.join("\n")}`);
  });

  it("no app spells a plural inline", () => {
    const inline = sources.flatMap(({ rel, lines }) =>
      lines.flatMap((l, i) => (INLINE.some((r) => r.test(l)) && !/^\s*(\*|\/\/)/.test(l) ? [`${rel}:${i + 1}: ${l.trim()}`] : [])),
    );
    assert.deepEqual(inline, [], `use plural(n, "word") or pluralWord(n, "word") from @reelsaw/shared:\n${inline.join("\n")}`);
  });

  it("no app formats a calendar day itself", () => {
    const local = sources.flatMap(({ rel, lines }) => lines.flatMap((l, i) => (LOCAL_DATE.test(l) ? [`${rel}:${i + 1}: ${l.trim()}`] : [])));
    assert.deepEqual(local, [], `use formatDay from @reelsaw/shared:\n${local.join("\n")}`);
  });

  it("the shared helpers say what their callers expect", () => {
    assert.equal(plural(1, "clip"), "1 clip");
    assert.equal(plural(0, "clip"), "0 clips");
    assert.equal(plural(1200, "minute"), "1,200 minutes");
    assert.equal(plural(2, "fix", "fixes"), "2 fixes");
    assert.equal(pluralWord(1, "clip"), "clip");
    assert.equal(pluralWord(3, "clip"), "clips");
    assert.equal(formatBytes(500), "500 B");
    assert.equal(formatBytes(18 * 1_048_576), "18 MB");
    assert.equal(formatBytes(1.4 * 1_073_741_824), "1.4 GB");
    // the unit is picked after rounding: just under a boundary is the next unit, not "1024 KB"
    assert.equal(formatBytes(1_048_575), "1 MB");
    assert.equal(formatBytes(1_073_741_000), "1 GB");
    assert.equal(formatBytes(1023.6), "1 KB");
    assert.equal(formatMb(1023.7), "1 GB");
    assert.equal(formatMb(2048), "2 GB");
    assert.equal(formatMb(10240), "10 GB");
    assert.equal(formatMb(1536), "1.5 GB");
    assert.equal(formatMb(512), "512 MB");
    assert.equal(formatMb(0), "0 MB");
    assert.equal(formatDay("2026-12-18T23:30:00Z", { utc: true }), "December 18, 2026");
    assert.equal(formatDay("2026-12-18T23:30:00Z", { utc: true, year: false }), "December 18");
    assert.equal(formatDay("2026-12-18T23:30:00Z", { utc: true, month: "short" }), "Dec 18, 2026");
    assert.equal(utcDay("2026-12-18T23:30:00Z"), "2026-12-18");
  });
});
