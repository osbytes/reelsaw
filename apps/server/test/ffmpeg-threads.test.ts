/** media.ffmpeg's thread count: placed before every input and the output, never written by a caller, filter pools capped. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { threadedArgv } from "../src/media.js";

const FILTERS = ["-filter_threads", "1", "-filter_complex_threads", "1"];

describe("threadedArgv", () => {
  it("puts -threads before every input (the decoders) and before the output (the encoder)", () => {
    const argv = threadedArgv(["-ss", "3", "-i", "a.mp4", "-loop", "1", "-i", "logo.png", "-filter_complex", "[0][1]overlay", "-c:v", "libx264", "out.mp4"], 4);
    assert.deepEqual(argv, [
      "-ss",
      "3",
      "-threads",
      "4",
      "-i",
      "a.mp4",
      "-loop",
      "1",
      "-threads",
      "4",
      "-i",
      "logo.png",
      "-filter_complex",
      "[0][1]overlay",
      "-c:v",
      "libx264",
      ...FILTERS,
      "-threads",
      "4",
      "out.mp4",
    ]);
  });
  it("light is one thread", () => {
    assert.deepEqual(threadedArgv(["-i", "a.mp4", "-frames:v", "1", "a.jpg"], "light"), [
      "-threads",
      "1",
      "-i",
      "a.mp4",
      "-frames:v",
      "1",
      ...FILTERS,
      "-threads",
      "1",
      "a.jpg",
    ]);
  });
  it("caps the filtergraph pools once, leaving a caller's own caps alone", () => {
    const argv = threadedArgv(["-i", "a.mp4", "-filter_complex", "[0]scale=2:2", ...FILTERS, "o.mp4"], 2);
    assert.equal(argv.filter((a) => a === "-filter_threads").length, 1);
    assert.equal(argv.filter((a) => a === "-filter_complex_threads").length, 1);
  });
  it("refuses a caller's own -threads: the lease is the only source of the number", () => {
    assert.throws(() => threadedArgv(["-threads", "8", "-i", "a.mp4", "out.mp4"], 2), /opts\.threads/);
  });
});
