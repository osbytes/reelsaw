/**
 * Burned-in captions in tight close-ups: regions over faces are trimmed to below the chin rather than
 * dropped, timed regions are tightened per stretch of text, blurs get a soft edge and fade, and caption
 * lines in split / stack sections sit on the seam. Regions and faces are from the Apollo report
 * ("The Most Important 20 Minutes", clip "Success as Revenge"), where the whole caption band was dropped.
 * No stack needed: node --import tsx --test test/overlays-faces.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { captionYAt, defaultStyle, layoutSeamY, mergeSeamRuns, type SourceOverlay } from "@reelsaw/shared";
import { dropFaceOverlaps, tightenOverlays, type ClipTextFrame } from "../src/pipeline/overlays.js";
import { sourceVideo } from "../src/pipeline/render.js";
import { buildAss } from "../src/pipeline/captions.js";

const band: SourceOverlay = { x1: 0.105, x2: 0.892, y1: 0.543, y2: 0.904, kind: "caption", coverage: 0.86, share: 1 };
// a close-up: the face is ~41% of the frame tall, its chin a little past the band's top edge
const closeUp = (t: number) => ({ t, faces: [{ x1: 0.42, y1: 0.22 + (t % 3) * 0.005, x2: 0.68, y2: 0.65 + (t % 3) * 0.005 }] });

describe("dropFaceOverlaps", () => {
  it("trims a caption band below a close-up's chin instead of dropping it", () => {
    const frames = Array.from({ length: 40 }, (_, i) => closeUp(i / 4));
    const { kept, dropped, trimmed } = dropFaceOverlaps([band], frames);
    assert.equal(dropped.length, 0);
    assert.equal(trimmed.length, 1);
    assert.ok(kept[0]!.y1 >= 0.65 && kept[0]!.y1 <= 0.67, `top edge ${kept[0]!.y1}`);
    assert.equal(kept[0]!.y2, band.y2);
  });

  it("still drops a region that sits on the face itself (scene texture)", () => {
    const shelf: SourceOverlay = { x1: 0.4, x2: 0.7, y1: 0.25, y2: 0.4, kind: "caption", coverage: 0.5 };
    const frames = Array.from({ length: 40 }, (_, i) => closeUp(i / 4));
    const { kept, dropped } = dropFaceOverlaps([shelf], frames);
    assert.deepEqual(kept, []);
    assert.equal(dropped.length, 1);
  });

  it("leaves a band clear of faces alone", () => {
    const low = { ...band, y1: 0.7 };
    const { kept, trimmed } = dropFaceOverlaps([low], Array.from({ length: 20 }, (_, i) => closeUp(i / 4)));
    assert.deepEqual(kept, [low]);
    assert.equal(trimmed.length, 0);
  });
});

describe("tightenOverlays", () => {
  const frame = (t: number, boxes: ClipTextFrame["boxes"]): ClipTextFrame => ({ t, boxes, all: boxes, slide: false, textHeavy: false });
  const short = { x1: 0.4, y1: 0.8, x2: 0.6, y2: 0.86 };
  const twoLines = [{ x1: 0.2, y1: 0.68, x2: 0.8, y2: 0.75 }, { x1: 0.15, y1: 0.78, x2: 0.85, y2: 0.86 }];

  it("blurs a one-word line only over that line, and the two-line caption over both", () => {
    const frames = [...Array.from({ length: 10 }, (_, i) => frame(i / 2, [short])), ...Array.from({ length: 10 }, (_, i) => frame(5 + i / 2, twoLines))];
    const pieces = tightenOverlays([{ ...band, y1: 0.66 }], frames, 10);
    assert.equal(pieces.length, 2);
    const [a, b] = pieces;
    assert.ok(a!.x1 > 0.38 && a!.x2 < 0.62 && a!.y1 > 0.78, `first piece ${JSON.stringify(a)}`);
    assert.ok(b!.x1 < 0.16 && b!.y1 < 0.68, `second piece ${JSON.stringify(b)}`);
    for (const p of pieces) assert.equal(p.windows?.length, 1);
    // windows overlap around the change, so the switch is never uncovered
    assert.ok(a!.windows![0]![1] > b!.windows![0]![0]);
  });

  it("leaves still scene text beside the band out (a bottle label above the captions), keeps a still handle the project scan found", () => {
    const label = { x1: 0.42, y1: 0.55, x2: 0.47, y2: 0.6 };
    const handle = { x1: 0.45, y1: 0.77, x2: 0.55, y2: 0.79 };
    const frames = Array.from({ length: 20 }, (_, i) => frame(i / 2, [label, handle, i % 4 < 2 ? short : twoLines[1]!]));
    const pieces = tightenOverlays([band], frames, 10, { cores: [{ x1: 0.105, y1: 0.616, x2: 0.875, y2: 0.904 }] });
    assert.ok(pieces.every((p) => p.y1 > 0.6), JSON.stringify(pieces.map((p) => [p.y1, p.y2])));
    assert.ok(pieces.every((p) => p.y1 <= 0.77), "the handle is still covered");
  });

  it("caps the number of pieces per region", () => {
    const frames = Array.from({ length: 60 }, (_, i) => frame(i * 2, [i % 2 ? short : twoLines[1]!]));
    assert.ok(tightenOverlays([band], frames, 120, { maxPieces: 5 }).length <= 5);
  });

  it("keeps watermarks and frameless regions as they are", () => {
    const logo: SourceOverlay = { x1: 0, x2: 0.129, y1: 0.869, y2: 1, kind: "watermark", coverage: 0.9 };
    assert.deepEqual(tightenOverlays([logo], [frame(0, [{ x1: 0.01, y1: 0.9, x2: 0.1, y2: 0.95 }])], 5), [logo]);
    assert.deepEqual(tightenOverlays([band], [], 5), [band]);
  });
});

describe("sourceVideo", () => {
  it("feathers the patch and fades a single window in before it and out after it", () => {
    const { prefix } = sourceVideo([{ ...band, windows: [[2, 6]] }], 1920, 1080, 1);
    assert.match(prefix, /alphaextract,lutyuv=y=255,crop=\d+:\d+:\d+:\d+,pad=/);
    assert.match(prefix, /fade=t=in:st=1\.75:d=0\.25,fade=t=out:st=6\.00:d=0\.25/);
    assert.match(prefix, /enable='between\(t,1\.75,6\.25\)'/);
  });

  it("starts a window at 0 without a fade-in, and keeps an untimed region always on", () => {
    assert.doesNotMatch(sourceVideo([{ ...band, windows: [[0, 4]] }], 1920, 1080, 1).prefix, /fade=t=in/);
    const always = sourceVideo([band], 1920, 1080, 2).prefix;
    assert.doesNotMatch(always, /enable=|fade=/);
    assert.match(always, /alphamerge/);
  });
});

describe("captions on the seam", () => {
  it("places the seam of each layout", () => {
    assert.equal(layoutSeamY("split", undefined, 1920, 1080), 0.5);
    assert.equal(layoutSeamY("stack", { x1: 0, y1: 0, x2: 0.6, y2: 1 }, 1920, 1080), 0.5);
    assert.equal(layoutSeamY("stack", undefined, 1920, 1080), 0.3167);
    assert.equal(layoutSeamY("stack", undefined, 1080, 1920), null);
    assert.equal(layoutSeamY("face", undefined, 1920, 1080), null);
  });

  it("moves lines onto the seam only in split / stack stretches long enough to hold them", () => {
    const runs = mergeSeamRuns([
      { start: 0, end: 15, y: null },
      { start: 15, end: 17, y: 0.5 },
      { start: 17, end: 21, y: null },
      { start: 21, end: 26, y: 0.5 },
      { start: 26, end: 33, y: 0.5 },
    ]);
    assert.equal(runs.length, 4);
    assert.equal(captionYAt(defaultStyle, runs, 5), 0.72);
    assert.equal(captionYAt(defaultStyle, runs, 16), 0.72); // a 2 s split keeps captions where they were
    assert.equal(captionYAt(defaultStyle, runs, 30), 0.5);
    assert.equal(captionYAt({ ...defaultStyle, captionSeam: false }, runs, 30), 0.72);
  });

  it("writes each caption line at its own position in the ASS file", () => {
    const words = [
      { text: "before", start: 1, end: 1.5 },
      { text: "during", start: 12, end: 12.5 },
    ];
    const ass = buildAss(words, { width: 1080, height: 1920, font: "Inter", style: { ...defaultStyle, captions: "plain" }, seams: [{ start: 10, end: 20, y: 0.5 }] });
    assert.match(ass, /\\pos\(540,1382\)\}before/);
    assert.match(ass, /\\pos\(540,960\)\}during/);
  });
});
