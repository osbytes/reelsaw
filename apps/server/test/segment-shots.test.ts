/**
 * Segmenting follows the source's cutting: a detected scene cut may bound a piece as short as
 * MIN_SHOT_SEC, smoothing never reads across a cut, and a shot with three or more people of comparable
 * size is shown whole (fit) rather than split between two of them. No database needed.
 * Run: node --import tsx --test test/segment-shots.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideLayout, segmentLayouts, fitTextHeavy, staticDecision, MIN_SHOT_SEC, type FaceSample, type ResolvedSegment } from "../src/pipeline/layout.js";
import type { FaceBox } from "../src/vision/faces.js";

const config = { LAYOUT_MIN_FACE_RATIO: 0.6, LAYOUT_MIN_FACE_SIZE: 0.18, srcAspect: 16 / 9 };
const box = (cx: number, h: number): FaceBox => ({ x1: cx - h * 0.35, x2: cx + h * 0.35, y1: 0.3, y2: 0.3 + h, score: 0.99 });
/** 4 fps samples over [from, to) with the given boxes (largest first, as the detector sorts them) */
function shot(from: number, to: number, boxes: FaceBox[]): FaceSample[] {
  const out: FaceSample[] = [];
  for (let t = from; t < to - 1e-9; t += 0.25) out.push({ t: Number(t.toFixed(2)), box: boxes[0] ?? null, boxes });
  return out;
}
const closeUp = [box(0.47, 0.36)];
const couch = [box(0.22, 0.14), box(0.73, 0.12), box(0.57, 0.11)];
const twoShot = [box(0.31, 0.2), box(0.67, 0.2)];
const layouts = (segs: ReturnType<typeof segmentLayouts>) => segs.map((s) => `${s.decision.layout} ${s.start}-${s.end}`);

describe("decideLayout with three or more people", () => {
  it("shows a couch shot whole instead of splitting two of the three", () => {
    const d = decideLayout(shot(0, 4, couch), config);
    assert.equal(d.layout, "fit");
    assert.match(d.reason, /3 people across the frame/);
  });
  it("still splits a two-shot, and a two-shot with a small onlooker", () => {
    assert.equal(decideLayout(shot(0, 4, twoShot), config).layout, "split");
    assert.equal(decideLayout(shot(0, 4, [...twoShot, box(0.5, 0.05)]), config).layout, "split");
  });
});

describe("segmentLayouts at scene cuts", () => {
  // close-up 0-3, wide couch 3-4.2, close-up 4.2-8, hosts two-shot 8-9.1, close-up 9.1-12
  const samples = [...shot(0, 3, closeUp), ...shot(3, 4.25, couch), ...shot(4.25, 8, closeUp), ...shot(8, 9.25, twoShot), ...shot(9.25, 12, closeUp)];
  const cuts = [3, 4.2, 8, 9.1];

  it("gives every shot its own piece, down to MIN_SHOT_SEC, when the cuts are known", () => {
    assert.ok(MIN_SHOT_SEC <= 1.2);
    const segs = segmentLayouts(samples, config, cuts, 12);
    assert.deepEqual(layouts(segs), ["face 0-3", "fit 3-4.2", "face 4.2-8", "split 8-9.1", "face 9.1-12"]);
    assert.equal(segs[1]!.decision.layout, "fit");
    assert.ok((segs[3]!.decision.track2?.length ?? 0) > 0, "the two-shot piece carries a second track");
  });

  it("folds the same short shots into their neighbours when no cut is known (a flicker, not an edit)", () => {
    const segs = segmentLayouts(samples, config, [], 12);
    assert.deepEqual(layouts(segs), ["face 0-12"]);
  });

  it("does not hold a split across a cut into a one-person close-up", () => {
    // two-shot 0-4, cut, close-up 4-6 (shorter than minSeg but a real shot): the close-up is a face piece
    const s = [...shot(0, 4, twoShot), ...shot(4, 6, closeUp)];
    const segs = segmentLayouts(s, config, [4], 6);
    assert.deepEqual(layouts(segs), ["split 0-4", "face 4-6"]);
  });
});

describe("fitTextHeavy keeps one-shot pieces", () => {
  const seg = (layout: "fit" | "split" | "face", start: number, end: number): ResolvedSegment => ({ start, end, manual: false, decision: staticDecision(layout, layout) });
  it("leaves a short piece that no text run touches alone", () => {
    const out = fitTextHeavy([seg("face", 0, 3.5), seg("split", 3.5, 4.6), seg("fit", 4.6, 6)], [[0, 1.6]]);
    assert.deepEqual(out.map((s) => `${s.decision.layout} ${s.start}-${s.end}`), ["fit 0-1.6", "face 1.6-3.5", "split 3.5-4.6", "fit 4.6-6"]);
  });
  it("still folds the sliver left after a run into that run", () => {
    const out = fitTextHeavy([seg("face", 0, 6), seg("face", 6, 10)], [[2, 5]]);
    assert.deepEqual(out.map((s) => `${s.decision.layout} ${s.start}-${s.end}`), ["face 0-2", "fit 2-6", "face 6-10"]);
  });
});
