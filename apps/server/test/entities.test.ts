/**
 * Entity correction guards: pure functions plus correctTranscript against a mock model, no stack needed.
 * Run: node --import tsx --test test/entities.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import type { Word } from "@reelsaw/shared";
import { correctTranscript, findCandidates, fixPairKey, isCommonWord, isCorrectable, metaphone } from "../src/pipeline/entities.js";

describe("isCommonWord", () => {
  it("counts contractions as their base word", () => {
    for (const w of ["don't", "didn't", "Hasn't", "you're", "can't", "won't", "it's", "I'm", "we'll", "they've", "she'd", "don’t"])
      assert.equal(isCommonWord(w), true, w);
  });
  it("counts casual spoken spellings (SCOWL lists them)", () => {
    for (const w of ["gonna", "wanna", "gotta", "kinda", "yeah", "okay", "cool", "sorry", "ain't", "alright", "lemme"]) assert.equal(isCommonWord(w), true, w);
  });
  it("counts inflected and irregular forms (SCOWL lists them)", () => {
    for (const w of [
      "noticing",
      "noticed",
      "running",
      "doing",
      "meeting",
      "stories",
      "tried",
      "watches",
      "shortly",
      "teams",
      "heard",
      "spent",
      "ears",
      "dirty",
    ])
      assert.equal(isCommonWord(w), true, w);
  });
  it("still treats names as names, possessives included", () => {
    for (const w of ["Zorvax", "Brindle", "Kaelan", "Kaelan's", "Hera", "Fred", "Wes", "Yonnah", "Emily", "Jamal", "Christina", "Yusuf", "Ludwig"])
      assert.equal(isCommonWord(w), false, w);
  });
});

/** A made-up stream intro, dense with handle-like names that sound like everyday words. */
const TRANSCRIPT =
  "hey everyone I don't know if you're gonna believe it but I'm noticing that Zorvacks is here tonight and the Brindel crew didn't show up so we're gonna start without them";
const ENTITIES = ["DrDonnut", "Yonnah", "YourRAZE", "Nicewyg", "Zorvax", "Brindle"];

const words = (text: string): Word[] => text.split(" ").map((t, i) => ({ text: t, start: i, end: i + 0.9 }));

/** A model that over-claims: every name is a name, every candidate a confident replacement. */
function overclaimingModel() {
  return new MockLanguageModelV4({
    doGenerate: async (opts) => {
      const prompt = JSON.stringify(opts.prompt);
      const text = prompt.includes("From the list below")
        ? JSON.stringify({ names: ENTITIES })
        : JSON.stringify({ decisions: [...prompt.matchAll(/#(\d+):/g)].map((m) => ({ id: Number(m[1]), replace: true, confidence: 0.95 })) });
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      };
    },
  });
}

describe("correctTranscript with an over-claiming model", () => {
  const raw = words(TRANSCRIPT);

  it("never proposes a name over an everyday word that does not sound like it", () => {
    const heard = findCandidates(raw, ENTITIES).map((c) => c.heard);
    for (const w of ["don't", "you're", "gonna", "noticing", "didn't"]) assert.ok(!heard.includes(w), `no candidate for "${w}"`);
  });

  it("applies the misheard names, and only them, however confident the model is", async () => {
    const res = await correctTranscript(overclaimingModel(), raw, ENTITIES, { title: "Stream intro" });
    assert.deepEqual(res.flags.map((f) => `${f.heard}:${f.status}`).sort(), ["Brindel:auto", "Zorvacks:auto"]);
    const text = res.words.map((w) => w.text).join(" ");
    assert.match(text, /I don't know if you're gonna believe it but I'm noticing that Zorvax is here/);
    assert.match(text, /Brindle crew didn't show/);
  });

  it("never proposes a fix the user rejected before", async () => {
    const res = await correctTranscript(
      overclaimingModel(),
      raw,
      ENTITIES,
      { title: "Stream intro" },
      { rejected: new Set([fixPairKey("Zorvacks", "Zorvax")]) },
    );
    assert.deepEqual(
      res.flags.map((f) => f.heard),
      ["Brindel"],
    );
  });
});

/**
 * Wrong name fixes of the kinds seen in review (2026-11): everyday words, handles, addresses, possessives and other
 * names "fixed" to an entity from the video's metadata. Each is the heard words in a short sentence and the name it
 * was "fixed" to. None may become a candidate.
 */
const REJECTED: Array<[string, string]> = [
  ["stop following me", "Steam"],
  ["stay back", "Steam"],
  ["I've ever played", "Server"],
  ["not blinking", "BLINK IRL"],
  ["let's go. Come on", "GCMX"],
  ["ordinary FNF game", "fnaf1"],
  ["where you're exposed", "Aura"],
  ["go to aura.com slash", "Aura"],
  ["about a year and a half", "Aura"],
  ["my future brother", "FOOTAGE"],
  ["very happy for me", "Hopecore"],
  ["temptations pull you back", "Apollo"],
  ["I'd be like whoa", "DOUBLE KILL"],
  ["the eye dissection", "Discord"],
  ["just to survive, collect", "Server"],
  ["she told Rachel about it", "Michelle"],
  ["back to Michelle's place", "Michelle"],
  ["in Austin's best", "Austin"],
  ["a family from Texas.", "Texan"],
  ["the bloggers said", "Blender's"],
  ["blend the shapes", "Blender"],
  ["in 3D space", "b3d"],
  ["head to Blender.org, today", "Blender"],
  ["on the board.", "b3d"],
  ["a better tool", "Blender"],
  ["see you at the beacon, folks", "BCON25"],
  ["a second monitor", "Monicah"],
  ["product managers often", "ProductManager"],
  ["products that sell", "Product School"],
  ["I got it", "God"],
  ["steer clear", "Stav"],
  ["one bite of it", "Brut"],
  ["good question here", "Austin"],
  ["the man said", "Texan"],
  ["it took like a week", "TikTok"],
  ["at SamTalent.com. now", "Sam Tallent"],
  ["I was thinking", "Thanksgiving"],
];

/** Misheard names the pass must still find. */
const MISHEARD: Array<[string, string]> = [
  ["so Zorvacks is here", "Zorvax"],
  ["the Brindel crew", "Brindle"],
  ["thanks Monica for joining", "Monicah"],
  ["the Totonax people", "Totonacs"],
];

describe("findCandidates on real rejected fixes", () => {
  for (const [said, entity] of REJECTED)
    it(`"${said}" is not "${entity}"`, () => {
      const c = findCandidates(words(said), [entity]);
      assert.deepEqual(
        c.map((x) => x.heard),
        [],
      );
    });
  for (const [said, entity] of MISHEARD)
    it(`"${said}" may be "${entity}"`, () => {
      assert.ok(findCandidates(words(said), [entity]).length > 0);
    });
  it("a real word that sounds exactly like the name waits for review and needs a sure model", () => {
    const [c] = findCandidates(words("all that stuff here"), ["Stav"]);
    assert.equal(c?.realWord, true);
  });
});

describe("metaphone", () => {
  it("keys sound, not spelling", () => {
    for (const [a, b] of [
      ["Monica", "Monicah"] as const,
      ["stuff", "Stav"],
      ["Brindel", "Brindle"] as const,
      ["Kalen", "Kaelan"] as const,
      ["phone", "fone"] as const,
    ])
      assert.equal(metaphone(a), metaphone(b), `${a} ~ ${b}`);
    for (const [a, b] of [["stop", "Steam"] as const, ["Rachel", "Michelle"] as const, ["Texas", "Texan"] as const, ["happy", "appy"] as const])
      assert.notEqual(metaphone(a), metaphone(b), `${a} ≁ ${b}`);
  });
});

describe("isCorrectable", () => {
  it("keeps names, drops everyday words, handles and spelled-out letters", () => {
    for (const e of ["Zorvax", "Monicah", "Sam Tallent", "Tlaxcalans", "BLINK IRL"]) assert.equal(isCorrectable(e), true, e);
    for (const e of ["Steam", "Server", "God", "DOUBLE KILL", "ProductManager", "Product School", "b3d", "BCON25", "GCMX"])
      assert.equal(isCorrectable(e), false, e);
  });
});
