/**
 * A sparse source (pipeline/sparse.ts): the downloaded ranges laid on the source clock with filler between them, and
 * the probe facts a stream-copy join has to match.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { concatPlan, joinShape } from "../src/pipeline/sparse.js";

describe("concatPlan", () => {
  it("fills the gaps before, between and after the ranges, each part cut to its length", () => {
    assert.deepEqual(
      concatPlan(
        [
          { startSec: 100.5, endSec: 170.25 },
          { startSec: 300, endSec: 330 },
        ],
        636,
      ),
      [
        { kind: "filler", sec: 100.5 },
        { kind: "piece", index: 0, sec: 69.75 },
        { kind: "filler", sec: 129.75 },
        { kind: "piece", index: 1, sec: 30 },
        { kind: "filler", sec: 306 },
      ],
    );
  });
  it("needs no filler where a range starts at 0 or ends at the end", () => {
    assert.deepEqual(concatPlan([{ startSec: 0, endSec: 60 }], 60), [{ kind: "piece", index: 0, sec: 60 }]);
  });
});

describe("joinShape", () => {
  it("is what a stream-copy join must match, or null when the probe lacks it", () => {
    const full = {
      durationSec: 30,
      hasAudio: true,
      width: 640,
      height: 360,
      videoCodec: "h264",
      audioCodec: "aac",
      sampleRate: 44100,
      channels: 2,
      videoTimescale: 15360,
    };
    assert.deepEqual(joinShape(full), {
      width: 640,
      height: 360,
      videoCodec: "h264",
      audioCodec: "aac",
      sampleRate: 44100,
      channels: 2,
      videoTimescale: 15360,
    });
    const { audioCodec: _a, ...noAudio } = full;
    assert.equal(joinShape(noAudio), null);
  });
});
