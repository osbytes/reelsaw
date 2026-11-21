/**
 * The language profile (@reelsaw/shared, from Unicode and CLDR data) and the stage registry that reads it
 * (pipeline/language.ts), plus what the caption file does with them. Pure, no stack.
 * Run: node --import tsx --test test/language-profile.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultStyle, endsClause, endsSentence, groupCaptionLines, joinWords, languageProfile, segmentWords, textWidth, upperCase } from "@reelsaw/shared";
import { buildAss, renderedCaptions } from "../src/pipeline/captions.js";
import { capability, languageGaps, LANGUAGE_STAGES, supports, type FontEnv } from "../src/pipeline/language.js";
import { mergeGlyphs, missingGlyphs, parseCharset } from "../src/fonts.js";

describe("languageProfile", () => {
  it("reads script, direction, case and spacing from the platform's data", () => {
    const p = (c: string) => {
      const x = languageProfile(c);
      return [x.script, x.direction, x.cased, x.spaced];
    };
    assert.deepEqual(p("en"), ["Latn", "ltr", true, true]);
    assert.deepEqual(p("hi"), ["Deva", "ltr", false, true]);
    assert.deepEqual(p("bn"), ["Beng", "ltr", false, true]);
    assert.deepEqual(p("ar"), ["Arab", "rtl", false, true]);
    assert.deepEqual(p("he"), ["Hebr", "rtl", false, true]);
    assert.deepEqual(p("th"), ["Thai", "ltr", false, false]);
    assert.deepEqual(p("ja"), ["Jpan", "ltr", false, false]);
    assert.deepEqual(p("zh"), ["Hans", "ltr", false, false]);
    assert.deepEqual(p("ko"), ["Kore", "ltr", false, true]);
  });
  it("takes letters and sentence punctuation from CLDR", () => {
    assert.ok(languageProfile("hi").letters.includes("क"));
    assert.ok(languageProfile("hi").terminals.includes("।"));
    assert.ok(languageProfile("ja").terminals.includes("。"));
    assert.ok(languageProfile("ar").terminals.includes("؟"));
    assert.ok(languageProfile("hi").sample.startsWith("हिन्दी"));
  });
  it("borrows the script's main language's letters when CLDR has none", () => {
    const la = languageProfile("la");
    assert.equal(la.lettersFrom, "en");
    assert.ok(la.letters.length > 20);
  });
});

describe("text helpers", () => {
  it("joins words the way the language writes them", () => {
    assert.equal(joinWords(["今日", "は"], "ja"), "今日は");
    assert.equal(joinWords(["यह", "बात"], "hi"), "यह बात");
    assert.equal(joinWords(["a", "b"], undefined), "a b");
  });
  it("upper-cases with the language's own capitals, or not at all", () => {
    assert.equal(upperCase("istanbul", "tr"), "İSTANBUL");
    assert.equal(upperCase("istanbul", "en"), "ISTANBUL");
    assert.equal(upperCase("हिन्दी", "hi"), "हिन्दी");
  });
  it("finds sentence and clause ends in every script", () => {
    for (const t of ["done.", "बात।", "です。", "هل؟", "end?”", "ပြီ။"]) assert.ok(endsSentence(t), t);
    for (const t of ["word,", "كلمة،", "今日、", "word"]) assert.equal(endsSentence(t), false, t);
    for (const t of ["word,", "كلمة،", "今日、", "a;"]) assert.ok(endsClause(t), t);
  });
  it("segments words without spaces by dictionary", () => {
    assert.deepEqual(segmentWords("สวัสดีครับ", "th"), ["สวัสดี", "ครับ"]);
    assert.deepEqual(segmentWords("Hello, world!", "en"), ["Hello,", "world!"]);
  });
  it("measures full-width text double and combining marks as nothing", () => {
    assert.equal(textWidth("今日は"), 6);
    assert.equal(textWidth("कि"), 1);
  });
});

describe("caption lines per language", () => {
  const ws = (texts: string[]) => texts.map((text, i) => ({ text, start: i * 0.2, end: i * 0.2 + 0.18 }));
  it("breaks on a Devanagari full stop", () => {
    const lines = groupCaptionLines(ws(["यह", "बात", "है।", "और", "यह"]), 4, 9, 40, "hi");
    assert.deepEqual(
      lines.map((l) => l.map((w) => w.text)),
      [
        ["यह", "बात", "है।"],
        ["और", "यह"],
      ],
    );
  });
  it("budgets Japanese by width, with no spaces", () => {
    const lines = groupCaptionLines(ws(["今日", "は", "とても", "いい", "天気", "です", "ね"]), 4, 9, 10, "ja");
    for (const l of lines)
      assert.ok(
        textWidth(
          joinWords(
            l.map((w) => w.text),
            "ja",
          ),
        ) <= 10,
        JSON.stringify(l),
      );
  });
});

describe("buildAss per language", () => {
  const words = [
    { text: "مرحبا", start: 0, end: 0.5 },
    { text: "بكم", start: 0.5, end: 1 },
  ];
  const base = { width: 1080, height: 1920, font: "DejaVu Sans", style: { ...defaultStyle, captions: "plain" as const } };
  it("lets libass find the base direction for a right-to-left language", () => {
    assert.match(buildAss(words, { ...base, language: "ar" }), /Style: Caption,.*,-1\n/);
    assert.match(buildAss(words, { ...base, language: "en" }), /Style: Caption,.*,1\n/);
  });
  it("joins Japanese words without spaces and keeps Hindi hooks as written", () => {
    const ja = buildAss(
      [
        { text: "今日", start: 0, end: 0.4 },
        { text: "は", start: 0.4, end: 0.6 },
      ],
      { ...base, language: "ja" },
    );
    assert.ok(ja.includes("今日は"));
    const hi = buildAss([], { ...base, language: "hi", hook: "यह देखो", style: { ...base.style, showHook: true, hookSeconds: 3 } });
    assert.ok(hi.includes("यह देखो"));
    const tr = buildAss([], { ...base, language: "tr", hook: "istanbul", style: { ...base.style, showHook: true, hookSeconds: 3 } });
    assert.ok(tr.includes("İSTANBUL"));
  });
  it("records the language with the rendered lines, for SRT / VTT export", () => {
    assert.equal(renderedCaptions(words, base.style, 0, undefined, "ar").language, "ar");
  });
});

describe("capability registry", () => {
  const latinOnly: FontEnv = { system: parseCharset("20-7e a0-17f") };
  it("has an answer for every stage and language", () => {
    for (const lang of ["en", "hi", "ja", "ar", "xx"]) for (const s of LANGUAGE_STAGES) assert.ok(capability(s, lang).message, `${s} ${lang}`);
  });
  it("says when no font draws the script, and which uploaded font would", () => {
    const hi = capability("captionFont", "hi", latinOnly);
    assert.equal(hi.level, "none");
    assert.match(hi.message, /Devanagari/);
    const withUpload = capability("captionFont", "hi", { ...latinOnly, uploaded: [{ family: "Mukta", glyphs: parseCharset("900-97f") }] });
    assert.match(withUpload.message, /"Mukta"/);
    assert.equal(capability("captionFont", "en", latinOnly).level, "full");
    assert.equal(capability("captionFont", "hi", { system: null }).level, "limited");
  });
  it("keeps the English-only stages English-only, and English gap-free", () => {
    assert.deepEqual(languageGaps("en", { system: parseCharset("20-7e") }), []);
    assert.equal(supports("disfluencyRules", "de"), false);
    assert.equal(supports("captionFont", "de"), true);
    assert.deepEqual(
      languageGaps("hi", latinOnly).map((g) => g.stage),
      ["captionFont", "hookCase", "disfluencyRules", "entityPhonetics", "ctcAlign"],
    );
  });
});

describe("glyph coverage", () => {
  it("parses fontconfig charsets and unions them", () => {
    const a = parseCharset("20-7e a0-ff");
    const b = parseCharset("900-97f");
    assert.deepEqual(mergeGlyphs(a, b, parseCharset("7f-9f")), [
      [0x20, 0xff],
      [0x900, 0x97f],
    ]);
    assert.deepEqual(missingGlyphs(a, "ab क‍"), ["क"]);
  });
});
