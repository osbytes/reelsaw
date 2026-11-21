/**
 * Language gate for English-only stages: pure functions, no stack needed.
 * Run: node --import tsx --test test/language-gate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { norm } from "../src/pipeline/disfluency.js";
import { norm as entityNorm } from "../src/pipeline/entities.js";
import {
  languageCode,
  languageName,
  outputLanguage,
  outputLanguageRule,
  skipReason,
  supports,
  transcriptionLanguageOptions,
} from "../src/pipeline/language.js";
import { buildMapPrompt } from "../src/pipeline/select.js";
import { SPOKEN_LANGUAGES, languageLabel, spokenLanguageCode, spokenLanguageOptions } from "@reelsaw/shared";
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

describe("transcriptionLanguageOptions", () => {
  it("uses each vendor's option name with an ISO 639-1 code", () => {
    assert.deepEqual(transcriptionLanguageOptions("openai", "pt-BR"), { language: "pt" });
    assert.deepEqual(transcriptionLanguageOptions("groq", "Japanese"), { language: "ja" });
    assert.deepEqual(transcriptionLanguageOptions("deepgram", "es"), { language: "es" });
    assert.deepEqual(transcriptionLanguageOptions("assemblyai", "fr"), { languageCode: "fr" });
  });
  it("sends nothing when unset (detect) or for a vendor without the option", () => {
    assert.deepEqual(transcriptionLanguageOptions("openai", ""), {});
    assert.deepEqual(transcriptionLanguageOptions("openai", null), {});
    assert.deepEqual(transcriptionLanguageOptions("someone-else", "de"), {});
  });
});

describe("spoken language list", () => {
  it("normalises codes, tags, names and old aliases into the set", () => {
    assert.equal(spokenLanguageCode("EN"), "en");
    assert.equal(spokenLanguageCode("pt_BR"), "pt");
    assert.equal(spokenLanguageCode("german"), "de");
    assert.equal(spokenLanguageCode("Cantonese"), "yue");
    assert.equal(spokenLanguageCode("haw"), "haw");
    assert.equal(spokenLanguageCode("iw"), "he");
    assert.equal(spokenLanguageCode("jv"), "jw");
    assert.equal(spokenLanguageCode("  "), undefined);
    assert.equal(spokenLanguageCode("xx-YY"), "xx", "a tag outside the set keeps its primary subtag");
  });
  it("has a name for every code, in any locale", () => {
    for (const c of SPOKEN_LANGUAGES) assert.notEqual(languageLabel(c), c, c);
    assert.equal(languageLabel("de", "de"), "Deutsch");
    assert.equal(languageLabel("jw"), "Javanese");
    const opts = spokenLanguageOptions();
    assert.equal(opts.length, SPOKEN_LANGUAGES.length);
    assert.equal(opts.find((o) => o.value === "de")?.native, "Deutsch");
    assert.equal(opts.find((o) => o.value === "en")?.native, undefined, "no native name when it is the same");
    assert.deepEqual(
      opts.map((o) => o.label),
      [...opts.map((o) => o.label)].sort((a, b) => a.localeCompare(b, "en")),
    );
  });
});

describe("output language", () => {
  it("names a language from its code or name", () => {
    assert.equal(languageName("de"), "German");
    assert.equal(languageName("pt-BR"), "Portuguese");
    assert.equal(languageName("Japanese"), "Japanese");
    assert.equal(languageName(null), undefined);
  });
  it("asks for the video's language, and leaves English and undetected prompts unchanged", () => {
    assert.match(outputLanguageRule("es", "the title"), /The video is in Spanish\. Write the title in Spanish/);
    assert.equal(outputLanguageRule("en", "the title"), "");
    assert.equal(outputLanguageRule("en-GB", "the title"), "");
    assert.equal(outputLanguageRule(undefined, "the title"), "");
    assert.match(outputLanguageRule("es", "the title"), /unless the user's instructions ask for another language/);
  });
  it("leaves English and undetected out of step inputs, so their saved steps keep their keys", () => {
    for (const l of ["en", "en-US", "English", undefined, null, ""]) assert.equal(outputLanguage(l), undefined, String(l));
    assert.equal(outputLanguage("Spanish"), "es");
  });
  it("puts the rule in the clip-finding prompt", () => {
    const chunk = { start: 0, end: 60, lines: ["[00:00.0 - 00:05.0] Hola a todos"] } as never;
    const c = { title: "t", durationSec: 600, minSec: 15, maxSec: 60 };
    assert.match(buildMapPrompt(chunk, { ...c, language: "es" }), /Write "title", "hook", "caption" and "hashtags" in Spanish/);
    assert.equal(buildMapPrompt(chunk, c), buildMapPrompt(chunk, { ...c, language: "en" }));
  });
});

describe("SENTENCE_END", () => {
  it("matches full-width and other-script terminators", () => {
    for (const s of ["東京に行きました。", "本当ですか？", "すごい！", "यह सही है।", "هل هذا صحيح؟", "他说：「好。」", "ok."])
      assert.ok(SENTENCE_END.test(s), s);
  });
  it("does not match an unfinished sentence", () => {
    for (const s of ["東京に行き", "and then", "wait,"]) assert.equal(SENTENCE_END.test(s), false, s);
  });
});
