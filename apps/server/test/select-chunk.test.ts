/** Map-window chunking and gleaning. Run: node --import tsx --test test/select-chunk.test.ts (no stack needed) */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ClipCandidate, TranscriptSegment } from "@reelsaw/shared";
import { chunkTranscript, inChunk, MAP_CHUNK_SECONDS, needsSecondLook, repairTimestamps, type Chunk } from "../src/pipeline/select.js";

const cand = (startSec: number, endSec: number): ClipCandidate => ({
  title: "t",
  hook: "h",
  startSec,
  endSec,
  score: 50,
  reasoning: "",
  caption: "",
  hashtags: [],
});

function talkingHead(durationSec: number, every = 5): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (let t = 0; t < durationSec; t += every) {
    out.push({
      start: t,
      end: Math.min(durationSec, t + every - 0.2),
      text: `This is a spoken sentence about budgeting number ${t} with enough words to look real.`,
    });
  }
  return out;
}

describe("chunkTranscript", () => {
  it("returns nothing for an empty transcript", () => {
    assert.deepEqual(chunkTranscript([]), []);
  });

  it("keeps a short video as one window", () => {
    const chunks = chunkTranscript(talkingHead(60));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.start, 0);
    assert.ok(chunks[0]!.end >= 59);
  });

  it("splits an 11-minute talking-head across the timeline instead of one opening window", () => {
    const segs = talkingHead(664);
    const chunks = chunkTranscript(segs);
    assert.ok(chunks.length >= 4, `expected ≥4 windows, got ${chunks.length}`);
    assert.equal(chunks[0]!.start, 0);
    assert.ok(Math.abs(chunks.at(-1)!.end - segs.at(-1)!.end) < 0.01);
    for (let i = 1; i < chunks.length; i++) {
      assert.ok(chunks[i]!.start <= chunks[i - 1]!.end, "gap between windows");
      const ov = (chunks[i - 1]!.end - chunks[i]!.start) / (chunks[i - 1]!.end - chunks[i - 1]!.start);
      assert.ok(ov <= 0.4, `overlap ${(ov * 100).toFixed(0)}%`);
    }
    for (const [i, ch] of chunks.entries()) {
      if (i === chunks.length - 1) continue;
      assert.ok(ch.end - ch.start <= MAP_CHUNK_SECONDS * 1.4, `window ${i} is ${ch.end - ch.start}s`);
    }
    const lastStart = chunks.at(-1)!.start;
    assert.ok(lastStart > 664 * 0.5, `last window starts at ${lastStart}s, still in the first half`);
  });
});

describe("needsSecondLook", () => {
  const long: Chunk = { lines: [], start: 0, end: 180 };
  it("skips short windows", () => {
    assert.equal(needsSecondLook({ start: 0, end: 90 }, []), false);
  });
  it("gleans when a long window returned one clip or none", () => {
    assert.equal(needsSecondLook(long, []), true);
    assert.equal(needsSecondLook(long, [{ startSec: 10, endSec: 40 }]), true);
  });
  it("gleans when several clips sit in the opening and leave a long tail", () => {
    assert.equal(
      needsSecondLook(long, [
        { startSec: 8, endSec: 28 },
        { startSec: 27, endSec: 48 },
        { startSec: 47, endSec: 70 },
      ]),
      true,
    );
  });
  it("does not glean when picks already span the window", () => {
    assert.equal(
      needsSecondLook(long, [
        { startSec: 10, endSec: 40 },
        { startSec: 80, endSec: 110 },
        { startSec: 145, endSec: 175 },
      ]),
      false,
    );
  });
});

describe("inChunk / repairTimestamps", () => {
  const later: Chunk = { lines: [], start: 400, end: 580 };
  it("drops a candidate that landed in the opening of the video instead of this window", () => {
    assert.equal(inChunk(cand(38, 59), later), false);
    assert.equal(inChunk(cand(410, 445), later), true);
  });
  it("keeps a candidate that overlaps the window edge", () => {
    assert.equal(inChunk(cand(175, 200), { start: 0, end: 180 }), true);
  });
  it("reads 5.28 as 5:28 when the raw value sits outside the window", () => {
    const r = repairTimestamps(cand(5.07, 5.28), { start: 300, end: 420 });
    assert.equal(r.startSec, 307);
    assert.equal(r.endSec, 328);
  });
  it("still reads 528 as 5:28", () => {
    const r = repairTimestamps(cand(457, 528), { start: 300, end: 420 });
    assert.equal(r.startSec, 297);
    assert.equal(r.endSec, 328);
  });
});
