/**
 * The language matrix: every language the transcription model can take (Whisper's set, what is assumed when a model
 * does not list its own) against every stage of the registry (pipeline/language.ts). It is the guard for the class
 * "a stage that assumes Latin script and English punctuation": a new language, a new font or a new stage lands here.
 *
 *   - always: the profile is consistent (a script, letters of that script, a direction, punctuation), every stage has
 *     an answer, words segment and join back without losing or adding spaces, and sentence ends are found with the
 *     language's own punctuation and, in a transcript without any, from its pauses alone;
 *   - LANGUAGE_MATRIX_RENDER=1 (CI's `language-matrix` job, inside the image's own `system` stage): the installed
 *     fonts draw every letter, upper-cased too, and the CLDR sample burns in through the shipped ffmpeg / libass
 *     without "failed to find any fallback with glyph". LANGUAGE_MATRIX_FRAMES=<dir> keeps one frame per language.
 *
 * Run: node --import tsx --test test/language-matrix.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { defaultStyle, joinWords, languageLabel, languageProfile, segmentWords, upperCase, WHISPER_SPOKEN_LANGUAGES } from "@reelsaw/shared";
import { buildAss } from "../src/pipeline/captions.js";
import { capabilities, LANGUAGE_STAGES } from "../src/pipeline/language.js";
import { missingGlyphs, systemGlyphs } from "../src/fonts.js";
import { sentenceEndAfter, sentenceRules } from "../src/pipeline/thought.js";
import { toSentences } from "../src/pipeline/transcript.js";

const execFileAsync = promisify(execFile);
const LANGUAGES = [...WHISPER_SPOKEN_LANGUAGES];
const RENDER = process.env.LANGUAGE_MATRIX_RENDER === "1";
const FRAMES = process.env.LANGUAGE_MATRIX_FRAMES;

/**
 * ISO 15924 codes for writing systems that mix Unicode scripts (Japanese is kana and kanji). Closed: fixed by
 * ISO 15924, which names exactly these as combinations.
 */
const SCRIPT_PARTS: Record<string, string[]> = {
  Jpan: ["Hira", "Kana", "Hani"],
  Kore: ["Hang", "Hani"],
  Hans: ["Hani"],
  Hant: ["Hani"],
  Hrkt: ["Hira", "Kana"],
};

function ofScript(script: string): RegExp {
  const parts = SCRIPT_PARTS[script] ?? [script];
  return new RegExp(`^[${parts.map((p) => `\\p{scx=${p}}`).join("")}\\p{scx=Zyyy}\\p{scx=Zinh}]$`, "u");
}

describe("language matrix: profile", () => {
  it("covers a sensible number of languages", () => assert.ok(LANGUAGES.length >= 95, `${LANGUAGES.length}`));
  for (const code of LANGUAGES) {
    it(`${code} (${languageLabel(code)})`, () => {
      const p = languageProfile(code);
      assert.ok(p.script, "a script from CLDR's likely subtags");
      assert.ok(p.letters.length >= 10, `letters from CLDR (${p.lettersFrom})`);
      // CLDR's letters and Intl's script agree: what we check the fonts against is what the language is written in
      const re = ofScript(p.script!);
      const foreign = [...p.letters].filter((c) => !re.test(c));
      assert.deepEqual(foreign.slice(0, 5), [], `letters outside ${p.script}`);
      assert.ok(p.terminals.length > 0, "sentence-ending punctuation");
      assert.ok(["ltr", "rtl"].includes(p.direction));
      // every stage has an answer, in words a user reads
      const caps = capabilities(code);
      assert.deepEqual(
        caps.map((c) => c.stage),
        LANGUAGE_STAGES,
      );
      for (const c of caps) assert.ok(c.message.length > 5, `${c.stage} says what it does`);
    });
  }
});

describe("language matrix: segmentation", () => {
  for (const code of LANGUAGES) {
    it(`${code}: words segment and join back as written`, () => {
      const p = languageProfile(code);
      // a run of the language's own letters, words separated as it separates them, no punctuation
      const letters = [...p.letters].filter((c) => /\p{L}/u.test(c));
      const words = Array.from({ length: 6 }, (_, i) => letters.slice((i * 3) % letters.length, ((i * 3) % letters.length) + 3).join(""));
      const text = joinWords(words, code);
      const seg = segmentWords(text, code);
      assert.ok(seg.length >= 1, "at least one word");
      assert.equal(joinWords(seg, code).replace(/\s/g, ""), text.replace(/\s/g, ""), "no letters lost");
      if (p.spaced) assert.equal(joinWords(seg, code), text, "spaced scripts round-trip exactly");
      else assert.ok(!joinWords(seg, code).includes(" "), "no spaces added to a script written without them");
    });
  }
});

describe("language matrix: sentence boundaries", () => {
  for (const code of LANGUAGES) {
    it(`${code}: sentence ends found with its punctuation, and from pauses alone without it`, () => {
      const p = languageProfile(code);
      const letters = [...p.letters].filter((c) => /\p{L}/u.test(c));
      // three sentences of five words in the language's letters; words 0.3 s apart inside, 0.9 s between sentences
      const texts = Array.from({ length: 15 }, (_, i) => letters.slice((i * 2) % letters.length, ((i * 2) % letters.length) + 3).join(""));
      const timed = (ts: string[]) => {
        let t = 0;
        return ts.map((text, i) => {
          const w = { text, start: t, end: t + 0.3 };
          t = w.end + (i % 5 === 4 ? 0.9 : 0.04);
          return w;
        });
      };
      const ends = [4, 9];
      // the language's own full stop: the one of its terminals in its script, else the first it lists
      const script = p.script ? new RegExp(`[${(SCRIPT_PARTS[p.script] ?? [p.script]).map((s) => `\\p{scx=${s}}`).join("")}]`, "u") : undefined;
      const stop = (script && [...p.terminals].find((c) => script.test(c))) || [...p.terminals][0]!;
      const punctuated = timed(texts.map((t, i) => (ends.includes(i) ? t + stop : t)));
      const rules = sentenceRules(punctuated, code);
      assert.equal(rules.punctuated, true, `"${stop}" counts as punctuation`);
      for (const i of ends) assert.equal(sentenceEndAfter(punctuated, i, rules), "punctuation", `"${punctuated[i]!.text}" ends a sentence`);
      assert.deepEqual(
        toSentences(punctuated, undefined, code).map((s) => s.end),
        [punctuated[4]!.end, punctuated[9]!.end, punctuated[14]!.end],
      );
      // no punctuation (as most STT returns Hindi): the pauses decide, and nothing else ends a sentence mid-way
      const bare = timed(texts);
      const bareRules = sentenceRules(bare, code);
      assert.equal(bareRules.punctuated, false);
      const found = bare.flatMap((_, i) => (i < bare.length - 1 && sentenceEndAfter(bare, i, bareRules) ? [i] : []));
      assert.deepEqual(found, ends);
      assert.equal(toSentences(bare, undefined, code).length, 3);
    });
  }
});

describe("language matrix: fonts and render (LANGUAGE_MATRIX_RENDER=1)", {
  skip: !RENDER && "set LANGUAGE_MATRIX_RENDER=1 to render through the shipped ffmpeg",
}, () => {
  it("fontconfig lists the installed fonts", async () => assert.ok(await systemGlyphs(), "fc-list answered"));

  for (const code of LANGUAGES) {
    it(`${code} (${languageLabel(code)}): every letter has a font, and the sample burns in without missing glyphs`, async () => {
      const p = languageProfile(code);
      const glyphs = await systemGlyphs();
      assert.ok(glyphs);
      // hooks are upper-cased: those letters must be drawable too (Georgian Mtavruli)
      const missing = missingGlyphs(glyphs, p.letters + upperCase(p.letters, code));
      assert.deepEqual(missing, [], `no installed font draws ${missing.slice(0, 12).join(" ")}`);

      const words = segmentWords(p.sample, code)
        .slice(0, 24)
        .map((text, i) => ({ text, start: i * 0.1, end: i * 0.1 + 0.1 }));
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "matrix-"));
      try {
        const ass = path.join(dir, "c.ass");
        await fs.writeFile(
          ass,
          buildAss(words, {
            language: code,
            width: 540,
            height: 960,
            font: "DejaVu Sans",
            style: { ...defaultStyle, captions: "plain", wordsPerLine: 24, showHook: true, hookSeconds: 5 },
            hook: p.sample.slice(0, 40),
            maxLineSeconds: 30,
          }),
        );
        const out = FRAMES ? path.join(FRAMES, `${code}.png`) : path.join(dir, "f.png");
        if (FRAMES) await fs.mkdir(FRAMES, { recursive: true });
        const { stderr } = await execFileAsync(
          process.env.FFMPEG_PATH ?? "ffmpeg",
          [
            "-hide_banner",
            "-v",
            "warning",
            "-f",
            "lavfi",
            "-i",
            "color=c=0x334455:s=540x960",
            "-vf",
            `ass=${ass}`,
            "-frames:v",
            "1",
            "-update",
            "1",
            "-y",
            out,
          ],
          { timeout: 60_000 },
        );
        const lost = [...stderr.matchAll(/failed to find any fallback with glyph (0x[0-9A-F]+)/gi)].map((m) => String.fromCodePoint(Number(m[1])));
        assert.deepEqual([...new Set(lost)], [], `libass drew boxes for ${[...new Set(lost)].slice(0, 12).join(" ")}`);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
});
