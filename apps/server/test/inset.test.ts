/**
 * Inset picture detection on synthetic frames: a phone video between blurred bars is found and
 * cropped to; a person in front of a plain wall, a full textured frame and a brief blip are not.
 * Run: pnpm --filter @reelsaw/server test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeInset, insetRuns, fillRegion, type InsetProbe } from "../src/pipeline/inset.js";
import { segmentLayouts, sameFraming, staticDecision, type FaceSample } from "../src/pipeline/layout.js";

const W = 320;
const H = 240;
const cfg = { LAYOUT_MIN_FACE_RATIO: 0.6, LAYOUT_MIN_FACE_SIZE: 0.18 };

/** deterministic noise */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** An RGB frame whose luma is `at(x, y)` (0..255). */
function frame(at: (x: number, y: number) => number): Uint8Array {
  const px = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = Math.max(0, Math.min(255, Math.round(at(x, y))));
      px.set([v, v, v], (y * W + x) * 3);
    }
  return px;
}

/** a detailed picture between x1 and x2 (normalized), smooth bars of `bar` luma either side */
function pillarbox(x1: number, x2: number, opts: { bar?: (x: number, y: number) => number; picture?: number; seed?: number } = {}) {
  const r = rng(opts.seed ?? 1);
  const bar = opts.bar ?? ((x: number, y: number) => 70 + 10 * Math.sin(x / 40) + 8 * Math.cos(y / 50));
  const base = opts.picture ?? 120;
  return frame((x, y) => (x >= x1 * W && x < x2 * W ? base + 60 * (r() - 0.5) + 30 * Math.sin(y / 6) : bar(x, y)));
}

describe("probeInset", () => {
  it("finds a vertical video between blurred bars", () => {
    const p = probeInset(pillarbox(0.34, 0.66), W, H);
    assert.ok(p, "an inset");
    assert.ok(Math.abs(p.x1 - 0.34) <= 0.01, `x1 ${p.x1}`);
    assert.ok(Math.abs(p.x2 - 0.66) <= 0.01, `x2 ${p.x2}`);
  });

  it("finds a dark picture between black bars", () => {
    const p = probeInset(pillarbox(0.22, 0.78, { bar: () => 0, picture: 35 }), W, H);
    assert.ok(p);
    assert.ok(Math.abs(p.x1 - 0.22) <= 0.01 && Math.abs(p.x2 - 0.78) <= 0.01, `${p.x1}-${p.x2}`);
  });

  it("a person in front of a plain wall is not an inset", () => {
    // flat wall, a textured figure in the lower middle: flat sides, but no edge from top to bottom
    const r = rng(7);
    const f = frame((x, y) => {
      const dx = (x - W / 2) / (W * 0.28);
      const dy = (y - H) / (H * 0.75);
      return dx * dx + dy * dy < 1 ? 40 + 50 * r() : 225;
    });
    assert.equal(probeInset(f, W, H), undefined);
  });

  it("a full textured frame is not an inset", () => {
    const r = rng(3);
    assert.equal(
      probeInset(
        frame(() => 128 + 80 * (r() - 0.5)),
        W,
        H,
      ),
      undefined,
    );
  });

  it("a picture off centre is not a pillarbox", () => {
    assert.equal(probeInset(pillarbox(0.1, 0.45), W, H), undefined);
  });
});

describe("insetRuns", () => {
  const samples = (n: number, at: (i: number) => InsetProbe | undefined) =>
    Array.from({ length: n }, (_, i) => {
      const inset = at(i);
      return { t: i / 4, ...(inset ? { inset } : {}) };
    });
  const phone = { x1: 0.3375, x2: 0.6625 };

  it("keeps a steady inset and trims it to 9:16", () => {
    const runs = insetRuns(
      samples(40, (i) => (i % 5 === 4 ? undefined : phone)),
      10,
    );
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.start, 0);
    assert.equal(runs[0]!.end, 10);
    const r = runs[0]!.region;
    assert.ok(Math.abs(((r.x2 - r.x1) * 16) / 9 - 9 / 16) < 0.002, "9:16");
    assert.ok(Math.abs((r.x1 + r.x2) / 2 - 0.5) < 0.002, "centred");
    assert.deepEqual([r.y1, r.y2], [0, 1]);
  });

  it("ignores a blip, and an inset that moves", () => {
    assert.equal(
      insetRuns(
        samples(40, (i) => (i >= 10 && i < 14 ? phone : undefined)),
        10,
      ).length,
      0,
    );
    assert.equal(
      insetRuns(
        samples(40, (i) => ({ x1: 0.2 + i * 0.005, x2: 0.8 - i * 0.005 })),
        10,
      ).length,
      0,
    );
  });

  it("starts and ends on a nearby scene cut, and never runs across one", () => {
    const runs = insetRuns(
      samples(60, (i) => (i >= 17 && i < 50 ? phone : undefined)),
      15,
      [4.1, 12.6],
    );
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.start, 4.1);
    assert.equal(runs[0]!.end, 12.6);
  });

  it("holds through the picture's own cuts and a moment of other bounds, groups by the bounds most frames share", () => {
    const off = { x1: 0.2, x2: 0.8 };
    const drift = { x1: 0.3245, x2: 0.6755 }; // a first frame mid-transition, within `same` of the phone but not of most frames' neighbours
    const runs = insetRuns(
      samples(60, (i) => (i === 0 ? drift : i >= 20 && i < 24 ? off : phone)),
      15,
      [3.1, 5.6, 9.2],
    );
    assert.equal(runs.length, 1);
    assert.deepEqual([runs[0]!.start, runs[0]!.end], [0, 15]);
    assert.ok(Math.abs(runs[0]!.bounds.x1 - phone.x1) < 1e-6);
  });

  it("drops a wide inset (a frame with margins, not a picture)", () => {
    assert.equal(
      insetRuns(
        samples(40, () => ({ x1: 0.1, x2: 0.9 })),
        10,
      ).length,
      0,
    );
  });

  it("keeps a square inset at its own shape", () => {
    const r = fillRegion({ x1: 0.22, x2: 0.78 }, 16 / 9);
    assert.ok(Math.abs(r.x1 - 0.223) < 0.001 && Math.abs(r.x2 - 0.777) < 0.001);
    assert.deepEqual([r.y1, r.y2], [0, 1]);
  });
});

describe("segmentLayouts with an inset", () => {
  const face = { x1: 0.42, x2: 0.58, y1: 0.2, y2: 0.55, score: 0.9 };
  const phone = { x1: 0.3375, x2: 0.6625 };

  it("a face inside a phone video is shown as the inset, the full-frame shot around it as before", () => {
    // 0-5 s a full-frame talking head, 5-15 s a phone video (with the person in it), cut at 5 s
    const s: FaceSample[] = Array.from({ length: 60 }, (_, i) => ({
      t: i / 4,
      box: face,
      boxes: [face],
      ...(i >= 20 ? { inset: phone } : {}),
    }));
    const segs = segmentLayouts(s, cfg, [5], 15);
    assert.deepEqual(
      segs.map((sg) => [sg.decision.layout, sg.start, sg.end, !!sg.decision.inset]),
      [
        ["face", 0, 5, false],
        ["fit", 5, 15, true],
      ],
    );
    assert.match(segs[1]!.decision.reason, /^vertical video inside the frame \(34–66% of the width\), cropped to it$/);
  });

  it("a fit with an inset is another framing than a plain fit", () => {
    const plain = staticDecision("fit", "no face detected");
    const inset = { ...plain, inset: { x1: 0.34, y1: 0, x2: 0.66, y2: 1 } };
    assert.equal(sameFraming(plain, inset), false);
    assert.equal(sameFraming(inset, { ...inset, inset: { x1: 0.345, y1: 0, x2: 0.655, y2: 1 } }), true);
    assert.equal(sameFraming(inset, { ...inset, inset: { x1: 0.22, y1: 0, x2: 0.78, y2: 1 } }), false);
  });
});
