/**
 * Punch-in zooms: which key words zoom (once each, apart, inside one framed piece, never over a cut), which layouts
 * zoom, and that the renderer's ffmpeg expression is the preview's curve.
 * Run: pnpm --filter @reelsaw/server test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PUNCH_IN, fillsFrame, planPunchIns, punchInAnchor, punchInLevel, type PunchIn } from "@reelsaw/shared";
import { layoutFilter, punchInExpr } from "../src/pipeline/render.js";

const words = (spec: Array<[string, number]>) => spec.map(([text, start]) => ({ text, start, end: start + 0.3 }));
const always = () => 0.5;

describe("planPunchIns", () => {
  it("zooms each key word once, at its first occurrence, matched like caption emphasis", () => {
    const w = words([
      ["The", 1],
      ["Money,", 2],
      ["is", 3],
      ["money", 9],
      ["growth", 14],
    ]);
    const z = planPunchIns(w, ["money", "Growth"], { start: 0, end: 20, breaks: [], anchorAt: always });
    assert.deepEqual(
      z.map((x) => x.word),
      ["Money,", "growth"],
    );
    assert.equal(z[0]!.start, 2 - PUNCH_IN.lead);
    assert.equal(z[0]!.end, Number((2 + PUNCH_IN.minWord + PUNCH_IN.hold + PUNCH_IN.out).toFixed(3)));
  });

  it("keeps zooms at least the gap apart", () => {
    const z = planPunchIns(
      words([
        ["a", 1],
        ["b", 2.5],
        ["c", 6],
      ]),
      ["a", "b", "c"],
      { start: 0, end: 20, breaks: [], anchorAt: always },
    );
    assert.deepEqual(
      z.map((x) => x.word),
      ["a", "c"],
    );
  });

  it("drops a zoom that would span a break or leave the clip, rather than shortening it", () => {
    const opts = { start: 0, end: 10, anchorAt: always };
    assert.equal(planPunchIns(words([["cut", 2]]), ["cut"], { ...opts, breaks: [2.5] }).length, 0);
    // a break exactly at the zoom's edge is fine
    assert.equal(planPunchIns(words([["cut", 2]]), ["cut"], { ...opts, breaks: [1.9] }).length, 1);
    assert.equal(planPunchIns(words([["edge", 0.05]]), ["edge"], { ...opts, breaks: [] }).length, 0);
    assert.equal(planPunchIns(words([["edge", 9.5]]), ["edge"], { ...opts, breaks: [] }).length, 0);
  });

  it("zooms only where the picture may zoom, and tries the next occurrence", () => {
    const anchorAt = (t: number) => (t < 5 ? null : 0.4);
    const z = planPunchIns(
      words([
        ["key", 1],
        ["key", 7],
      ]),
      ["key"],
      { start: 0, end: 20, breaks: [5], anchorAt },
    );
    assert.equal(z.length, 1);
    assert.equal(z[0]!.ay, 0.4);
    assert.ok(z[0]!.start > 6);
  });

  it("does nothing without key words", () => {
    assert.deepEqual(planPunchIns(words([["a", 1]]), [], { start: 0, end: 5, breaks: [], anchorAt: always }), []);
  });
});

describe("punchInAnchor", () => {
  const W = 1920;
  const H = 1080;
  it("zooms face and centre crops, about the face kept in a band", () => {
    assert.equal(punchInAnchor({ layout: "face", cy: 0.42 }, W, H), 0.42);
    assert.equal(punchInAnchor({ layout: "face", cy: 0.1 }, W, H), PUNCH_IN.anchorMin);
    assert.equal(punchInAnchor({ layout: "center" }, W, H), 0.5);
  });
  it("never zooms two panes, a fitted frame or the original aspect", () => {
    for (const layout of ["split", "stack", "fit", "none"]) assert.equal(punchInAnchor({ layout }, W, H), null, layout);
  });
  it("zooms an inset or fixed crop only when it fills the frame", () => {
    // 9:16 of a 16:9 source: (9/16 * 1080) / 1920 of the width
    const fill = { x1: 0.4, y1: 0, x2: 0.4 + (1080 * 9) / 16 / W, y2: 1 };
    const square = { x1: 0.3, y1: 0, x2: 0.3 + H / W, y2: 1 };
    assert.ok(fillsFrame(fill, W, H));
    assert.equal(punchInAnchor({ layout: "fit", inset: fill }, W, H), 0.5);
    assert.equal(punchInAnchor({ layout: "fit", inset: square }, W, H), null);
    assert.equal(punchInAnchor({ layout: "face", crop: square, cy: 0.4 }, W, H), null);
  });
});

describe("punchInExpr", () => {
  /** the ffmpeg expression evaluated in JS: clip, min and t are all it uses */
  const evalExpr = (expr: string, t: number): number =>
    new Function("t", "clip", "min", "trunc", `return ${expr};`)(t, (x: number, a: number, b: number) => Math.max(a, Math.min(b, x)), Math.min, Math.trunc);

  it("is the preview's curve", () => {
    const zooms: PunchIn[] = [
      { start: 1, end: 2.2, word: "a", ax: 0.5, ay: 0.4 },
      { start: 5, end: 6, word: "b", ax: 0.5, ay: 0.4 },
    ];
    const expr = punchInExpr(zooms, 1.2);
    for (let t = 0; t <= 7; t += 0.05) {
      const want = 1 + 0.2 * punchInLevel(zooms, t).level;
      assert.ok(Math.abs(evalExpr(expr, t) - want) < 1e-6, `t=${t.toFixed(2)}: ${evalExpr(expr, t)} vs ${want}`);
    }
    assert.ok(Math.abs(evalExpr(expr, 1.6) - 1.2) < 1e-9, "fully zoomed in the hold");
  });

  it("is appended to a zoomable layout's chain only when it has zooms", () => {
    const zooms: PunchIn[] = [{ start: 1, end: 2, word: "a", ax: 0.5, ay: 0.4 }];
    const plain = layoutFilter("face", 1920, 1080, [], [], {});
    const zoomed = layoutFilter("face", 1920, 1080, [], [], { punchIn: { zooms, scale: 1.12 } });
    assert.ok(!plain.chain.includes("overlay"));
    assert.ok(zoomed.chain.startsWith(plain.chain));
    assert.match(zoomed.chain, /scale=w='2\*trunc\(1080\*/);
    assert.match(zoomed.chain, /overlay=x='-0\.5\*\(/);
    assert.match(zoomed.chain, /,setsar=1$/);
    assert.deepEqual([zoomed.width, zoomed.height], [1080, 1920]);
  });
});
