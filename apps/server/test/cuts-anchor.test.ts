/** Seam verifier: token normalisation, position-anchored matching, and what happens when a cut can't be confirmed. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeToken, normalizeTokens, sameWord, type Word } from "@reelsaw/shared";
import { locate, refineCuts, MANUAL_NUDGE } from "../src/pipeline/audiocuts.js";

/** "text" tokens, each 0.4 s long with 0.05 s between, starting at `t0`. */
function words(spec: string, t0 = 0): Word[] {
  let t = t0;
  return spec.split(/\s+/).map((text) => {
    const w = { text, start: t, end: t + 0.4 };
    t = w.end + 0.05;
    return w;
  });
}

describe("token normalisation", () => {
  it("treats digits and number words as one", () => {
    assert.equal(normalizeToken("seven"), "7");
    assert.equal(normalizeToken("7"), "7");
    assert.equal(normalizeToken("Seven,"), "7");
    assert.ok(sameWord("Twenty", "20"));
    assert.equal(normalizeToken("hundred"), "100");
    assert.equal(normalizeToken("zero"), "0");
    assert.equal(normalizeToken("nineteen"), "19");
  });
  it("folds number runs", () => {
    assert.deepEqual(normalizeTokens(["twenty", "one", "days"]), ["21", "days"]);
    assert.deepEqual(normalizeTokens(["twenty-one", "days"]), ["21", "days"]);
    assert.deepEqual(normalizeTokens(["two", "hundred", "and", "five"]), ["200", "and", "5"]);
    assert.deepEqual(normalizeTokens(["one", "thousand", "five", "hundred"]), ["1500"]);
    assert.deepEqual(normalizeTokens(["21", "days"]), ["21", "days"]);
    assert.deepEqual(normalizeTokens(["one", "two", "three"]), ["1", "2", "3"]);
  });
  it("ignores case, punctuation and apostrophes", () => {
    assert.ok(sameWord("Don't", "dont"));
    assert.ok(sameWord("don’t", "DON'T"));
    assert.ok(sameWord("month.", "Month"));
    assert.deepEqual(normalizeTokens(["--", "Hello,", "World!"]), ["hello", "world"]);
  });
});

describe("position-anchored matching", () => {
  // the speaker says the sentence twice; the user cut the first
  const heard = words("last one Step 7 is to check in once a month Step 7 is to check in once a month for ten");
  const deleted = words("Step seven is to check in once a month");
  const first = { start: heard[2]!.start, end: heard[10]!.end };
  const second = { start: heard[11]!.start, end: heard[19]!.end };

  it("finds the occurrence that overlaps the cut, not the first text match", () => {
    const loc = locate(heard, heard[1], deleted, heard[11], first, { manual: true })!;
    assert.deepEqual([loc.from, loc.to], [2, 10]);
    const loc2 = locate(heard, heard[10], deleted, heard[20], second, { manual: true })!;
    assert.deepEqual([loc2.from, loc2.to], [11, 19]);
  });
  it("picks by position even when neighbours are no help", () => {
    const loc = locate(heard, undefined, deleted, undefined, second, { manual: true })!;
    assert.deepEqual([loc.from, loc.to], [11, 19]);
    const loc1 = locate(heard, undefined, deleted, undefined, first, { manual: true })!;
    assert.deepEqual([loc1.from, loc1.to], [2, 10]);
  });
  it("matches number words against digits", () => {
    const loc = locate(words("a Step 7 is"), words("a")[0], words("Step seven is"), undefined, { start: 0.45, end: 1.8 })!;
    assert.deepEqual([loc.from, loc.to], [1, 3]);
  });
  it("tolerates drift in a phrase of four or more words", () => {
    const drifted = words("last one Step 7 is to check in once I'm Step 7");
    const loc = locate(drifted, drifted[1], deleted, drifted[10], first, { manual: true })!;
    assert.equal(loc.from, 2);
    const oneOff = words("so check in once a year ok");
    const loc2 = locate(oneOff, oneOff[0], words("check in once a month"), oneOff[6], { start: 0.45, end: 2.7 })!;
    assert.deepEqual([loc2.from, loc2.to, loc2.drift], [1, 5, 1]);
    // short phrases stay exact
    assert.equal(locate(words("so in once"), undefined, words("in twice"), undefined, { start: 0.45, end: 1 }, { manual: true }), null);
  });
  it("ignores an occurrence far from the cut", () => {
    const far = { start: 20, end: 21 };
    assert.equal(locate(heard, undefined, deleted, undefined, far, { manual: true }), null);
  });
  it("an automatic cut still needs a neighbour to anchor it; a manual one does not", () => {
    const ws = words("alpha um beta");
    const del = [ws[1]!];
    assert.equal(locate(words("x um y"), ws[0], del, ws[2], { start: 0.45, end: 0.85 }), null);
    assert.ok(locate(words("x um y"), ws[0], del, ws[2], { start: 0.45, end: 0.85 }, { manual: true }));
    assert.ok(locate(ws, ws[0], del, ws[2], { start: 0.45, end: 0.85 }));
  });
});

describe("a cut that cannot be confirmed", () => {
  const ffmpeg = "ffmpeg";
  let haveFfmpeg = true;
  try {
    execFileSync(ffmpeg, ["-version"], { stdio: "ignore" });
  } catch {
    haveFfmpeg = false;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuts-anchor-"));
  const wav = path.join(dir, "tone.wav");
  if (haveFfmpeg) execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=8", "-ar", "16000", "-ac", "1", wav]);

  // the recogniser hears something unrelated, so the removed text can never be found
  const transcript = words("nothing like the expected words here at all");
  const run = (manual: boolean) =>
    refineCuts({ ffmpegPath: ffmpeg, transcribe: async () => transcript }, wav, 0, 8, [{ start: 2, end: 3.6, ...(manual ? { manual: true } : {}) }], [...words("before", 0.8), ...words("uh sure thing yes", 2), ...words("after", 3.8)]);

  it("a manual cut is applied at the user's bounds, unverified, with the reason", { skip: !haveFfmpeg }, async () => {
    const res = await run(true);
    assert.equal(res.skipped.length, 0);
    assert.equal(res.cuts.length, 1);
    const c = res.cuts[0]!;
    assert.deepEqual([c.start, c.end, c.verified, c.manual], [2, 3.6, false, true]);
    assert.match(c.reason ?? "", /could not find/);
    assert.ok(Math.abs(c.start - 2) <= MANUAL_NUDGE);
  });
  it("an automatic cut is skipped and reported", { skip: !haveFfmpeg }, async () => {
    const res = await run(false);
    assert.equal(res.cuts.length, 0);
    assert.equal(res.skipped.length, 1);
    assert.match(res.skipped[0]!.reason, /could not find/);
  });
});
