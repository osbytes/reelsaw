/**
 * ASR decoder-loop collapse and the Whisper compression-ratio retry gate.
 * Grounded in openai/whisper's 2.4 threshold and disfluency EMPHATIC (short repeats are speech).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Word } from "@reelsaw/shared";
import {
  collapseDecoderLoops,
  collapseDecoderLoopsWithStats,
  compressionRatio,
  flagsFromCollapse,
  looksRepetitive,
  preferLessRepetitive,
  shouldRetryWithoutPrompt,
  tokenKey,
  withoutPrompt,
  UNIGRAM_KEEP,
} from "../src/pipeline/asr-loops.js";
import { applyFlags } from "../src/pipeline/entities.js";
import { toWords } from "../src/pipeline/transcript.js";

const w = (text: string, start: number, end = start + 0.2): Word => ({ text, start, end });
const spoken = (texts: string[], t0 = 0, dur = 0.2): Word[] => texts.map((text, i) => w(text, t0 + i * dur, t0 + (i + 1) * dur));
const piled = (text: string, n: number, t = 10): Word[] => Array.from({ length: n }, () => w(text, t, t));
const join = (words: Word[]) => words.map((x) => x.text).join(" ");

describe("tokenKey", () => {
  it("folds case and punctuation so 'No,' 'no.' and 'NO' are one token", () => {
    assert.equal(tokenKey("No,"), "no");
    assert.equal(tokenKey("no."), "no");
    assert.equal(tokenKey("NO"), "no");
  });
});

describe("compressionRatio / looksRepetitive", () => {
  it("scores a 'no' loop like openai/whisper (ratio ≫ 2.4)", () => {
    const loop = Array(200).fill("no").join(" ");
    assert.ok(compressionRatio(loop) > 2.4, `ratio ${compressionRatio(loop)}`);
    assert.equal(looksRepetitive(loop), true);
  });
  it("does not flag ordinary speech or a short emphatic repeat", () => {
    const speech = "And you want me to put my shoes on. Where can I sit? See you're all smiling. Socks or no socks? Yeah, socks or no socks. Okay hold on.";
    assert.equal(looksRepetitive(speech), false);
    assert.equal(looksRepetitive("no no no no"), false);
  });
  it("flags a vocabulary-prompt list cycling for a whole chunk", () => {
    const loop = Array(20).fill("Chafing Dream Swag Bags Flying Pig Project").join(" ");
    assert.equal(looksRepetitive(loop), true);
  });
  it("retries only when there was a vocabulary prompt", () => {
    const loop = Array(200).fill("no").join(" ");
    assert.equal(shouldRetryWithoutPrompt(loop, true), true);
    assert.equal(shouldRetryWithoutPrompt(loop, false), false);
    assert.equal(shouldRetryWithoutPrompt("hello there", true), false);
  });
  it("prefers the less compressible transcript after a retry", () => {
    const bad = { text: Array(200).fill("no").join(" "), id: "bad" };
    const good = { text: "Michelle did you want to jump in there", id: "good" };
    assert.equal(preferLessRepetitive(bad, good).id, "good");
    assert.equal(preferLessRepetitive(good, good).id, "good");
  });
  it("keeps the original when the retry is empty", () => {
    const bad = { text: Array(200).fill("no").join(" "), id: "bad" };
    assert.equal(preferLessRepetitive(bad, { text: "   ", id: "empty" }).id, "bad");
  });
  it("withoutPrompt copies options and drops only prompt", () => {
    const opts = { openai: { timestampGranularities: ["word"], prompt: "Names: Debby." } };
    const next = withoutPrompt(opts, "openai");
    assert.equal(opts.openai.prompt, "Names: Debby.");
    assert.equal("prompt" in next.openai, false);
    assert.deepEqual(next.openai.timestampGranularities, ["word"]);
  });
});

describe("collapseDecoderLoops", () => {
  it("is identity on ordinary speech", () => {
    const words = spoken(["Socks", "or", "no", "socks?", "Yeah"]);
    assert.deepEqual(collapseDecoderLoops(words), words);
  });
  it(`keeps ${UNIGRAM_KEEP} copies of an emphatic unigram ('no no no no')`, () => {
    const words = spoken(["The", "grass.", "No,", "no,", "no,", "no.", "I", "sit"]);
    const collapsed = collapseDecoderLoopsWithStats(words);
    assert.equal(join(collapsed.words), join(words));
    assert.equal(flagsFromCollapse(words, collapsed).length, 0);
  });
  it("caps a unigram loop at 4, including zero-duration pile-ups", () => {
    const words = [w("grass", 40.2, 40.28), ...piled("no", 80, 40.281), w("Michelle", 50, 50.2)];
    const { words: out, dropped, runs } = collapseDecoderLoopsWithStats(words);
    assert.equal(out.filter((x) => tokenKey(x.text) === "no").length, 4);
    assert.equal(dropped, 76);
    assert.equal(out.at(-1)?.text, "Michelle");
    assert.equal(runs[0]?.token, "no");
    assert.equal(runs[0]?.repeats, 80);
    assert.equal(runs[0]?.end, 50);
    assert.equal(runs[0]?.span, 80);
    assert.equal(runs[0]?.wordIndex, 1);
    const flags = flagsFromCollapse(words, { words: out, dropped, runs });
    assert.equal(flags.length, 1);
    assert.equal(flags[0]?.kind, "loop");
    assert.equal(flags[0]?.status, "auto");
    assert.equal(flags[0]?.heard, "no × 80");
    assert.equal(flags[0]?.span, 80);
    assert.equal(flags[0]?.suggested.split(" ").length, 4);
    assert.equal(join(applyFlags(words, flags)), join(out));
    assert.equal(join(applyFlags(words, [{ ...flags[0]!, status: "rejected" }])), join(words));
    const filled = applyFlags(words, [{ ...flags[0]!, status: "accepted", replacement: "[unclear]" }]);
    assert.equal(filled.some((x) => x.text === "[unclear]"), true);
    assert.ok((filled.find((x) => x.text === "[unclear]")?.end ?? 0) >= 49);
  });
  it("does not treat 'no no' as a 2-gram (that would keep 2 instead of 4)", () => {
    const out = collapseDecoderLoops([w("x", 0), ...piled("no", 10, 1), w("y", 2)]);
    assert.equal(out.filter((x) => tokenKey(x.text) === "no").length, 4);
  });
  it("keeps a 2-copy phrase ('I think I think') for disfluency to handle", () => {
    const words = spoken(["I", "think", "I", "think", "we", "should"]);
    assert.deepEqual(collapseDecoderLoops(words), words);
  });
  it("keeps grammatical 'had had'", () => {
    const words = spoken(["that", "had", "had", "llamas"]);
    assert.deepEqual(collapseDecoderLoops(words), words);
  });
  it("keeps a spoken 3-copy cheer with distinct timestamps", () => {
    const words = spoken(["come", "on", "come", "on", "come", "on"]);
    assert.deepEqual(collapseDecoderLoops(words), words);
  });
  it("caps a spoken 4-copy phrase at 2 (same rule as an interpolated prompt leak)", () => {
    const words = spoken(["come", "on", "come", "on", "come", "on", "come", "on"]);
    assert.equal(join(collapseDecoderLoops(words)), "come on come on");
  });
  it("is not a special case for 'no': a 'yes' pile also caps at 4", () => {
    const out = collapseDecoderLoops([w("ok", 0), ...piled("yes", 30, 1), w("and", 2)]);
    assert.equal(out.filter((x) => tokenKey(x.text) === "yes").length, 4);
    assert.equal(out[0]?.text, "ok");
    assert.equal(out.at(-1)?.text, "and");
  });
  it("collapses a 3-copy phrase when timestamps pile up (prompt leak)", () => {
    const phrase = ["Chafing", "Dream", "Swag", "Bags", "Flying", "Pig", "Project"];
    const words = [w("us", 1799.9), ...Array.from({ length: 3 }, () => phrase.map((t) => w(t, 1800, 1800))).flat()];
    const out = collapseDecoderLoops(words);
    assert.equal(join(out), "us Chafing Dream Swag Bags Flying Pig Project");
  });
  it("collapses 'thank you' silence-hallucination piles to one copy", () => {
    const words = [w("and", 9.8, 10), ...Array.from({ length: 25 }, () => [w("thank", 10, 10), w("you", 10, 10)]).flat(), w("Okay", 12, 12.3)];
    assert.equal(join(collapseDecoderLoops(words)), "and thank you Okay");
  });
  it("a 5-copy unigram with healthy timestamps still caps at 4 (chants stay readable)", () => {
    const words = spoken(["no", "no", "no", "no", "no"]);
    const out = collapseDecoderLoops(words);
    assert.equal(out.length, 4);
    assert.equal(out.every((x) => tokenKey(x.text) === "no"), true);
  });
});

describe("toWords collapse", () => {
  it("collapses an interpolated prompt-list segment (timestamps look spoken)", () => {
    const phrase = "Chafing Dream Swag Bags Flying Pig Project";
    const words = toWords([
      { text: "He'll have us", startSecond: 1799.5, endSecond: 1800 },
      { text: Array(8).fill(phrase).join(" "), startSecond: 1800, endSecond: 1840 },
    ]);
    assert.equal(join(words), `He'll have us ${phrase} ${phrase}`);
  });
  it("collapses a phrase-level 'no' segment, not only word-level ASR", () => {
    const nos = Array(50).fill("no").join(" ");
    const words = toWords([
      { text: "The grass.", startSecond: 40, endSecond: 40.4 },
      { text: nos, startSecond: 40.4, endSecond: 50 },
      { text: "Michelle did you", startSecond: 50, endSecond: 51 },
    ]);
    const nNo = words.filter((x) => tokenKey(x.text) === "no").length;
    assert.ok(nNo <= 4, `kept ${nNo} nos`);
    assert.equal(words.some((x) => x.text === "Michelle"), true);
  });
  it("can skip collapse for callers that want the raw split", () => {
    const words = toWords([{ text: "no no no no no", startSecond: 0, endSecond: 1 }], { collapseLoops: false });
    assert.equal(words.length, 5);
  });
});
