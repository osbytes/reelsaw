/**
 * The range planner (packages/shared/src/ranges.ts): every rule in docs/specs/range-clipping.md's table, the span
 * arithmetic under it, and the time parsing the timeline, the clip editor and the CLI share.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RANGES,
  RANGE_MIN_SEC,
  mergeSpans,
  parseClock,
  parseRangeArg,
  planRanges,
  replayPeaks,
  spansSec,
  subtractSpans,
  type RangePlan,
} from "@reelsaw/shared";
import { rangeProblemsText } from "../src/projects/ranges.js";

const D = 11524; // a 3:12:04 stream
const opts = { durationSec: D, maxClipSec: 180, padSec: 15, fetchGapSec: 60 };

function planned(p: RangePlan) {
  assert.ok(p.ok, `expected a plan, got ${JSON.stringify(p)}`);
  return p;
}

function only<T>(xs: readonly T[]): T {
  assert.equal(xs.length, 1);
  const [x] = xs;
  assert.ok(x !== undefined);
  return x;
}

describe("span arithmetic", () => {
  it("merges overlapping and touching spans, keeps gaps", () => {
    assert.deepEqual(
      mergeSpans([
        [50, 60],
        [0, 10],
        [10, 20],
        [15, 30],
      ]),
      [
        [0, 30],
        [50, 60],
      ],
    );
  });
  it("joins spans within a gap", () => {
    assert.deepEqual(
      mergeSpans(
        [
          [0, 10],
          [40, 50],
          [200, 210],
        ],
        30,
      ),
      [
        [0, 50],
        [200, 210],
      ],
    );
  });
  it("subtracts processed time, leaving what is new", () => {
    assert.deepEqual(subtractSpans([[0, 100]], [[20, 30]]), [
      [0, 20],
      [30, 100],
    ]);
    assert.deepEqual(subtractSpans([[0, 100]], [[0, 100]]), []);
    assert.deepEqual(subtractSpans([[50, 100]], [[0, 60]]), [[60, 100]]);
    assert.equal(
      spansSec([
        [0, 10],
        [5, 20],
      ]),
      20,
    );
  });
});

describe("planRanges", () => {
  it("prices three ranges by their own length, padding not counted", () => {
    const p = planned(
      planRanges(
        [
          { startSec: 1500, endSec: 1610, mode: "clip" },
          { startSec: 4500, endSec: 5400 },
          { startSec: 7740, endSec: 7880, mode: "clip" },
        ],
        opts,
      ),
    );
    assert.equal(p.billedSec, 110 + 900 + 140);
    assert.deepEqual(
      p.ranges.map((r) => [r.startSec, r.endSec, r.mode]),
      [
        [1500, 1610, "clip"],
        [4500, 5400, "find"],
        [7740, 7880, "clip"],
      ],
    );
    assert.deepEqual(p.fetch, [
      [1485, 1625],
      [4485, 5415],
      [7725, 7895],
    ]);
    assert.deepEqual(p.changes, []);
  });

  it("merges overlaps, find winning, and says so", () => {
    const p = planned(
      planRanges(
        [
          { startSec: 100, endSec: 200, mode: "clip", ref: "a" },
          { startSec: 150, endSec: 260, mode: "find", ref: "b" },
        ],
        opts,
      ),
    );
    const r = only(p.ranges);
    assert.deepEqual([r.startSec, r.endSec, r.mode, r.ref, r.inputs], [100, 260, "find", "a", [0, 1]]);
    assert.deepEqual(p.changes, [{ kind: "merged", inputs: [0, 1], startSec: 100, endSec: 260 }]);
    assert.equal(p.billedSec, 160);
  });

  it("fetches close ranges in one download but keeps and bills them apart", () => {
    const p = planned(
      planRanges(
        [
          { startSec: 1000, endSec: 1060 },
          { startSec: 1100, endSec: 1160 },
        ],
        opts,
      ),
    );
    assert.equal(p.ranges.length, 2);
    assert.equal(p.billedSec, 120);
    assert.deepEqual(p.fetch, [[985, 1175]]);
  });

  it("clamps padding and an end past the video to its length", () => {
    const p = planned(
      planRanges(
        [
          { startSec: 5, endSec: 60 },
          { startSec: D - 30, endSec: D + 100 },
        ],
        opts,
      ),
    );
    assert.deepEqual(p.fetch[0], [0, 75]);
    assert.deepEqual(p.fetch.at(-1), [D - 45, D]);
    assert.deepEqual(p.changes, [{ kind: "clamped", input: 1, endSec: D }]);
    assert.equal(p.billedSec, 55 + 30);
  });

  it("turns an exact clip longer than the longest clip into a find range", () => {
    const p = planned(planRanges([{ startSec: 0, endSec: 400, mode: "clip" }], opts));
    assert.equal(only(p.ranges).mode, "find");
    assert.deepEqual(p.changes, [{ kind: "exact_too_long", inputs: [0], maxClipSec: 180 }]);
  });

  it("bills and fetches only time not processed before", () => {
    const p = planned(planRanges([{ startSec: 500, endSec: 900 }], { ...opts, processed: [[0, 600]] }));
    assert.equal(p.billedSec, 300);
    assert.deepEqual(p.fetch, [[585, 915]]);
    const again = planned(planRanges([{ startSec: 100, endSec: 200 }], { ...opts, processed: [[0, 600]] }));
    assert.equal(again.billedSec, 0);
    assert.deepEqual(again.fetch, []);
    assert.deepEqual(again.changes, [{ kind: "already_processed", inputs: [0] }]);
  });

  it("accepts ranges on a video of unknown length without clamping", () => {
    const p = planned(planRanges([{ startSec: 100, endSec: 200 }], { ...opts, durationSec: null }));
    assert.deepEqual(p.fetch, [[85, 215]]);
  });

  it("refuses what cannot be a range, naming each one", () => {
    const p = planRanges(
      [
        { startSec: 300, endSec: 200 },
        { startSec: D + 1, endSec: D + 50 },
        { startSec: 10, endSec: 10 + RANGE_MIN_SEC - 1 },
        { startSec: 0, endSec: 60 },
      ],
      opts,
    );
    assert.ok(!p.ok);
    assert.deepEqual(
      p.problems.map((x) => x.kind),
      ["end_before_start", "past_end", "too_short"],
    );
    assert.deepEqual(rangeProblemsText(p.problems.slice(1)), ["Range 2 starts after the video ends (3:12:04).", "Range 3 is shorter than 10 seconds."]);
  });

  it("refuses none and too many", () => {
    const none = planRanges([], opts);
    assert.ok(!none.ok && none.problems[0]?.kind === "none");
    const many = planRanges(
      Array.from({ length: MAX_RANGES + 1 }, (_, i) => ({ startSec: i * 100, endSec: i * 100 + 20 })),
      opts,
    );
    assert.ok(!many.ok && many.problems[0]?.kind === "too_many");
  });
});

describe("time parsing", () => {
  it("reads h:mm:ss, m:ss and seconds", () => {
    assert.equal(parseClock("1:15:00"), 4500);
    assert.equal(parseClock("25:00"), 1500);
    assert.equal(parseClock("1:05.5"), 65.5);
    assert.equal(parseClock(" 90 "), 90);
  });
  it("refuses what is not a time", () => {
    for (const t of ["", "1:75", "a:00", "1:2:3:4", "-5", "1::0"]) assert.equal(parseClock(t), null, t);
  });
  it("reads a CLI --range value", () => {
    assert.deepEqual(parseRangeArg("25:00-26:50:clip"), { startSec: 1500, endSec: 1610, mode: "clip" });
    assert.deepEqual(parseRangeArg("1:15:00-1:30:00"), { startSec: 4500, endSec: 5400, mode: "find" });
    assert.equal(parseRangeArg("1:15:00"), null);
    assert.equal(parseRangeArg("1:15:00-1:30:00:both"), null);
  });
});

describe("replayPeaks", () => {
  // 100 bins of 6 s (a 10-minute video): a big peak at bin 20, a smaller one at 70, the rest flat
  const bins = Array.from({ length: 100 }, (_, i) => ({
    startSec: i * 6,
    endSec: i * 6 + 6,
    value: i === 20 ? 1 : i === 19 || i === 21 ? 0.7 : i === 70 ? 0.5 : i === 71 ? 0.3 : 0.1,
  }));
  it("finds the hottest stretches, hottest first, widened while half as hot", () => {
    assert.deepEqual(replayPeaks(bins), [
      { startSec: 114, endSec: 132, heat: 1 },
      { startSec: 420, endSec: 432, heat: 0.5 },
    ]);
  });
  it("takes the top n", () => {
    assert.equal(replayPeaks(bins, { top: 1 }).length, 1);
  });
  it("finds nothing in a flat or missing heatmap", () => {
    assert.deepEqual(replayPeaks(bins.map((b) => ({ ...b, value: 0.2 }))), []);
    assert.deepEqual(replayPeaks([]), []);
  });
});
