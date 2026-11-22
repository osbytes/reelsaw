/**
 * Subject crop for shots without a face, on synthetic frames: one object moving over a still or
 * panning background is followed; diffuse motion, no motion, a subject wider than the crop, text the
 * crop would cut and a short shot stay whole (`fit`).
 * Run: pnpm --filter @reelsaw/server test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { motionProber, subjectFraming } from "../src/pipeline/saliency.js";
import { decideLayout, segmentLayouts, sameFraming, staticDecision, type FaceSample } from "../src/pipeline/layout.js";

const W = 320;
const H = 240;
const cfg = { LAYOUT_MIN_FACE_RATIO: 0.6, LAYOUT_MIN_FACE_SIZE: 0.18 };
const CROP = 0.316; // a 9:16 crop of a 16:9 source

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A textured still background (fixed per seed), sampled at (x + pan, y). */
function background(seed: number) {
  const r = rng(seed);
  const tex = Float32Array.from({ length: 1024 * 64 }, () => r());
  return (x: number, y: number) => 60 + 120 * tex[((Math.floor(y / 4) & 63) * 1024 + (Math.floor(x / 4) & 1023)) >>> 0]!;
}

function frame(at: (x: number, y: number) => number): Uint8Array {
  const px = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = Math.max(0, Math.min(255, Math.round(at(x, y))));
      px.set([v, v, v], (y * W + x) * 3);
    }
  return px;
}

/**
 * Samples at 4 fps of a shot: `paint(i)` gives frame i's luma function. Motion probes come from the
 * real prober over the rendered frames, as in `sampleFaces`.
 */
function shot(n: number, paint: (i: number) => (x: number, y: number) => number, text?: FaceSample["text"]): FaceSample[] {
  const probe = motionProber(W, H);
  return Array.from({ length: n }, (_, i) => {
    const motion = probe(frame(paint(i)));
    return { t: i / 4, box: null, boxes: [], ...(motion ? { motion } : {}), ...(text ? { text } : {}) };
  });
}

/** A bright block of `w` px that moves along x = x0 + v*i (px), bobbing so it changes every frame. */
const block =
  (bg: (x: number, y: number) => number, x0: number, v: number, w = 40, pan = 0) =>
  (i: number) => {
    const cx = x0 + v * i;
    const r = rng(i + 7);
    const shade = Array.from({ length: 64 }, () => 200 + 55 * r());
    return (x: number, y: number) =>
      Math.abs(x - cx) < w / 2 && y > 80 && y < 180 ? shade[(Math.floor(x / 5) + Math.floor(y / 5) * 3) & 63]! : bg(x + pan * i, y);
  };

describe("subject framing (no face)", () => {
  it("a block moving on a still background is followed, the crop on the block", () => {
    const bg = background(1);
    const s = shot(16, block(bg, 120, 4));
    const f = subjectFraming(s, [], CROP);
    assert.ok(f.ok, f.ok ? "" : f.rejected);
    const xs = f.points.map((p) => p.x);
    const mid = xs[Math.floor(xs.length / 2)]!;
    assert.ok(Math.abs(mid - (120 + 4 * 8) / W) < 0.06, `subject centre ${mid}`);
    const d = decideLayout(s, cfg, []);
    assert.equal(d.layout, "center");
    assert.equal(d.focus, "subject");
    assert.ok(d.track.length >= 1);
  });

  it("a still subject that keeps moving in place gets a stationary crop", () => {
    const bg = background(2);
    const f = subjectFraming(shot(16, block(bg, 240, 0)), [], CROP);
    assert.ok(f.ok && f.mode === "stationary", JSON.stringify(f));
    assert.ok(Math.abs(f.points[0]!.x - 0.75) < 0.05);
  });

  it("the camera's pan is taken out: a block moving over a panning background is still found", () => {
    const bg = background(3);
    const f = subjectFraming(shot(16, block(bg, 160, 0, 40, 8)), [], CROP);
    assert.ok(f.ok, f.ok ? "" : f.rejected);
    assert.ok(Math.abs(f.points.map((p) => p.x).sort()[Math.floor(f.points.length / 2)]! - 0.5) < 0.06);
  });

  it("diffuse motion (noise everywhere), no motion and a wide subject stay whole", () => {
    const noisy = shot(16, (i) => {
      const r = rng(100 + i);
      const n = Float32Array.from({ length: 80 * 60 }, () => r());
      return (x, y) => 40 + 180 * n[Math.floor(y / 4) * 80 + Math.floor(x / 4)]!;
    });
    assert.equal(subjectFraming(noisy, [], CROP).ok, false);
    assert.equal(decideLayout(noisy, cfg, []).layout, "fit");
    const bg = background(4);
    const still = shot(16, () => bg);
    assert.equal(subjectFraming(still, [], CROP).ok, false);
    const wide = shot(16, block(bg, 160, 0, 220));
    assert.equal(subjectFraming(wide, [], CROP).ok, false);
  });

  it("text the crop would cut keeps the shot whole; a watermark at the frame's edge does not", () => {
    const bg = background(5);
    const title = [{ x1: 0.1, y1: 0.45, x2: 0.9, y2: 0.52 }];
    assert.equal(subjectFraming(shot(16, block(bg, 160, 0), title), [], CROP).ok, false);
    // a post beside its embedded video: lines of text the crop would leave out
    const post = Array.from({ length: 6 }, (_, i) => ({ x1: 0.62, y1: 0.2 + i * 0.07, x2: 0.86, y2: 0.25 + i * 0.07 }));
    assert.equal(subjectFraming(shot(16, block(bg, 100, 0), post), [], CROP).ok, false);
    const bug = [{ x1: 0.88, y1: 0.85, x2: 0.95, y2: 0.92 }];
    assert.equal(subjectFraming(shot(16, block(bg, 160, 0), bug), [], CROP).ok, true);
  });

  it("a shot under two seconds, and a source that already fits 9:16, stay whole", () => {
    const bg = background(6);
    assert.equal(subjectFraming(shot(7, block(bg, 160, 0)), [], CROP).ok, false);
    assert.equal(subjectFraming(shot(16, block(bg, 160, 0)), [], 1).ok, false);
  });

  it("segments as its own framing, never merged with a plain centre crop or a fit", () => {
    const bg = background(7);
    const s = shot(24, block(bg, 160, 0));
    const segs = segmentLayouts(s, cfg, [], 6);
    assert.equal(segs.length, 1);
    assert.equal(segs[0]!.decision.focus, "subject");
    assert.equal(sameFraming(segs[0]!.decision, staticDecision("center", "x")), false);
    assert.equal(sameFraming(segs[0]!.decision, staticDecision("fit", "x")), false);
  });
});
