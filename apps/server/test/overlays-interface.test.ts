/**
 * Game and app interface vs burned-in text: regions from real scans (a Roblox gameplay report, the
 * Apollo podcast, Bradford match highlights) split by `splitInterface`.
 * No stack needed: node --import tsx --test test/overlays-interface.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SourceOverlay } from "@reelsaw/shared";
import { splitInterface } from "../src/pipeline/overlays.js";

const r = (kind: SourceOverlay["kind"], x1: number, y1: number, x2: number, y2: number, coverage = 0.5): SourceOverlay => ({ kind, x1, y1, x2, y2, coverage });

describe("splitInterface", () => {
  it("drops a game HUD: side panels and, with them, the edge-hugging corner boxes", () => {
    // the five regions the project scan found on the Roblox video (all game UI, no subtitles)
    const hud = [
      r("caption", 0.769, 0, 1, 0.233, 0.49),
      r("caption", 0, 0, 0.175, 0.262, 0.59),
      r("caption", 0.817, 0.63, 0.998, 0.778, 0.42),
      r("caption", 0.899, 0.296, 1, 0.463, 0.32),
      r("caption", 0.847, 0.48, 0.979, 0.593, 0.49),
    ];
    const { kept, ui } = splitInterface(hud);
    assert.deepEqual(kept, []);
    assert.equal(ui.length, 5);
  });

  it("drops an always-on menu in the corner of a game, and a side box clear of the edge", () => {
    const { kept } = splitInterface([
      r("caption", 0.867, 0.48, 1, 0.778),
      r("caption", 0.76, 0.099, 1, 0.242),
      r("watermark", 0, 0, 0.144, 0.074, 0.9),
      r("caption", 0.917, 0.296, 0.958, 0.37),
    ]);
    assert.deepEqual(kept, []);
  });

  it("keeps subtitles and a corner logo when nothing else points to an interface", () => {
    const apollo = [r("caption", 0.105, 0.667, 0.895, 0.815, 0.9), r("caption", 0.014, 0.889, 0.125, 0.98, 0.6)];
    assert.deepEqual(splitInterface(apollo), { kept: apollo, ui: [] });
  });

  it("keeps a centred subtitle band and a lower third beside a game HUD", () => {
    const band = r("caption", 0.3, 0.85, 0.7, 0.93);
    const lowerThird = r("caption", 0.11, 0.735, 0.43, 0.845);
    const { kept } = splitInterface([band, lowerThird, r("caption", 0.9, 0.3, 1, 0.46), r("caption", 0.85, 0.48, 0.98, 0.6)]);
    assert.deepEqual(kept, [band, lowerThird]);
  });

  it("drops a wide block halfway down one side: a shirt print in a multi-shot car interview, not subtitles", () => {
    // a two-camera car interview: the passenger's chest, then a channel bug and a corner tag
    const chest = r("caption", 0.6, 0.429, 0.862, 0.719, 0.43);
    const bug = r("watermark", 0.833, 0, 1, 0.074, 0.94);
    const tag = r("caption", 0, 0.889, 0.104, 1, 0.52);
    const { kept, ui } = splitInterface([chest, bug, tag]);
    assert.deepEqual(ui, [chest]);
    assert.deepEqual(kept, [bug, tag]);
  });

  it("two shirts, one on each side, are scene text but do not make a corner logo interface", () => {
    const left = r("caption", 0.08, 0.45, 0.38, 0.7, 0.4);
    const right = r("caption", 0.62, 0.45, 0.92, 0.7, 0.4);
    const bug = r("watermark", 0.86, 0, 1, 0.07, 0.95);
    const { kept, ui } = splitInterface([left, right, bug]);
    assert.deepEqual(kept, [bug]);
    assert.deepEqual(ui, [left, right]);
  });

  it("keeps a wide band halfway down that crosses the centre (subtitles placed high)", () => {
    const high = r("caption", 0.2, 0.55, 0.8, 0.68, 0.7);
    assert.deepEqual(splitInterface([high]).kept, [high]);
  });

  it("drops one mid-side box but keeps a corner bug when there is no second", () => {
    const bug = r("watermark", 0.7, 0.011, 1, 0.182, 0.95);
    const { kept, ui } = splitInterface([bug, r("caption", 0.688, 0.333, 0.729, 0.407)]);
    assert.deepEqual(kept, [bug]);
    assert.equal(ui.length, 1);
  });
});
