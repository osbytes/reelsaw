/**
 * Output shapes (style `shape`): the frame size per shape, the face window of the frame's shape, split and stack in a
 * landscape frame, the seam captions sit on, and text that keeps its size on every shape.
 * Run: pnpm --filter @reelsaw/server test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OUTPUT_SHAPES, frameCrop, frameScale, layoutForShape, layoutSeamY, outputSize, resolveStyle, punchInAnchor } from "@reelsaw/shared";
import { layoutFilter } from "../src/pipeline/render.js";
import { buildAss, captionFontPx, watermarkPlacement, WATERMARK_LOGO } from "../src/pipeline/captions.js";

const SRC = { w: 1920, h: 1080 };

describe("output shapes", () => {
  it("renders every shape at its size, short side 1080, 9:16 by default", () => {
    assert.equal(resolveStyle({}).shape, "9:16");
    for (const shape of OUTPUT_SHAPES) {
      const out = outputSize(shape);
      assert.equal(Math.min(out.w, out.h), 1080, shape);
      for (const layout of ["face", "center", "fit", "split", "stack"] as const) {
        const r = layoutFilter(layout, SRC.w, SRC.h, [], [], { out });
        assert.deepEqual([r.width, r.height], [out.w, out.h], `${shape} ${layout}`);
        assert.ok(r.chain.endsWith("setsar=1"), `${shape} ${layout}`);
      }
    }
  });

  it("crops the face window to the frame's shape, and a 16:9 frame of a 16:9 source is the source", () => {
    assert.deepEqual(frameCrop(1920, 1080, 9 / 16), { w: 607.5, h: 1080 });
    assert.deepEqual(frameCrop(1920, 1080, 1), { w: 1080, h: 1080 });
    assert.deepEqual(frameCrop(1920, 1080, 4 / 5), { w: 864, h: 1080 });
    assert.deepEqual(frameCrop(1920, 1080, 16 / 9), { w: 1920, h: 1080 });
    const land = layoutFilter("face", 1920, 1080, [], [], { out: outputSize("16:9") });
    assert.match(land.chain, /crop=1920:1080:/);
    // a portrait source in a landscape frame: full width, a band of its height
    assert.deepEqual(frameCrop(1080, 1920, 16 / 9), { w: 1080, h: 607.5 });
  });

  it("shows split and stack whole in 16:9, and keeps them as stacked panes in 4:5 and 1:1", () => {
    assert.equal(layoutForShape("split", "16:9"), "fit");
    assert.equal(layoutForShape("stack", "16:9"), "fit");
    assert.equal(layoutForShape("face", "16:9"), "face");
    for (const shape of ["9:16", "4:5", "1:1"] as const) {
      assert.equal(layoutForShape("split", shape), "split");
      const out = outputSize(shape);
      const r = layoutFilter("split", SRC.w, SRC.h, [], [], { out });
      assert.match(r.chain, new RegExp(`scale=${out.w}:${out.h / 2}:`), shape);
    }
  });

  it("puts the stack's seam where its top pane ends in each frame", () => {
    assert.equal(layoutSeamY("stack", undefined, 1920, 1080), 0.3167);
    assert.equal(layoutSeamY("stack", undefined, 1920, 1080, outputSize("4:5")), 0.4504);
    assert.equal(layoutSeamY("stack", undefined, 1920, 1080, outputSize("1:1")), 0.563);
    assert.equal(layoutSeamY("split", undefined, 1920, 1080, outputSize("1:1")), 0.5);
  });

  it("keeps text and the watermark the same size in pixels of the short side", () => {
    assert.equal(frameScale(1080, 1920), 1);
    for (const shape of OUTPUT_SHAPES) {
      const o = outputSize(shape);
      assert.equal(captionFontPx(o.w, o.h, 1), 68, shape);
    }
    const nine = watermarkPlacement(1080, 1920);
    assert.deepEqual([nine.x, nine.y, nine.w], [WATERMARK_LOGO.x, WATERMARK_LOGO.y, WATERMARK_LOGO.w]);
    const land = watermarkPlacement(1920, 1080);
    // same pixels: 194 px wide, 162 px in from the left
    assert.ok(Math.abs(land.w * 1920 - WATERMARK_LOGO.w * 1080) < 1e-6);
    assert.ok(Math.abs(land.x * 1920 - WATERMARK_LOGO.x * 1080) < 1e-6);
    assert.ok(land.textY < 0.5, "the text stays under the logo in the top corner");
    const ass = buildAss([], { width: 1920, height: 1080, font: "DejaVu Sans", style: resolveStyle({}) });
    assert.match(ass, /PlayResX: 1920\nPlayResY: 1080/);
    assert.match(ass, /Style: Caption,DejaVu Sans,68,/);
  });

  it("zooms a face crop whatever the shape, and an inset only where it fills the frame", () => {
    const nineBySixteenInset = { x1: 0.4, y1: 0, x2: 0.4 + 607.5 / 1920, y2: 1 };
    assert.equal(punchInAnchor({ layout: "fit", inset: nineBySixteenInset }, 1920, 1080), 0.5);
    assert.equal(punchInAnchor({ layout: "fit", inset: nineBySixteenInset }, 1920, 1080, 1), null);
    assert.equal(punchInAnchor({ layout: "face", cy: 0.4 }, 1920, 1080, 16 / 9), 0.4);
  });
});
