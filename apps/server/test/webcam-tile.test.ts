/**
 * Webcam tile detection on synthetic rasters: a picture-in-picture box around the face is found
 * from its straight edges, a flat band it sits in is left out of the top pane, and anything
 * without a rectangle stays as it was.
 * Run: pnpm --filter @reelsaw/server test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeTiles, aggregateTile, tileContent, TILE, type TileProbe } from "../src/pipeline/webcam-tile.js";
import { decideLayout, forcedDecision, type FaceSample } from "../src/pipeline/layout.js";
import { tileCrop } from "@reelsaw/shared";

// the raster is 320x240; the scenes are 4:3 sources, so a rectangle's shape in source pixels is its shape here
const W = 320;
const H = 240;
const cfg = { LAYOUT_MIN_FACE_RATIO: 0.6, LAYOUT_MIN_FACE_SIZE: 0.18 };

/** deterministic noise so a "slide" has texture but no straight edges */
function noise(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

interface Scene {
  /** luma of the background, or a textured slide when `texture` is set */
  bg: number;
  texture?: number;
  /** a flat band along the right edge from this x (fraction of the width) */
  bandFrom?: number;
  bandLuma?: number;
  /** the tile rectangle in pixels (inclusive-exclusive), drawn at `tileLuma` with a darker face blob inside */
  tile?: { x1: number; y1: number; x2: number; y2: number };
  tileLuma?: number;
  face: { x1: number; y1: number; x2: number; y2: number };
}

function raster(sc: Scene): Uint8Array {
  const px = new Uint8Array(W * H * 3);
  const rnd = noise(7);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let l = sc.bg + (sc.texture ? (rnd() - 0.5) * sc.texture : 0);
      if (sc.bandFrom !== undefined && x >= sc.bandFrom * W) l = sc.bandLuma ?? 0.02;
      if (sc.tile && x >= sc.tile.x1 && x < sc.tile.x2 && y >= sc.tile.y1 && y < sc.tile.y2) l = (sc.tileLuma ?? 0.7) + (rnd() - 0.5) * 0.05;
      if (x >= sc.face.x1 && x < sc.face.x2 && y >= sc.face.y1 && y < sc.face.y2) l = 0.45 + (rnd() - 0.5) * 0.1;
      const v = Math.round(Math.max(0, Math.min(1, l)) * 255);
      px[(y * W + x) * 3] = v;
      px[(y * W + x) * 3 + 1] = v;
      px[(y * W + x) * 3 + 2] = v;
    }
  return px;
}

const norm = (b: { x1: number; y1: number; x2: number; y2: number }) => ({ x1: b.x1 / W, y1: b.y1 / H, x2: b.x2 / W, y2: b.y2 / H });
const near = (a: number, b: number, tol = 0.012) => Math.abs(a - b) <= tol;
/** the tile one frame gives on its own */
const pick = (px: Uint8Array, face: Scene["face"]) => aggregateTile([{ tiles: probeTiles(px, W, H, norm(face), 4 / 3) }]);

// a Zoom-style layout: slides on the left, a black column from x=256 with a 56x28 (2:1) tile at its top (an 8 px margin)
const zoom: Scene = { bg: 0.6, texture: 0.3, bandFrom: 0.8, tile: { x1: 264, y1: 20, x2: 320, y2: 48 }, face: { x1: 296, y1: 27, x2: 305, y2: 40 } };

describe("webcam tile", () => {
  it("finds the tile around the face and the flat band it sits in", () => {
    const found = pick(raster(zoom), zoom.face);
    assert.ok(found, "tile found");
    const t = found.tile;
    assert.ok(near(t.x1, 264 / W) && near(t.y1, 20 / H) && t.x2 === 1 && near(t.y2, 48 / H), `tile ${JSON.stringify(t)}`);
    assert.equal(found.band, "right");
  });

  it("a line inside the webcam picture makes a second rectangle; the outer one is the tile", () => {
    // a door frame inside the webcam picture: a dark vertical line between the face and the tile's edge
    const px = raster(zoom);
    for (let y = zoom.tile!.y1; y < zoom.tile!.y2; y++)
      for (let x = 274; x < 281; x++) {
        const i = (y * W + x) * 3;
        px[i] = px[i + 1] = px[i + 2] = Math.round(0.35 * 255);
      }
    const rects = probeTiles(px, W, H, norm(zoom.face), 4 / 3);
    assert.ok(rects.length >= 2 && near(rects[0]!.x1, 281 / W), `rects ${JSON.stringify(rects)}`);
    const found = pick(px, zoom.face);
    assert.ok(found && near(found.tile.x1, 264 / W), `tile ${JSON.stringify(found)}`);
  });

  it("a corner webcam over a screencast with no flat band keeps the whole frame on top", () => {
    const sc: Scene = { bg: 0.2, texture: 0.25, tile: { x1: 192, y1: 160, x2: 320, y2: 240 }, tileLuma: 0.75, face: { x1: 240, y1: 180, x2: 272, y2: 222 } };
    const found = pick(raster(sc), sc.face);
    const t = found?.tile;
    assert.ok(t && near(t.x1, 192 / W) && near(t.y1, 160 / H) && t.x2 === 1 && t.y2 === 1, `tile ${JSON.stringify(found)}`);
    assert.equal(found!.band, undefined);
  });

  it("a face on a textured slide with no rectangle around it is not a tile", () => {
    const sc: Scene = { bg: 0.6, texture: 0.3, face: { x1: 150, y1: 100, x2: 170, y2: 126 } };
    assert.deepEqual(probeTiles(raster(sc), W, H, norm(sc.face), 4 / 3), []);
  });

  it("a big talking head is not a tile (the frame itself is not a picture-in-picture box)", () => {
    const sc: Scene = { bg: 0.5, texture: 0.2, face: { x1: 120, y1: 60, x2: 200, y2: 170 } };
    assert.deepEqual(probeTiles(raster(sc), W, H, norm(sc.face), 4 / 3), []);
  });

  it("across frames: the rectangle seen most often wins, an inner one seen as often loses, and too few frames give nothing", () => {
    const outer: TileProbe = { x1: 0.875, y1: 0.083, x2: 1, y2: 0.2, s: 0.3, band: "right" };
    const inner: TileProbe = { x1: 0.92, y1: 0.083, x2: 1, y2: 0.2, s: 0.4 };
    const frames = (n: number, ...tiles: TileProbe[]) => Array.from({ length: n }, () => (tiles.length ? { tiles } : {}));
    // the person covers the door frame in a third of the frames: the border is seen in every frame
    const found = aggregateTile([...frames(6, inner, outer), ...frames(3, outer), ...frames(1)])!;
    assert.ok(found && found.band === "right" && found.share === 0.9, JSON.stringify(found));
    assert.deepEqual(found.tile, { x1: 0.875, y1: 0.083, x2: 1, y2: 0.2 });
    // both in every frame: a tie, and the outer one is the tile
    assert.deepEqual(aggregateTile(frames(10, inner, outer))!.tile, { x1: 0.875, y1: 0.083, x2: 1, y2: 0.2 });
    // the border is weak most of the time: the inner rectangle is what is there
    assert.deepEqual(aggregateTile([...frames(8, inner), ...frames(2, inner, outer)])!.tile, { x1: 0.92, y1: 0.083, x2: 1, y2: 0.2 });
    assert.equal(aggregateTile([...frames(5, outer), ...frames(5)]), undefined, "under the share floor");
    // a rectangle that wanders is not one cluster
    assert.equal(aggregateTile(Array.from({ length: 10 }, (_, i) => ({ tiles: [{ ...outer, x1: 0.8 + i * 0.03 }] }))), undefined, "edges wander");
    assert.deepEqual(tileContent(found.tile, "right"), { x1: 0, y1: 0, x2: 0.875, y2: 1 });
    assert.deepEqual(tileContent(found.tile, "bottom"), { x1: 0, y1: 0, x2: 1, y2: 0.083 });
  });

  it("the speaker pane is the tile alone, in even source pixels inside the frame", () => {
    assert.deepEqual(tileCrop(1920, 1080, { x1: 0.874, y1: 0.083, x2: 1, y2: 0.218 }), { x: 1678, y: 89, w: 242, h: 146 });
  });

  it("a stack keeps the tile: auto when the detector mostly misses the face, and a forced Screen + speaker", () => {
    const tile: TileProbe = { x1: 0.875, y1: 0.083, x2: 1, y2: 0.2, s: 0.3, band: "right" };
    const box = { x1: 0.92, y1: 0.11, x2: 0.95, y2: 0.165, score: 0.8 };
    // the face is seen in 1 of every 10 frames; the tile (probed around the last face) in 9 of 10
    const samples: FaceSample[] = Array.from({ length: 80 }, (_, i) => ({ t: i / 4, box: i % 10 === 0 ? box : null, boxes: i % 10 === 0 ? [box] : [], ...(i % 10 === 9 ? {} : { tiles: [tile] }) }));
    const d = decideLayout(samples, cfg, []);
    assert.equal(d.layout, "stack");
    assert.deepEqual(d.tile, { x1: 0.875, y1: 0.083, x2: 1, y2: 0.2 });
    assert.deepEqual(d.content, { x1: 0, y1: 0, x2: 0.875, y2: 1 });
    assert.match(d.reason, /^face in only 10% of frames; webcam tile top-right \(x 0\.88-1\.00, y 0\.08-0\.20\), in a flat band on the right$/);
    const f = forcedDecision(samples, "stack", cfg, []);
    assert.equal(f.layout, "stack");
    assert.deepEqual(f.tile, d.tile);
    assert.deepEqual(f.content, d.content);
    assert.match(f.reason, /^manual; webcam tile/);
    // without the tile the same samples are "fit" (auto) and the plain stack (forced)
    const bare = samples.map(({ tiles: _t, ...s }) => s);
    assert.equal(decideLayout(bare, cfg, []).layout, "fit");
    const fb = forcedDecision(bare, "stack", cfg, []);
    assert.equal(fb.tile, undefined);
    assert.deepEqual(fb.content, { x1: 0, y1: 0, x2: 1, y2: 1 });
    assert.ok(TILE.minShare <= 0.9);
  });
});
