/** Rubric scoring of candidate batches. Run: node --import tsx --test test/select-score.test.ts (no stack needed) */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { buildScorePrompt, scoreSample, type ScoreInput, type SelectContext } from "../src/pipeline/select.js";

const sc: SelectContext = { title: "t", durationSec: 600, minSec: 20, maxSec: 60 };
const items: ScoreInput[] = [10, 11, 12, 13].map((id) => ({ id, durationSec: 30, text: `candidate text ${id}` }));

/** A judge that answers only the first candidate of every prompt (what qwen2.5:14b did with a one-entry example). */
function firstOnlyJudge(prompts: string[]) {
  return new MockLanguageModelV4({
    doGenerate: async (opts) => {
      const prompt = JSON.stringify(opts.prompt);
      prompts.push(prompt);
      // the text of the candidate shown first, so the score can follow the candidate, not the place
      const first = Number(/candidate text (\d+)/.exec(prompt)?.[1]);
      const text = JSON.stringify({ scores: [{ id: 1, hook: first - 5, flow: 5, value: 5, shareability: 5, emphasis: [] }] });
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
        warnings: [],
      };
    },
  });
}

describe("scoreSample", () => {
  it("scores every candidate of a batch even when the judge answers only the first", async () => {
    const prompts: string[] = [];
    const got = await scoreSample({ model: firstOnlyJudge(prompts), telemetry: false }, items, sc, 1);
    assert.deepEqual(
      got.map((s) => s.id).sort(),
      items.map((i) => i.id),
    );
    // each answer belongs to its own candidate (hook = id - 5 in the fake judge)
    for (const s of got) assert.equal(s.hook, s.id - 5);
    assert.equal(prompts.length, 4, "one batch call, then one call per candidate left out");
  });

  it("rotates the batch by the sample number, so samples see each candidate in different places", async () => {
    const prompts: string[] = [];
    await scoreSample({ model: firstOnlyJudge(prompts), telemetry: false }, items, sc, 3, 1);
    assert.match(prompts[0]!, /candidate text 11/);
    assert.ok(prompts[0]!.indexOf("candidate text 11") < prompts[0]!.indexOf("candidate text 10"), "sample 1 starts at the second candidate");
  });
});

describe("buildScorePrompt", () => {
  it("asks for one entry per candidate and gives no example numbers to copy", () => {
    const p = buildScorePrompt(
      items.map((it, i) => ({ ...it, id: i + 1 })),
      sc,
    );
    assert.match(p, /exactly 4 entries/);
    for (const id of [1, 2, 3, 4]) assert.ok(p.includes(`{"id":${id},"hook":<0-10>`), `example entry for id ${id}`);
    assert.doesNotMatch(p, /"hook":\d/);
  });
});
