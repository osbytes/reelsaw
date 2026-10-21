/** Run: node --import tsx --test test/bumper-summary.test.ts */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bumperCoverage, countBumperUsage, describeCoverage } from "../src/bumpers/summary.js";

const clip = (b?: { intro?: string | null; outro?: string | null }) => ({ bumpers: b ?? null });
const many = (n: number, b?: { intro?: string | null; outro?: string | null }) => Array.from({ length: n }, () => clip(b));

describe("bumperCoverage", () => {
  it("all clips follow the project", () => {
    const r = bumperCoverage({ settings: { introAssetId: "a", outroAssetId: "b" } }, many(3));
    assert.deepEqual(r.intro, { assetId: "a", withCount: 3, total: 3, assets: [{ assetId: "a", count: 3 }], others: [], noneCount: 0 });
    assert.deepEqual(r.outro, { assetId: "b", withCount: 3, total: 3, assets: [{ assetId: "b", count: 3 }], others: [], noneCount: 0 });
  });
  it("some clips opt out", () => {
    const clips = [...many(3), ...many(6, { outro: null })];
    const r = bumperCoverage({ settings: { outroAssetId: "qr" } }, clips);
    assert.equal(r.intro, null);
    assert.deepEqual(r.outro, { assetId: "qr", withCount: 3, total: 9, assets: [{ assetId: "qr", count: 3 }], others: [], noneCount: 6 });
    assert.equal(describeCoverage("outro", "qr", { ...r.outro!, otherCount: 0 }), "outro qr on 3/9 clips (6 none)");
  });
  it("two different assets: the most common leads", () => {
    const clips = [...many(2), ...many(3, { intro: "b" }), clip({ intro: null })];
    const r = bumperCoverage({ settings: { introAssetId: "a" } }, clips);
    assert.deepEqual(r.intro, { assetId: "b", withCount: 3, total: 6, assets: [{ assetId: "b", count: 3 }, { assetId: "a", count: 2 }], others: [{ assetId: "a", count: 2 }], noneCount: 1 });
  });
  it("clip overrides with no project default", () => {
    const r = bumperCoverage({ settings: {} }, [clip({ intro: "x" }), clip(), clip({ intro: "x" })]);
    assert.deepEqual(r.intro, { assetId: "x", withCount: 2, total: 3, assets: [{ assetId: "x", count: 2 }], others: [], noneCount: 1 });
    assert.equal(r.outro, null);
  });
  it("no clips gives null", () => {
    assert.deepEqual(bumperCoverage({ settings: { introAssetId: "a" } }, []), { intro: null, outro: null });
  });
});

describe("bumperCoverage with several assets", () => {
  it("lists every distinct asset, most used first", () => {
    const clips = [clip({ intro: "a" }), clip({ intro: "b" }), clip({ intro: "b" }), clip({ intro: "c" }), clip({ intro: "b" }), clip({ intro: "a" }), clip({ intro: null })];
    const r = bumperCoverage({ settings: {} }, clips);
    assert.deepEqual(r.intro!.assets, [{ assetId: "b", count: 3 }, { assetId: "a", count: 2 }, { assetId: "c", count: 1 }]);
    assert.equal(r.intro!.assetId, "b");
    assert.equal(r.intro!.total, 7);
    assert.equal(r.intro!.noneCount, 1);
  });
});

describe("countBumperUsage", () => {
  it("counts clips that chose the asset themselves", () => {
    const m = countBumperUsage([{ settings: {}, clips: [clip({ intro: "x" }), clip({ intro: "x" }), clip()] }]);
    assert.deepEqual(m.get("x"), { projects: 1, clips: 2 });
  });
  it("a project whose every clip opts out does not use the asset", () => {
    const m = countBumperUsage([{ settings: { introAssetId: "a" }, clips: many(3, { intro: null }) }]);
    assert.equal(m.get("a"), undefined);
  });
  it("a project with no clips counts through its settings", () => {
    const m = countBumperUsage([{ settings: { introAssetId: "a", outroAssetId: "a" }, clips: [] }]);
    assert.deepEqual(m.get("a"), { projects: 1, clips: 0 });
  });
  it("a clip using the asset in both slots counts once; projects sum", () => {
    const m = countBumperUsage([
      { settings: { introAssetId: "a", outroAssetId: "a" }, clips: many(2) },
      { settings: { outroAssetId: "a" }, clips: [clip(), clip({ outro: "b" })] },
    ]);
    assert.deepEqual(m.get("a"), { projects: 2, clips: 3 });
    assert.deepEqual(m.get("b"), { projects: 1, clips: 1 });
  });
  it("overlays and music tracks count, the same track twice counts once, an old one-object audio row is read", () => {
    const m = countBumperUsage([
      { settings: {}, clips: [{ bumpers: null, overlays: [{ assetId: "logo" }, { assetId: null }], audio: [{ id: "m1", assetId: "song", start: 0, end: 5 }, { id: "m2", assetId: "song", start: 5, end: 9 }] }, { bumpers: null, audio: { assetId: "song", start: 0, end: 5 } }] },
      { settings: { introAssetId: "logo" }, clips: [clip(), { bumpers: null, overlays: [{ assetId: "logo" }] }] },
    ]);
    assert.deepEqual(m.get("logo"), { projects: 2, clips: 3 });
    assert.deepEqual(m.get("song"), { projects: 1, clips: 2 });
  });
});
