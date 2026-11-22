/**
 * A long video the account's minutes cover only the start of: admitted as its start (whole transcription chunks),
 * extended later from where it stopped. The pure parts: how much is admitted, which chunks a run transcribes,
 * and how the rest's words join the transcript without moving the words (and the fixes on them) already there.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processedEndSec, spansCover, type TranscriptFlag, type Word } from "@reelsaw/shared";
import { partialUntil } from "../src/quota.js";
import { audioChunks, legacyCoveredSec, mergeTranscript, neededSpans } from "../src/pipeline/transcribe.js";
import { partialPrecheckSentence } from "../src/projects/service.js";

const CHUNK = 600;

describe("partialUntil", () => {
  it("admits the whole video when it fits, or when there is no minutes limit", () => {
    assert.deepEqual(partialUntil(50 * 60, 0, 60 * 60, CHUNK), { until: null });
    assert.deepEqual(partialUntil(5 * 3600, 0, null, CHUNK), { until: null });
  });
  it("admits a Free account's long first video as its first 60 minutes", () => {
    assert.deepEqual(partialUntil(134 * 60, 0, 60 * 60, CHUNK), { until: 3600 });
  });
  it("rounds the start down to whole chunks, so an extension starts on a chunk boundary", () => {
    assert.deepEqual(partialUntil(90 * 60, 0, 17 * 60, CHUNK), { until: 600 });
  });
  it("refuses only when less than one chunk fits", () => {
    assert.equal(partialUntil(90 * 60, 0, 9 * 60, CHUNK), "none");
    assert.equal(partialUntil(90 * 60, 0, 0, CHUNK), "none");
  });
  it("extends from where it stopped: all of the rest, or more whole chunks of it", () => {
    assert.deepEqual(partialUntil(134 * 60, 3600, 100 * 60, CHUNK), { until: null });
    assert.deepEqual(partialUntil(240 * 60, 3600, 100 * 60, CHUNK), { until: 3600 + 10 * 600 });
  });
  it("lets a video a moment over the room through whole (screens round it to the same minutes)", () => {
    assert.deepEqual(partialUntil(3600.3, 0, 3600, CHUNK), { until: null });
  });
});

describe("processedEndSec", () => {
  it("is the limit of a partial project, else the video", () => {
    assert.equal(processedEndSec({ durationSec: 8040, sourceLimitSec: 3600 }), 3600);
    assert.equal(processedEndSec({ durationSec: 8040, sourceLimitSec: null }), 8040);
    assert.equal(processedEndSec({ durationSec: 1200, sourceLimitSec: 3600 }), 1200);
    assert.equal(processedEndSec({ durationSec: null }), null);
  });
});

describe("what a transcript must cover", () => {
  it("is the processed start of a project from before ranges, else its ranges", () => {
    assert.deepEqual(neededSpans({ durationSec: 8040, sourceLimitSec: 3600 }, []), [[0, 3600]]);
    assert.deepEqual(neededSpans({ durationSec: 8040, sourceLimitSec: null }, []), [[0, 8040]]);
    // a whole range has no padding; chosen ranges get 15 s on each side, clamped to the video
    assert.deepEqual(
      neededSpans({ durationSec: 8040 }, [
        { startSec: 0, endSec: 3600, origin: "whole" },
        { startSec: 3600, endSec: 4200, origin: "whole" },
      ]),
      [[0, 4200]],
    );
    assert.deepEqual(
      neededSpans({ durationSec: 8040 }, [
        { startSec: 5, endSec: 60, origin: "user" },
        { startSec: 8000, endSec: 8040, origin: "api" },
      ]),
      [
        [0, 75],
        [7985, 8040],
      ],
    );
  });
  it("knows a partial transcript from a whole one", () => {
    assert.equal(spansCover([[0, 3600]], [[0, 3600]]), true);
    assert.equal(spansCover([[0, 3600]], [[0, 7200]]), false);
    assert.equal(spansCover([[0, 3600.2]], [[0, 3600.5]]), true);
    assert.equal(spansCover([], [[0, 60]]), false);
  });
  it("writes the old covered end only for a transcript of the video's start", () => {
    assert.equal(legacyCoveredSec([[0, 3600]], 8040), 3600);
    assert.equal(legacyCoveredSec([[0, 8040]], 8040), null);
    assert.equal(legacyCoveredSec([[100, 200]], 8040), null);
    assert.equal(
      legacyCoveredSec(
        [
          [0, 60],
          [100, 200],
        ],
        8040,
      ),
      null,
    );
  });
});

describe("audioChunks", () => {
  it("places each chunk of a stretch on the source clock, keyed by its offset", () => {
    assert.deepEqual(audioChunks(4500, [600, 300.5]), [
      { index: 45000, offsetSec: 4500, endSec: 5100, file: 0 },
      { index: 51000, offsetSec: 5100, endSec: 5400.5, file: 1 },
    ]);
  });
  it("leaves out the muxer's sliver past the last cut", () => {
    assert.deepEqual(
      audioChunks(0, [60.012, 60.012, 59.976, 0.004]).map((c) => c.file),
      [0, 1, 2],
    );
  });
});

describe("mergeTranscript", () => {
  const w = (text: string, start: number): Word => ({ text, start, end: start + 0.4 });
  const fix: TranscriptFlag = { kind: "disfluency", wordIndex: 0, span: 1, suggested: "", status: "accepted", start: 0, end: 0.4 } as TranscriptFlag;
  it("adds a later part after the words there, shifting its own flags past them", () => {
    const raw = [w("uh", 0), w("hello", 1), w("world", 2)];
    const loop: TranscriptFlag = { kind: "loop", wordIndex: 1, span: 2, suggested: "go", status: "auto", start: 3601, end: 3603 } as TranscriptFlag;
    const added = [w("and", 3600), w("go", 3601), w("go", 3602), w("now", 3603)];
    const out = mergeTranscript({ words: raw.slice(1), rawWords: raw, flags: [fix] }, { rawWords: added, flags: [loop] });
    assert.equal(out.rawWords.length, 7);
    assert.deepEqual(
      out.flags.map((f) => [f.kind, f.wordIndex, f.span]),
      [
        ["disfluency", 0, 1],
        ["loop", 4, 2],
      ],
    );
    assert.deepEqual(
      out.words.map((x) => x.text),
      ["hello", "world", "and", "go", "now"],
    );
  });
  it("puts an earlier range's words before the words there and moves every fix, deleted ones too, with its words", () => {
    const raw = [w("uh", 5000), w("later", 5001), w("on", 5002)];
    const deleted = { ...fix, wordIndex: 2, deletedAt: "2026-11-22T00:00:00Z" };
    const added = [w("first", 1500), w("words", 1501)];
    const out = mergeTranscript({ words: raw.slice(1), rawWords: raw, flags: [fix], deletedFlags: [deleted] }, { rawWords: added, flags: [] });
    assert.deepEqual(
      out.rawWords.map((x) => x.text),
      ["first", "words", "uh", "later", "on"],
    );
    assert.deepEqual(
      out.flags.map((f) => [f.wordIndex, f.span]),
      [[2, 1]],
    );
    assert.deepEqual(
      out.deletedFlags.map((f) => f.wordIndex),
      [4],
    );
    assert.deepEqual(
      out.words.map((x) => x.text),
      ["first", "words", "later", "on"],
    );
  });
});

describe("partialPrecheckSentence", () => {
  it("says what is clipped and which allowance set it, never a minutes-left number rounded to chunks", () => {
    // 25 minutes left, 10-minute chunks: 20 are clipped; the sentence must not claim 20 are left
    const s = partialPrecheckSentence(20 * 60, 90 * 60, "month", true);
    assert.equal(
      s,
      "This video is 90 minutes. Reelsaw clips the first 20 minutes now, as far as this period's minutes go. Upgrade any time to clip the rest; Reelsaw picks up where it stopped.",
    );
    assert.doesNotMatch(s, /left/);
  });
  it("names the day's limit when that is what cut it, and the first video's allowance when that did", () => {
    assert.match(partialPrecheckSentence(30 * 60, 90 * 60, "day", false), /as far as today's minutes go\. Reelsaw clips the rest when your minutes reset\.$/);
    assert.match(partialPrecheckSentence(3600, 134 * 60, "first_video", true), /clips the first 60 minutes now, free as your first video\./);
  });
});
