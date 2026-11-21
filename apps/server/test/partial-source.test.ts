/**
 * A long video the account's minutes cover only the start of: admitted as its start (whole transcription chunks),
 * extended later from where it stopped. The pure parts: how much is admitted, which chunks a run transcribes,
 * and how the rest's words join the transcript without moving the words (and the fixes on them) already there.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processedEndSec, type TranscriptFlag, type Word } from "@reelsaw/shared";
import { partialUntil } from "../src/quota.js";
import { appendTranscript, chunksFrom, transcriptCovers } from "../src/pipeline/transcribe.js";

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

describe("transcriptCovers", () => {
  it("knows a partial transcript from a whole one", () => {
    assert.equal(transcriptCovers(null, null), true);
    assert.equal(transcriptCovers(null, 3600), true);
    assert.equal(transcriptCovers(3600, 3600), true);
    assert.equal(transcriptCovers(3600, 7200), false);
    assert.equal(transcriptCovers(3600, null), false);
  });
});

describe("chunksFrom", () => {
  const offsets = [0, 600, 1200, 1800, 2400, 3000, 3600.02, 4200.04];
  it("is every chunk for a new transcript", () => {
    assert.deepEqual(chunksFrom(offsets, 4500, 0), [0, 1, 2, 3, 4, 5, 6, 7]);
  });
  it("skips the chunks a partial transcript already covers (a frame of slack at the boundary)", () => {
    assert.deepEqual(chunksFrom(offsets, 4500, 3600), [6, 7]);
  });
  it("leaves out the muxer's sliver past the last whole chunk of a partial run", () => {
    // audio cut at 240 s, chunked at 60 s: the cuts land a few ms late, so a 4th-to-5th chunk of milliseconds is left over
    assert.deepEqual(chunksFrom([0, 60.012, 120.024, 180, 239.996], 240, 0), [0, 1, 2, 3]);
  });
  it("keeps a chunk that straddles the covered end (another chunk length)", () => {
    assert.deepEqual(chunksFrom([0, 700, 1400, 2100], 2400, 1200), [1, 2, 3]);
  });
});

describe("appendTranscript", () => {
  const w = (text: string, start: number): Word => ({ text, start, end: start + 0.4 });
  it("keeps the old words and their fixes where they were and shifts the new part's flags past them", () => {
    const raw = [w("uh", 0), w("hello", 1), w("world", 2)];
    const fix: TranscriptFlag = { kind: "disfluency", wordIndex: 0, span: 1, suggested: "", status: "accepted", start: 0, end: 0.4 } as TranscriptFlag;
    const loop: TranscriptFlag = { kind: "loop", wordIndex: 1, span: 2, suggested: "go", status: "auto", start: 3601, end: 3603 } as TranscriptFlag;
    const added = [w("and", 3600), w("go", 3601), w("go", 3602), w("now", 3603)];
    const out = appendTranscript({ words: raw.slice(1), rawWords: raw, flags: [fix] }, { rawWords: added, flags: [loop] });
    assert.equal(out.rawWords.length, 7);
    assert.deepEqual(
      out.flags.map((f) => [f.kind, f.wordIndex]),
      [
        ["disfluency", 0],
        ["loop", 4],
      ],
    );
    assert.deepEqual(
      out.words.map((x) => x.text),
      ["hello", "world", "and", "go", "now"],
    );
  });
});
