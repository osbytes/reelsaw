/**
 * Pure units of the caption-diff tool and the transcription suite's grading: json3 parsing, track
 * alignment, insertion / kept candidates, clean-verbatim normalisation and proper-noun detection.
 * No stack needed: node --import tsx --test test/caption-diff.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { align, humanWordsIn, insertions, kept, parseJson3 } from "../src/eval/tools/caption-diff.js";
import { alignWords, cleanVerbatim, nameTokens, normTokens } from "../src/eval/suites/transcription.js";

/** ASR json3: one event per phrase, a time offset per word */
const asr = (phrases: Array<[number, string]>) => ({
  events: phrases.map(([t, text]) => ({
    tStartMs: t * 1000,
    dDurationMs: 3000,
    segs: text.split(" ").map((w, i) => ({ utf8: (i ? " " : "") + w, tOffsetMs: i * 300 })),
  })),
});
/** human json3: one event per caption line, no word times */
const human = (lines: Array<[number, string]>) => ({ events: lines.map(([t, text]) => ({ tStartMs: t * 1000, dDurationMs: 3000, segs: [{ utf8: text }] })) });

const auto = parseJson3(
  asr([
    [0, "so I I think um the shell is very very useful"],
    [4, "and like you know bash is is the default"],
  ]),
);
const manual = parseJson3(
  human([
    [0, "So I think the shell is very, very useful,"],
    [4, "and Bash is the default."],
  ]),
);

describe("parseJson3", () => {
  it("times ASR words from tStartMs + tOffsetMs", () => {
    assert.equal(auto[1]!.text, "I");
    assert.equal(auto[1]!.start, 0.3);
    assert.equal(auto[0]!.end, 0.3);
  });
  it("spreads human caption words over their line", () => {
    assert.equal(manual[0]!.text, "So");
    assert.equal(manual[0]!.start, 0);
    assert.ok(manual[1]!.start > 0 && manual[1]!.start < 1);
  });
  it("drops speaker marks", () => {
    assert.deepEqual(
      parseJson3(asr([[0, ">> hello there"]])).map((w) => w.text),
      ["hello", "there"],
    );
  });
});

describe("caption alignment", () => {
  const al = align(manual, auto);
  it("emits words only the ASR track has, earlier copy of a repeat first", () => {
    const c = insertions(al, "vid");
    assert.deepEqual(
      c.map((x) => x.text),
      ["I", "um", "like you know", "is"],
    );
    assert.deepEqual(
      c.map((x) => x.guess),
      ["repetition", "filler", "other", "repetition"],
    );
    const first = c[0]!;
    assert.equal(first.words[first.target.index]!.text, "I");
    assert.equal(first.words[first.target.index + 1]!.text, "I");
  });
  it("lists look-alikes the human track kept", () => {
    const k = kept(al, "vid");
    assert.ok(k.some((x) => x.guess === "kept-repeat" && x.text === "very"));
    assert.ok(k.some((x) => x.guess === "kept-marker" && x.text === "so"));
    assert.ok(!k.some((x) => x.text === "like"));
  });
  it("cuts the human words of a time window", () => {
    assert.deepEqual(
      humanWordsIn(al, 4, 10).map((w) => w.text),
      ["and", "Bash", "is", "the", "default."],
    );
  });
});

describe("transcription grading", () => {
  it("normalises diacritics and punctuation", () => {
    assert.deepEqual(normTokens("Cortés’ side, Zieliński!"), ["cortes", "side", "zielinski"]);
  });
  it("drops fillers and collapses immediate repeats", () => {
    assert.deepEqual(cleanVerbatim(normTokens("I will I will um pass the the test uh")), ["i", "will", "pass", "the", "test"]);
  });
  it("finds proper nouns mid-sentence, not sentence starts or I", () => {
    const n = nameTokens('Then I met Cortés and the Tlaxcalans. The Spaniards arrived. He said, "You win."');
    assert.deepEqual([...n].sort(), ["cortes", "spaniards", "tlaxcalans"]);
  });
  it("marks which reference words the hypothesis got", () => {
    const r = alignWords(["the", "tlaxcalans", "rallied"], ["the", "lash", "collins", "rallied"]);
    assert.deepEqual(r.matched, [true, false, true]);
    assert.equal(Number(r.wer.toFixed(3)), 0.667);
  });
});
