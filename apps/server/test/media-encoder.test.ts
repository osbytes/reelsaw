/** Encoder selection: which encoders a setting probes, and the per-encoder ffmpeg arguments. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encoderCandidates, videoEncodeArgs } from "../src/media.js";
import { normaliseArgs } from "../src/pipeline/bumpers.js";

describe("video encoder", () => {
  it("auto probes NVENC everywhere and VideoToolbox only on macOS, in that order", () => {
    assert.deepEqual(encoderCandidates("auto", "linux"), ["h264_nvenc"]);
    assert.deepEqual(encoderCandidates("auto", "win32"), ["h264_nvenc"]);
    assert.deepEqual(encoderCandidates("auto", "darwin"), ["h264_nvenc", "h264_videotoolbox"]);
  });

  it("a named encoder is probed alone; libx264 is never probed", () => {
    assert.deepEqual(encoderCandidates("h264_nvenc", "darwin"), ["h264_nvenc"]);
    assert.deepEqual(encoderCandidates("h264_videotoolbox", "linux"), ["h264_videotoolbox"]);
    assert.deepEqual(encoderCandidates("libx264", "linux"), []);
  });

  it("every encoder's arguments start with -c:v and leave pix_fmt and rate to the caller", () => {
    for (const enc of ["libx264", "h264_nvenc", "h264_videotoolbox"] as const) {
      const args = videoEncodeArgs(enc);
      assert.equal(args[0], "-c:v");
      assert.equal(args[1], enc);
      assert.ok(!args.includes("-pix_fmt") && !args.includes("-r"));
    }
    // the reference quality settings stay what every clip rendered so far was encoded with
    assert.deepEqual(videoEncodeArgs("libx264"), ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"]);
  });

  it("bumper normalisation takes the encoder in use and defaults to libx264", () => {
    const asset = { durationSec: 2, hasAudio: true };
    const canvas = { width: 1080, height: 1920, fitChain: "[0:v]scale=1080:1920" };
    const soft = normaliseArgs("in.mp4", "out.mp4", asset, canvas);
    assert.ok(soft.includes("libx264"));
    const hard = normaliseArgs("in.mp4", "out.mp4", asset, canvas, videoEncodeArgs("h264_nvenc"));
    assert.ok(hard.includes("h264_nvenc") && !hard.includes("libx264"));
    // the output format is the same whichever encoder runs
    for (const a of [soft, hard]) assert.ok(a.includes("yuv420p") && a.includes("+faststart"));
  });
});
