/**
 * SRT / VTT writing, parsing and the cue → transcript conversion (packages/shared/src/captions-format.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toSrt, toVtt, parseSrt, parseVtt, parseCaptions, cuesToTranscript, linesFromTranscript, MAX_CUES } from "@reelsaw/shared";

const lines = [
  {
    start: 0,
    end: 1.5,
    text: "Hello there",
    words: [
      { text: "Hello", start: 0, end: 0.6 },
      { text: "there", start: 0.75, end: 1.5 },
    ],
  },
  { start: 3661.25, end: 3662, text: "A & B <3" },
];

describe("writing", () => {
  it("writes SRT with comma milliseconds, hours and numbered cues", () => {
    assert.equal(toSrt(lines), "1\n00:00:00,000 --> 00:00:01,500\nHello there\n\n2\n01:01:01,250 --> 01:01:02,000\nA & B <3\n");
  });

  it("writes VTT with a header, dot milliseconds and escaped text", () => {
    assert.equal(toVtt(lines), "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello there\n\n01:01:01.250 --> 01:01:02.000\nA &amp; B &lt;3\n");
  });

  it("writes karaoke word timestamps after the first word", () => {
    const out = toVtt(lines, { wordTimes: true });
    assert.ok(out.includes("Hello <00:00:00.750>there"), out);
  });

  it("skips empty lines, joins words when there is no text and repairs zero-length cues", () => {
    const out = toSrt([
      {
        start: 1,
        end: 1,
        words: [
          { text: "hi", start: 1, end: 1 },
          { text: "you", start: 1, end: 1 },
        ],
      },
      { start: 2, end: 3, text: "  " },
    ]);
    assert.equal(out, "1\n00:00:01,000 --> 00:00:01,001\nhi you\n");
  });
});

describe("parsing", () => {
  it("round trips SRT and VTT", () => {
    const srt = parseSrt(toSrt(lines));
    assert.deepEqual(srt.warnings, []);
    assert.deepEqual(srt.cues, [
      { start: 0, end: 1.5, text: "Hello there" },
      { start: 3661.25, end: 3662, text: "A & B <3" },
    ]);
    assert.deepEqual(parseVtt(toVtt(lines, { wordTimes: true })).cues, srt.cues);
  });

  it("handles CRLF, a BOM, a missing index and dot milliseconds in SRT", () => {
    const r = parseSrt("﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nOne\r\ntwo\r\n\r\n00:00:03.000 --> 00:00:04.000\r\nNo index\r\n");
    assert.deepEqual(r.cues, [
      { start: 1, end: 2.5, text: "One\ntwo" },
      { start: 3, end: 4, text: "No index" },
    ]);
    assert.deepEqual(r.warnings, []);
  });

  it("ignores VTT headers, NOTE, STYLE and cue identifiers, and short timestamps and settings", () => {
    const r = parseVtt(
      "WEBVTT - title\nKind: captions\n\nNOTE a comment\nover two lines\n\nSTYLE\n::cue { color: red }\n\nintro\n00:01.000 --> 00:03.000 align:start position:0%\nFirst\n\n00:00:04.000 --> 00:00:05.000\nSecond\n",
    );
    assert.deepEqual(r.cues, [
      { start: 1, end: 3, text: "First" },
      { start: 4, end: 5, text: "Second" },
    ]);
    assert.deepEqual(r.warnings, []);
  });

  it("strips tags, voice spans and word timestamps and decodes entities", () => {
    const r = parseVtt("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<v Ana><b>Fish</b> &amp; <i>chips</i> <00:00:01.000><c.yellow>now</c> &lt;3 &#39;ok&#x21;\n");
    assert.equal(r.cues[0]!.text, "Fish & chips now <3 'ok!");
    assert.equal(parseSrt('1\n00:00:00,000 --> 00:00:01,000\n{\\an8}<font color="red">Top</font> a < b\n').cues[0]!.text, "Top a < b");
  });

  it("warns about bad cues and out-of-order cues instead of failing", () => {
    const r = parseSrt(
      "1\n00:00:05,000 --> 00:00:06,000\nlate\n\n2\n00:00:01,000 --> 00:00:02,000\nearly\n\n3\n00:00:09,000 --> 00:00:08,000\nbackwards\n\n4\n00:00:10,000 --> 00:00:11,000\n\n",
    );
    assert.deepEqual(
      r.cues.map((c) => c.text),
      ["early", "late"],
    );
    assert.equal(r.warnings.length, 3);
  });

  it("copes with a cue that runs into the next one without a blank line", () => {
    const r = parseSrt("1\n00:00:01,000 --> 00:00:02,000\nA\n2\n00:00:03,000 --> 00:00:04,000\nB\n");
    assert.deepEqual(
      r.cues.map((c) => c.text),
      ["A", "B"],
    );
  });

  it("says so when there are no cues, and picks the format from the header", () => {
    assert.match(parseSrt("just text").warnings[0]!, /No SRT cues/);
    assert.equal(parseCaptions("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nx").format, "vtt");
    assert.equal(parseCaptions("1\n00:00:00,000 --> 00:00:01,000\nx").format, "srt");
  });

  it("rejects more than the cue limit", () => {
    const big = Array.from({ length: MAX_CUES + 1 }, (_, i) => `${i + 1}\n00:00:00,000 --> 00:00:01,000\nx\n`).join("\n");
    assert.throws(() => parseSrt(big), /more than 50,000 cues/);
  });
});

describe("cuesToTranscript", () => {
  it("makes a segment per cue and spreads words by length across it", () => {
    const { words, segments } = cuesToTranscript([{ start: 10, end: 14, text: "aa bbbbbb\nc" }]);
    assert.deepEqual(segments, [{ text: "aa bbbbbb c", start: 10, end: 14 }]);
    assert.deepEqual(
      words.map((w) => w.text),
      ["aa", "bbbbbb", "c"],
    );
    assert.equal(words[0]!.start, 10);
    assert.equal(words[2]!.end, 14);
    for (let i = 1; i < words.length; i++) assert.ok(Math.abs(words[i]!.start - words[i - 1]!.end) < 1e-9);
    assert.ok(words[1]!.end - words[1]!.start > words[0]!.end - words[0]!.start);
  });

  it("keeps words in order when cues overlap and splits CJK per character", () => {
    const { words } = cuesToTranscript([
      { start: 0, end: 4, text: "one two" },
      { start: 2, end: 6, text: "three" },
    ]);
    for (let i = 1; i < words.length; i++) assert.ok(words[i]!.start >= words[i - 1]!.end - 1e-9);
    assert.deepEqual(
      cuesToTranscript([{ start: 0, end: 1, text: "你好 world" }], { language: "zh" }).words.map((w) => w.text),
      ["你", "好", "world"],
    );
  });
});

describe("linesFromTranscript", () => {
  it("hands each segment the words inside it", () => {
    const words = [
      { text: "a", start: 0, end: 1 },
      { text: "b", start: 1, end: 2 },
      { text: "c", start: 2.5, end: 3 },
    ];
    const out = linesFromTranscript(
      [
        { text: "a b", start: 0, end: 2 },
        { text: "c", start: 2.4, end: 3 },
      ],
      words,
    );
    assert.deepEqual(
      out.map((l) => l.words?.map((w) => w.text)),
      [["a", "b"], ["c"]],
    );
  });
});
