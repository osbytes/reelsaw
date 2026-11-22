/**
 * Face tracker: one id per face across sampled frames, and the layout rules that lean on it
 * (`assignPair`, `trackBreaks`, `dropStaticFaces`).
 * Run: pnpm --filter @reelsaw/server test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { trackFaces } from "../src/vision/tracker.js";
import { faceRaster, decodeYunet, type FaceBox } from "../src/vision/faces.js";
import { assignPair, trackBreaks, dropStaticFaces, type FaceSample } from "../src/pipeline/layout.js";

const face = (cx: number, cy = 0.4, w = 0.12, h = 0.3): FaceBox => ({ x1: cx - w / 2, x2: cx + w / 2, y1: cy - h / 2, y2: cy + h / 2, score: 0.9 });
const frame = (t: number, boxes: FaceBox[]): FaceSample => ({ t, box: boxes[0] ?? null, boxes });

describe("face tracker", () => {
  it("keeps one id per face while two people move, and starts a new one for a new face", () => {
    const s = Array.from({ length: 20 }, (_, i) => frame(i / 4, [face(0.25 + i * 0.005), face(0.75 - i * 0.004)]));
    s.push(frame(5, [face(0.35), face(0.67), face(0.5, 0.8, 0.05, 0.1)]));
    trackFaces(s);
    const a = new Set(s.map((f) => f.boxes[0]!.track));
    const b = new Set(s.map((f) => f.boxes[1]!.track));
    assert.equal(a.size, 1);
    assert.equal(b.size, 1);
    assert.notDeepEqual([...a], [...b]);
    assert.ok(![...a, ...b].includes(s.at(-1)!.boxes[2]!.track!));
  });

  it("does not link a jump a face cannot make between two samples (a cut)", () => {
    const s = [frame(0, [face(0.3)]), frame(0.25, [face(0.3)]), frame(0.5, [face(0.55)])];
    trackFaces(s);
    assert.notEqual(s[1]!.boxes[0]!.track, s[2]!.boxes[0]!.track);
  });

  it("follows a face through a short gap and drops it after a long one", () => {
    const s = [frame(0, [face(0.3)]), frame(0.25, []), frame(0.5, [face(0.31)]), frame(2, [face(0.31)])];
    trackFaces(s);
    assert.equal(s[0]!.boxes[0]!.track, s[2]!.boxes[0]!.track);
    assert.notEqual(s[2]!.boxes[0]!.track, s[3]!.boxes[0]!.track);
  });
});

describe("track ids in layout", () => {
  it("assignPair takes a speaker back to its own face after it blinks out beside a spurious box", () => {
    // a box between the two (a hand) persists; speaker B's face is missed for one frame, so B fills
    // that frame with the hand; by x continuity alone B would then stay on the hand
    const s: FaceSample[] = [];
    for (let i = 0; i < 16; i++) {
      const boxes = [face(0.28), face(0.47, 0.45, 0.1, 0.22)];
      if (i !== 8) boxes.push(face(0.62));
      s.push(frame(i / 4, boxes));
    }
    trackFaces(s);
    const { b } = assignPair(s);
    const x = (f: FaceSample) => (f.box!.x1 + f.box!.x2) / 2;
    for (const f of b.slice(9)) assert.ok(Math.abs(x(f) - 0.62) < 0.01, `B on ${x(f)} at ${f.t}`);
  });

  it("a step within one track is never a tripod break", () => {
    // a large close-up face moving fast: same face, consecutive samples 0.16 apart
    const s = Array.from({ length: 6 }, (_, i) => frame(i / 4, [face(0.3 + (i >= 3 ? 0.16 : 0), 0.4, 0.45, 0.8)]));
    for (const f of s) f.boxes[0]!.track = 1;
    assert.deepEqual(trackBreaks(s, []), []);
    for (const f of s.slice(3)) f.boxes[0]!.track = 2;
    assert.deepEqual(trackBreaks(s, []), [0.75]);
  });

  it("dropStaticFaces drops a poster but keeps a person who walks past it", () => {
    const s: FaceSample[] = [];
    for (let i = 0; i < 40; i++) {
      const boxes = [face(0.8, 0.3, 0.08, 0.15)];
      // a person crossing the frame, passing the poster's spot around t = 7
      boxes.push(face(0.1 + i * 0.02, 0.32, 0.1, 0.18));
      s.push(frame(i / 4, boxes));
    }
    trackFaces(s);
    const { samples, dropped } = dropStaticFaces(s);
    assert.equal(dropped.length, 1);
    assert.ok(Math.abs(dropped[0]!.x - 0.8) < 0.01);
    assert.ok(samples.every((f, i) => f.boxes.length === 1 && f.boxes[0] === s[i]!.boxes[1]));
  });
});

describe("YuNet raster and decode", () => {
  it("keeps the source shape at about 640×360 pixels", () => {
    assert.deepEqual(faceRaster(16 / 9), { w: 640, h: 360 });
    assert.deepEqual(faceRaster(9 / 16), { w: 360, h: 640 });
    const r = faceRaster(4 / 3);
    assert.ok(Math.abs(r.w / r.h - 4 / 3) < 0.01 && r.w % 2 === 0 && r.h % 2 === 0);
    assert.deepEqual(faceRaster(Number.NaN), { w: 640, h: 360 });
  });

  it("decodes a stride-8 anchor into a normalized box with landmarks", () => {
    // one confident anchor at stride 8, row 2, col 3 of a 64×32 frame (padded 64×32: 8 cols × 4 rows)
    const out: Record<string, { data: Float32Array }> = {};
    for (const s of [8, 16, 32]) {
      const n = (64 / s) * (32 / s);
      out[`cls_${s}`] = { data: new Float32Array(n) };
      out[`obj_${s}`] = { data: new Float32Array(n) };
      out[`bbox_${s}`] = { data: new Float32Array(n * 4) };
      out[`kps_${s}`] = { data: new Float32Array(n * 10) };
    }
    const i = 2 * 8 + 3;
    out.cls_8!.data[i] = 0.81;
    out.obj_8!.data[i] = 1;
    out.bbox_8!.data.set([0.5, 0.5, Math.log(2), Math.log(2)], i * 4); // centre (28, 20), 16×16
    out.kps_8!.data.set([0, 0, 1, 0, 0.5, 0.5, 0, 1, 1, 1], i * 10);
    const [b, ...rest] = decodeYunet(out, 0.5, 64, 32);
    assert.equal(rest.length, 0);
    assert.ok(Math.abs(b!.score - 0.9) < 1e-4);
    assert.deepEqual([b!.x1, b!.y1, b!.x2, b!.y2], [20 / 64, 12 / 32, 36 / 64, 28 / 32]);
    assert.deepEqual(b!.landmarks!.slice(0, 2), [24 / 64, 16 / 32]);
  });
});
