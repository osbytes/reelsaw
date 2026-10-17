/** Run: node --import tsx --test test/bumper-summary.test.ts */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bumperCoverage, describeCoverage } from "../src/bumpers/summary.js";

const clip = (b?: { intro?: string | null; outro?: string | null }) => ({ bumpers: b ?? null });
const many = (n: number, b?: { intro?: string | null; outro?: string | null }) => Array.from({ length: n }, () => clip(b));

describe("bumperCoverage", () => {
  it("all clips follow the project", () => {
    const r = bumperCoverage({ settings: { introAssetId: "a", outroAssetId: "b" } }, many(3));
    assert.deepEqual(r.intro, { assetId: "a", withCount: 3, total: 3, others: [], noneCount: 0 });
    assert.deepEqual(r.outro, { assetId: "b", withCount: 3, total: 3, others: [], noneCount: 0 });
  });
  it("some clips opt out", () => {
    const clips = [...many(3), ...many(6, { outro: null })];
    const r = bumperCoverage({ settings: { outroAssetId: "qr" } }, clips);
    assert.equal(r.intro, null);
    assert.deepEqual(r.outro, { assetId: "qr", withCount: 3, total: 9, others: [], noneCount: 6 });
    assert.equal(describeCoverage("outro", "qr", { ...r.outro!, otherCount: 0 }), "outro qr on 3/9 clips (6 none)");
  });
  it("two different assets: the most common leads", () => {
    const clips = [...many(2), ...many(3, { intro: "b" }), clip({ intro: null })];
    const r = bumperCoverage({ settings: { introAssetId: "a" } }, clips);
    assert.deepEqual(r.intro, { assetId: "b", withCount: 3, total: 6, others: [{ assetId: "a", count: 2 }], noneCount: 1 });
  });
  it("clip overrides with no project default", () => {
    const r = bumperCoverage({ settings: {} }, [clip({ intro: "x" }), clip(), clip({ intro: "x" })]);
    assert.deepEqual(r.intro, { assetId: "x", withCount: 2, total: 3, others: [], noneCount: 1 });
    assert.equal(r.outro, null);
  });
  it("no clips gives null", () => {
    assert.deepEqual(bumperCoverage({ settings: { introAssetId: "a" } }, []), { intro: null, outro: null });
  });
});
