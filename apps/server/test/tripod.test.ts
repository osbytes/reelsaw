/**
 * Tripod camera: it cuts, never pans, across a scene cut or a face that jumps (a cut the detector missed).
 * Run: pnpm --filter @reelsaw/server test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tripodTrack, trackBreaks, localTrack, piecewiseExpr, type FaceSample } from "../src/pipeline/layout.js";

const at = (t: number, cx: number): FaceSample => {
  const box = { x1: cx - 0.08, x2: cx + 0.08, y1: 0.2, y2: 0.55, score: 0.9 };
  return { t, box, boxes: [box] };
};
const run = (fn: (t: number) => number, n = 60) => Array.from({ length: n }, (_, i) => at(i / 4, fn(i / 4)));

describe("tripod", () => {
  it("snaps to the face after a jump instead of panning there", () => {
    const s = run((t) => (t < 7.5 ? 0.76 : 0.51));
    const tr = tripodTrack(s, []);
    const after = tr.find((p) => p.t >= 7.5)!;
    assert.ok(Math.abs(after.x - 0.51) < 0.02, `x ${after.x}`);
    assert.ok(tr.every((p) => p.t < 7.4 || Math.abs(p.x - 0.51) < 0.02 || p.t > 7.6 || Math.abs(p.t - 7.497) < 0.005)); // the hold point just before the cut
  });

  it("does not average across a scene cut", () => {
    const s = run((t) => (t < 7.4 ? 0.76 : 0.51));
    const tr = tripodTrack(s, [7.4]);
    assert.ok(tr.filter((p) => p.t >= 7.5).every((p) => Math.abs(p.x - 0.51) < 0.02));
  });

  it("a one-frame flip to another box is not a cut", () => {
    const s = run((t) => (t === 5 ? 0.3 : 0.6));
    assert.deepEqual(trackBreaks(s, []), []);
  });

  it("a slow drift still pans, within the speed cap", () => {
    const s = run((t) => 0.4 + 0.004 * t * 4);
    const tr = tripodTrack(s, []);
    for (let i = 1; i < tr.length; i++) assert.ok(Math.abs(tr[i]!.x - tr[i - 1]!.x) / (tr[i]!.t - tr[i - 1]!.t) <= 0.13);
  });

  it("a piece starts at its own first position and holds back to t=0", () => {
    const s = run((t) => (t < 7.5 ? 0.76 : 0.51));
    const tr = tripodTrack(s, []);
    const local = localTrack(tr, 7.5, 15);
    assert.equal(local[0]!.t, 0);
    assert.ok(Math.abs(local[0]!.x - 0.51) < 0.02);
  });

  it("keeps both ends of a hard cut in the crop expression", () => {
    const expr = piecewiseExpr(
      [
        { t: 0, v: 100 },
        { t: 1, v: 100 },
        { t: 1.998, v: 100 },
        { t: 2, v: 600 },
        { t: 3, v: 600 },
        { t: 4, v: 600 },
      ],
      2,
    );
    assert.match(expr, /600/);
    assert.match(expr, /1\.99/);
  });
});
