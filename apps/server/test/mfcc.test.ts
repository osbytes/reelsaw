/**
 * MFCCs must match python_speech_features, which LR-ASD (vision/asd.ts) was trained on: a drift here
 * silently degrades active speaker detection. Reference rows were computed with python_speech_features 0.6.1
 * (`mfcc(int16_signal, 16000, numcep=13, winlen=0.025, winstep=0.010)`) on the same synthetic signal.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mfcc } from "../src/audio/mfcc.js";

const SR = 16000;
function signal(): Float32Array {
  const n = Math.floor(0.5 * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const x = (0.4 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 1300 * t)) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t));
    out[i] = Math.round(x * 32767) / 32768; // the int16 samples the reference read, as ffmpeg's f32le gives them
  }
  return out;
}

const REF: Record<number, number[]> = {
  0: [19.9418, 9.7131, -14.8713, -2.8614, 30.3373, 31.5418, -11.6135, -49.8464, -39.4852, -6.9681, -0.9428, -23.6611, -33.4149],
  10: [20.7526, 10.7164, -15.165, -4.4441, 28.7364, 31.0864, -10.7871, -48.3045, -38.2336, -6.6517, -2.1791, -25.7523, -35.1272],
  48: [19.6425, 17.6023, -15.3389, -11.0249, 20.9913, 27.041, -8.9867, -42.1378, -31.413, -2.1668, 0.5616, -22.7334, -31.692],
};

describe("mfcc", () => {
  it("matches python_speech_features frame for frame", () => {
    const { data, frames } = mfcc(signal(), SR);
    assert.equal(frames, 49);
    for (const [row, want] of Object.entries(REF))
      want.forEach((v, k) =>
        assert.ok(Math.abs(data[Number(row) * 13 + k]! - v) < 1e-3, `frame ${row} coefficient ${k}: ${data[Number(row) * 13 + k]} vs ${v}`),
      );
  });
});
