/**
 * Language gate for English-only stages: pure functions, no stack needed.
 * Run: node --import tsx --test test/language-gate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { norm } from "../src/pipeline/disfluency.js";
import { norm as entityNorm } from "../src/pipeline/entities.js";
import { languageCode, skipReason, supports } from "../src/pipeline/language.js";
import { SENTENCE_END } from "../src/pipeline/transcript.js";

describe("norm (disfluency)", () => {
  it("keeps non-ASCII letters", () => {
    assert.equal(norm("Über"), "über");
    assert.equal(norm("naïve,"), "naïve");
    assert.equal(norm("東京"), "東京");
  });
  it("keeps apostrophes (straight and curly) and still strips punctuation", () => {
    assert.equal(norm("Don't!"), "don't");
    assert.equal(norm("don’t"), "don't");
    assert.equal(norm("..."), "");
  });
  it("is unchanged for English", () => {
    assert.equal(norm("Um,"), "um");
    assert.equal(norm("I'm"), "i'm");
  });
});

describe("norm (entities)", () => {
  it("handles other scripts and strips diacritics for matching", () => {
    assert.equal(entityNorm("東京"), "東京");
    assert.equal(entityNorm("Zoë"), "zoe");
    assert.equal(entityNorm("naïve"), "naive");
    assert.equal(entityNorm("Über"), "uber");
    assert.equal(entityNorm("O'Brien"), "obrien");
  });
});

describe("supports", () => {
  const stages = ["disfluencyRules", "entityPhonetics", "ctcAlign"] as const;
  it("treats English and undetected as supported", () => {
    for (const s of stages) {
      assert.equal(supports(s, "en"), true);
      assert.equal(supports(s, "en-US"), true);
      assert.equal(supports(s, "English"), true);
      assert.equal(supports(s, undefined), true);
      assert.equal(supports(s, null), true);
    }
  });
  it("rejects every other language", () => {
    for (const s of stages) for (const l of ["de", "ja", "German", "zh-CN", "ar"]) assert.equal(supports(s, l), false, `${s} ${l}`);
  });
  it("names the language in the skip reason", () => {
    assert.equal(skipReason("de"), "not available for de");
    assert.equal(skipReason("German"), "not available for de");
    assert.equal(languageCode("pt-BR"), "pt");
  });
});

describe("SENTENCE_END", () => {
  it("matches full-width and other-script terminators", () => {
    for (const s of ["東京に行きました。", "本当ですか？", "すごい！", "यह सही है।", "هل هذا صحيح؟", "他说：「好。」", "ok."]) assert.ok(SENTENCE_END.test(s), s);
  });
  it("does not match an unfinished sentence", () => {
    for (const s of ["東京に行き", "and then", "wait,"]) assert.equal(SENTENCE_END.test(s), false, s);
  });
});
