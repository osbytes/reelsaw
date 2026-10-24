/**
 * Layer templates, the pure part (docs/specs/layer-templates.md): a template layer's window on clips of different
 * lengths, materialising a template on a clip, and reading a template back off a clip's layers.
 * Run: pnpm --filter @reelsaw/server test (no database needed for this file)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { layerTimingSchema, resolveTemplateLayers, templateFromLayers, templateWindow, timingText, type ClipLayer, type TemplateLayer } from "@reelsaw/shared";

const logo: TemplateLayer = { id: "t-logo", kind: "asset", assetId: "a1", x: 0.5, y: 0.1, w: 0.3, timing: { mode: "head", start: 0, end: 3 } };
const cta: TemplateLayer = { id: "t-cta", kind: "text", text: "Link in bio", x: 0.5, y: 0.8, timing: { mode: "tail", start: 4, end: 0 } };
const mark: TemplateLayer = { id: "t-mark", kind: "asset", assetId: "a2", x: 0.9, y: 0.9, w: 0.1, timing: { mode: "fill" } };
const music: TemplateLayer = { id: "t-music", kind: "audio", assetId: "m1", volume: 0.5, duck: true, fade: 1, loop: true, timing: { mode: "fill" } };
const interrupt: TemplateLayer = { id: "t-mid", kind: "asset", assetId: "a3", x: 0.5, y: 0.5, w: 0.4, timing: { mode: "relative", start: 0.4, end: 0.6, maxSec: 3 } };

describe("templateWindow", () => {
  it("keeps head and tail in real seconds whatever the length", () => {
    assert.deepEqual(templateWindow(logo.timing, 15, "asset"), [0, 3]);
    assert.deepEqual(templateWindow(logo.timing, 90, "asset"), [0, 3]);
    assert.deepEqual(templateWindow(cta.timing, 15, "text"), [11, 15]);
    assert.deepEqual(templateWindow(cta.timing, 90, "text"), [86, 90]);
  });
  it("fills the whole clip", () => {
    assert.deepEqual(templateWindow(mark.timing, 42.5, "asset"), [0, 42.5]);
  });
  it("scales a relative window and holds it between minSec and maxSec", () => {
    assert.deepEqual(templateWindow(interrupt.timing, 10, "asset"), [4, 6]); // 20% of 10 s = 2 s, under the cap
    assert.deepEqual(templateWindow(interrupt.timing, 60, "asset"), [28.5, 31.5]); // 20% of 60 s = 12 s, held to 3 s around the middle
    assert.deepEqual(templateWindow({ mode: "relative", start: 0.1, end: 0.2, minSec: 4 }, 10, "asset"), [0, 3.5]); // 1 s grown to 4 s around 1.5 s, then clamped to the clip start
  });
  it("clamps to the clip and gives up when there is no room", () => {
    assert.deepEqual(templateWindow({ mode: "tail", start: 20, end: 0 }, 8, "text"), [0, 8]); // a long tail on a short clip covers it
    assert.equal(templateWindow({ mode: "head", start: 10, end: 12 }, 8, "text"), null); // starts after the clip ends
    assert.equal(templateWindow({ mode: "relative", start: 0.5, end: 0.5001 }, 10, "audio"), null); // under the 0.5 s a sound needs
  });
});

describe("layerTimingSchema", () => {
  it("needs a window with a length in the right direction", () => {
    assert.ok(layerTimingSchema.safeParse({ mode: "head", start: 0, end: 3 }).success);
    assert.ok(!layerTimingSchema.safeParse({ mode: "head", start: 3, end: 3 }).success);
    assert.ok(layerTimingSchema.safeParse({ mode: "tail", start: 4, end: 0 }).success);
    assert.ok(!layerTimingSchema.safeParse({ mode: "tail", start: 0, end: 4 }).success);
    assert.ok(layerTimingSchema.safeParse({ mode: "fill" }).success);
    assert.ok(!layerTimingSchema.safeParse({ mode: "relative", start: 0.6, end: 0.4 }).success);
  });
});

describe("resolveTemplateLayers", () => {
  it("materialises every layer in absolute source seconds with fresh ids and the template's own fields", () => {
    const { layers, skipped } = resolveTemplateLayers([logo, cta, mark, music], { startSec: 100, endSec: 130 });
    assert.equal(skipped.length, 0);
    assert.deepEqual(
      layers.map((l) => [l.kind, l.start, l.end]),
      [
        ["asset", 100, 103],
        ["text", 126, 130],
        ["asset", 100, 130],
        ["audio", 100, 130],
      ],
    );
    assert.ok(layers.every((l) => /^ly-[a-z0-9]{4}$/.test(l.id)), "ids are lane ids");
    assert.equal(new Set(layers.map((l) => l.id)).size, 4, "ids are distinct");
    const m = layers[3]!;
    assert.ok(m.kind === "audio" && m.volume === 0.5 && m.loop === true && m.fade === 1, "sound settings travel");
    assert.ok(!("timing" in m), "timing does not leak into a clip layer");
  });
  it("reports the layers that had no room instead of failing", () => {
    const { layers, skipped } = resolveTemplateLayers([{ ...logo, timing: { mode: "head", start: 10, end: 12 } }, cta], { startSec: 0, endSec: 6 });
    assert.deepEqual(skipped, ["t-logo"]);
    assert.deepEqual(layers.map((l) => [l.start, l.end]), [[2, 6]]);
  });
  it("lets the caller keep the template ids (the template editor previews with them)", () => {
    const { layers } = resolveTemplateLayers([logo], { startSec: 0, endSec: 30 }, (l) => l.id);
    assert.equal(layers[0]!.id, "t-logo");
  });
});

describe("templateFromLayers", () => {
  const clip = { startSec: 200, endSec: 260 };
  const on = (start: number, end: number, extra: Partial<ClipLayer> = {}): ClipLayer => ({ id: "x", kind: "text", text: "t", x: 0.5, y: 0.5, start: clip.startSec + start, end: clip.startSec + end, ...extra } as ClipLayer);
  it("spanning layers fill, edge layers anchor, inner layers anchor to the nearer edge with their length", () => {
    const [fill, head, tail, nearStart, nearEnd] = templateFromLayers([on(0, 60), on(0.1, 3), on(55, 60), on(10, 13), on(40, 47)], clip);
    assert.deepEqual(fill!.timing, { mode: "fill" });
    assert.deepEqual(head!.timing, { mode: "head", start: 0.1, end: 3 });
    assert.deepEqual(tail!.timing, { mode: "tail", start: 5, end: 0 });
    assert.deepEqual(nearStart!.timing, { mode: "head", start: 10, end: 13 });
    assert.deepEqual(nearEnd!.timing, { mode: "tail", start: 20, end: 13 });
  });
  it("drops the absolute times and keeps everything else", () => {
    const [t] = templateFromLayers([{ id: "m", kind: "audio", assetId: "m1", start: 200, end: 260, volume: 0.4, loop: false }], clip);
    assert.deepEqual(t, { id: "m", kind: "audio", assetId: "m1", volume: 0.4, loop: false, timing: { mode: "fill" } });
  });
  it("round-trips: a template read off a clip puts the same windows back on a clip of the same length", () => {
    const original = [on(0, 60), on(0, 3), on(56, 60), on(10, 13)];
    const back = resolveTemplateLayers(templateFromLayers(original, clip), clip, (l) => l.id).layers;
    assert.deepEqual(
      back.map((l) => [l.start, l.end]),
      original.map((l) => [l.start, l.end]),
    );
  });
});

describe("timingText", () => {
  it("reads like the editor's labels", () => {
    assert.equal(timingText({ mode: "head", start: 0, end: 3 }), "First 3 s");
    assert.equal(timingText({ mode: "head", start: 1.5, end: 4 }), "1.5–4 s from the start");
    assert.equal(timingText({ mode: "tail", start: 4, end: 0 }), "Last 4 s");
    assert.equal(timingText({ mode: "fill" }), "Whole clip");
    assert.equal(timingText({ mode: "relative", start: 0.4, end: 0.6, maxSec: 3 }), "40–60% of the clip (at most 3 s)");
  });
});
