/** A clip's bounds never invert: a candidate past the end it is clamped to has no clip, not one ending before it starts. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultProjectSettings } from "@reelsaw/shared";
import { exactRangeBounds, snapCandidate } from "../src/pipeline/analyze.js";

const settings = { ...defaultProjectSettings, minClipSeconds: 15, maxClipSeconds: 60 };
// a sentence every 6 s from 1790 s to 1910 s: a range added to a partly processed video, far past its 600 s limit
const segments = Array.from({ length: 20 }, (_, i) => ({ start: 1790 + i * 6, end: 1790 + i * 6 + 5.5, text: "" }));
const candidate = { title: "t", hook: "h", startSec: 1810, endSec: 1850, score: 80, reasoning: "", caption: "", hashtags: [] };

describe("range clip bounds", () => {
  it("a candidate that starts past the end it is clamped to is dropped", () => {
    assert.equal(snapCandidate(candidate, segments, [], settings, 600), null);
  });

  it("snaps normally when the end is the video's length", () => {
    const c = snapCandidate(candidate, segments, [], settings, 3600);
    assert.ok(c);
    assert.ok(c.endSec > c.startSec + settings.minClipSeconds, `${c.startSec}–${c.endSec}`);
  });

  it("an exact range keeps its own bounds rather than inverting when the end is short", () => {
    const c = exactRangeBounds({ startSec: 1800, endSec: 1900 }, segments, [], settings, 600);
    assert.ok(c.endSec > c.startSec, `${c.startSec}–${c.endSec}`);
  });
});
