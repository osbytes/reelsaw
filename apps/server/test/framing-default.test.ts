/**
 * A project's default framing (`reframe` plus `reframeAdjust`): how it is read off one clip, how a clip without
 * sections of its own gets it, and how the render timeline falls back to it. No database needed.
 * Run: node --import tsx --test test/framing-default.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adjustOf, projectDefaultSection, projectSettingsSchema, projectSettingsPatchSchema, CLEARABLE_SETTINGS } from "@reelsaw/shared";
import { coverTimeline } from "../src/pipeline/layout.js";
import { framingOfClip } from "../src/projects/service.js";

const tile = { x1: 0.869, y1: 0.083, x2: 1, y2: 0.217 };

describe("adjustOf", () => {
  it("keeps what the user set and drops zero nudges and unset fields", () => {
    assert.deepEqual(adjustOf({ offsetX: 0, offsetY: -0.11, subjectX: 0, crop: tile }), { offsetY: -0.11, subjectX: 0, crop: tile });
    assert.equal(adjustOf({ offsetX: 0 }), undefined);
    assert.equal(adjustOf({}), undefined);
  });
});

describe("framingOfClip", () => {
  const clip = {
    startSec: 800,
    layoutSections: [
      { start: 800, end: 810, mode: "auto" as const },
      { start: 810, end: 858, mode: "stack" as const, crop: tile, offsetX: 0 },
    ],
  };
  it("takes the first section that is framed, with its adjustment", () => {
    assert.deepEqual(framingOfClip(clip), { reframe: "stack", adjust: { crop: tile } });
  });
  it("takes the section at a time when asked", () => {
    assert.deepEqual(framingOfClip(clip, 805), { reframe: "auto" });
    assert.deepEqual(framingOfClip(clip, 850), { reframe: "stack", adjust: { crop: tile } });
  });
  it("falls back to the legacy override, then to automatic", () => {
    assert.deepEqual(framingOfClip({ startSec: 0, layoutSections: null, layoutOverride: "none" }), { reframe: "fit" });
    assert.deepEqual(framingOfClip({ startSec: 0, layoutSections: [], layoutOverride: null }), { reframe: "auto" });
  });
});

describe("projectDefaultSection", () => {
  it("is one section over the clip with the project's mode and adjustment", () => {
    assert.deepEqual(projectDefaultSection({ reframe: "stack", reframeAdjust: { crop: tile } }, 10, 40), { start: 10, end: 40, mode: "stack", crop: tile });
    assert.deepEqual(projectDefaultSection({ reframe: "none" }, 0, 5), { start: 0, end: 5, mode: "fit" });
    assert.deepEqual(projectDefaultSection({}, 0, 5), { start: 0, end: 5, mode: "auto" });
  });
});

describe("project settings", () => {
  it("accept, patch and clear reframeAdjust", () => {
    const s = projectSettingsSchema.parse({ reframe: "stack", reframeAdjust: { crop: tile } });
    assert.deepEqual(s.reframeAdjust, { crop: tile });
    assert.ok(projectSettingsPatchSchema.safeParse({ reframeAdjust: { offsetX: 0.1 } }).success);
    assert.equal(projectSettingsPatchSchema.safeParse({ reframeAdjust: { crop: { x1: 0, y1: 0, x2: 0.01, y2: 1 } } }).success, false);
    assert.ok((CLEARABLE_SETTINGS as readonly string[]).includes("reframeAdjust"));
  });
});

describe("coverTimeline with the project's adjustment", () => {
  it("gives the project's adjustment to the time no section claims, and only there", () => {
    const whole = coverTimeline(10, [], "stack", { crop: tile });
    assert.deepEqual(whole, [{ start: 0, end: 10, mode: "stack", manual: false, adjust: { crop: tile } }]);
    const pieces = coverTimeline(10, [{ start: 4, end: 6, mode: "face", offsetX: 0.1 }], "stack", { crop: tile });
    assert.deepEqual(
      pieces.map((p) => [p.start, p.end, p.mode, p.adjust]),
      [
        [0, 4, "stack", { crop: tile }],
        [4, 6, "face", { offsetX: 0.1 }],
        [6, 10, "stack", { crop: tile }],
      ],
    );
  });
  it("an automatic section of the clip's own wins over the project's adjustment", () => {
    const pieces = coverTimeline(10, [{ start: 0, end: 10, mode: "auto" }], "stack", { crop: tile });
    assert.deepEqual(pieces, [{ start: 0, end: 10, mode: "auto", manual: false }]);
  });
});
