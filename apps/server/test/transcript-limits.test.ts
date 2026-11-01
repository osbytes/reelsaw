/** Bounds on jsonb that grows: deleted-flag overflow, changed-column writes, clip diagnostics. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ClipDiagnostics } from "@reelsaw/shared";
import { splitDeleted, changedColumns, capDiagnostics, DELETED_FLAGS_LIVE_CAP } from "../src/transcript-limits.js";

describe("splitDeleted", () => {
  it("keeps the newest 200 live and hands the older ones to the archive", () => {
    const list = Array.from({ length: 230 }, (_, i) => ({ id: `f${i}` }));
    const { keep, overflow } = splitDeleted(list);
    assert.equal(keep.length, DELETED_FLAGS_LIVE_CAP);
    assert.equal(keep[0]!.id, "f30");
    assert.deepEqual(
      overflow.map((f) => f.id),
      Array.from({ length: 30 }, (_, i) => `f${i}`),
    );
  });
  it("under the cap nothing moves", () => {
    assert.deepEqual(splitDeleted([{ id: "a" }]).overflow, []);
  });
});

describe("changedColumns", () => {
  it("returns only the columns whose JSON differs", () => {
    const cur = { words: [{ t: "a" }], flags: [1], text: "a" };
    assert.deepEqual(changedColumns(cur, { words: [{ t: "a" }], flags: [1, 2], text: "a" }), { flags: [1, 2] });
    assert.deepEqual(changedColumns(cur, { words: [{ t: "a" }], flags: [1], text: "a" }), {});
  });
});

describe("capDiagnostics", () => {
  const base = (over: Partial<ClipDiagnostics> = {}): ClipDiagnostics =>
    ({ renderedAt: "x", layout: {}, cuts: { applied: [], skipped: [] }, outDurationSec: 1, renderMs: 1, ...over }) as unknown as ClipDiagnostics;
  it("keeps the last 20 skipped cuts and bumper notes and trims long reasons", () => {
    const d = capDiagnostics(
      base({
        cuts: { applied: [], skipped: Array.from({ length: 30 }, (_, i) => ({ start: i, end: i + 1, reason: "r".repeat(3000) })) },
        bumpers: { introSec: 0, outroSec: 0, skipped: Array.from({ length: 25 }, (_, i) => `n${i}`) },
      }),
    );
    assert.equal(d.cuts.skipped.length, 20);
    assert.equal(d.cuts.skipped[0]!.start, 10);
    assert.equal(d.cuts.skipped[0]!.reason.length, 1500);
    assert.equal(d.bumpers!.skipped!.length, 20);
    assert.equal(d.bumpers!.skipped![0], "n5");
  });
  it("leaves diagnostics without bumpers alone", () => {
    assert.equal(capDiagnostics(base()).bumpers, undefined);
  });
});
