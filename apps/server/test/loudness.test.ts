/**
 * Clips used to keep their source's level: more than 20 LU apart from one video to the next, and loud sources
 * peaking over 0 dBTP. The body now gets one gain to CLIP_LUFS and the mix a peak limiter; these run the same filters
 * through ffmpeg on a quiet source and a clipping one and measure what comes out of the AAC encode.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLIP_LUFS, PEAK_LIMITER, parseLoudnorm, speechGainDb, measureLoudness } from "../src/audio/loudness.js";

describe("speechGainDb", () => {
  it("brings a quiet clip up and a loud one down to the target", () => {
    assert.equal(speechGainDb({ inputLufs: -26, inputPeak: -8 }), 12);
    assert.equal(speechGainDb({ inputLufs: -6, inputPeak: 2 }), -8);
  });
  it("never boosts near-silence or trusts a wild measurement", () => {
    assert.equal(speechGainDb({ inputLufs: -70, inputPeak: -50 }), 0);
    assert.equal(speechGainDb({ inputLufs: -45, inputPeak: -30 }), 15);
    assert.equal(speechGainDb(null), 0);
  });
});

describe("parseLoudnorm", () => {
  it("reads the analysis block ffmpeg prints", () => {
    const stderr = `size=N/A time=00:00:05.00\n[Parsed_loudnorm_0 @ 0x55] \n{\n\t"input_i" : "-23.41",\n\t"input_tp" : "-4.20",\n\t"input_lra" : "3.10"\n}\n`;
    assert.deepEqual(parseLoudnorm(stderr), { inputLufs: -23.41, inputPeak: -4.2 });
  });
  it("is null for a source without audio", () => {
    assert.equal(parseLoudnorm("Output file #0 does not contain any stream"), null);
    assert.equal(parseLoudnorm(`[Parsed_loudnorm_0 @ 0x55]\n{ "input_i" : "-inf", "input_tp" : "-inf" }`), null);
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const media = {
  ffmpeg: async (args: string[]) => {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], { encoding: "utf8" });
    return { stdout: r.stdout, stderr: r.stderr };
  },
};

describe("clip loudness through ffmpeg", { skip: hasFfmpeg ? false : "ffmpeg not on PATH" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reelsaw-loudness-"));
  // speech-like: a 220 Hz tone gated on and off like syllables, at an amplitude plus a gain (aevalsrc clamps at
  // full scale, so a source over it is made with volume into float samples)
  const source = (name: string, amp: number, gainDb = 0) => {
    const f = path.join(dir, `${name}.wav`);
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `aevalsrc='${amp}*sin(2*PI*220*t)*gt(sin(2*PI*3*t),0)':s=48000:d=8`,
      "-af",
      `volume=${gainDb}dB`,
      "-ac",
      "2",
      "-c:a",
      "pcm_f32le",
      f,
    ]);
    return f;
  };
  const render = async (src: string) => {
    const m = await measureLoudness(media, src, 0, 8);
    const out = path.join(dir, `${path.basename(src, ".wav")}.m4a`);
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      src,
      "-filter_complex",
      `[0:a:0]volume=${speechGainDb(m)}dB[cn];[cn]${PEAK_LIMITER}[aout]`,
      "-map",
      "[aout]",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-ar",
      "48000",
      out,
    ]);
    const after = await measureLoudness(media, out, 0, 8);
    assert.ok(after);
    return { before: m, after };
  };

  it("a quiet source comes out at the target", async () => {
    const { before, after } = await render(source("quiet", 0.1));
    assert.ok(before && before.inputLufs < -24, `quiet source measured ${before?.inputLufs}`);
    assert.ok(Math.abs(after.inputLufs - CLIP_LUFS) <= 1, `got ${after.inputLufs} LUFS`);
    assert.ok(after.inputPeak <= -0.5, `true peak ${after.inputPeak} dBTP`);
  });

  it("a clipping source is brought down and stays under full scale", async () => {
    const { before, after } = await render(source("hot", 0.9, 6));
    assert.ok(before && before.inputPeak > 0, `hot source peak ${before?.inputPeak}`);
    assert.ok(Math.abs(after.inputLufs - CLIP_LUFS) <= 1.5, `got ${after.inputLufs} LUFS`);
    assert.ok(after.inputPeak <= -0.5, `true peak ${after.inputPeak} dBTP`);
  });
});
