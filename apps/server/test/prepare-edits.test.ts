/**
 * clip.prepare writes its packaging only where the user has not edited the clip since the job read it.
 * node --import tsx --test test/prepare-edits.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { preparedPatch } from "../src/pipeline/manual.js";

const started = { title: "New clip", hook: "", caption: "", hashtags: [], emphasis: null, startSec: 10, endSec: 70 };
const prepared = { title: "AI title", hook: "AI hook", caption: "AI caption", hashtags: ["ai"], emphasis: ["word"], startSec: 22.5, endSec: 51 };

describe("preparedPatch", () => {
  it("an untouched clip takes everything prep found", () => {
    assert.deepEqual(preparedPatch(started, { ...started }, prepared), prepared);
  });

  it("a title the user typed while prep ran survives; the rest still lands", () => {
    const p = preparedPatch(started, { ...started, title: "My title" }, prepared);
    assert.equal(p.title, undefined);
    assert.equal(p.hook, "AI hook");
    assert.deepEqual([p.startSec, p.endSec], [22.5, 51]);
  });

  it("bounds the user moved stay as a pair, even when only one end changed", () => {
    const p = preparedPatch(started, { ...started, endSec: 40 }, prepared);
    assert.equal(p.startSec, undefined);
    assert.equal(p.endSec, undefined);
    assert.equal(p.title, "AI title");
  });

  it("list fields compare by value", () => {
    const p = preparedPatch({ ...started, hashtags: ["a"] }, { ...started, hashtags: ["a"] }, prepared);
    assert.deepEqual(p.hashtags, ["ai"]);
    assert.equal(preparedPatch(started, { ...started, hashtags: ["mine"] }, prepared).hashtags, undefined);
  });
});
