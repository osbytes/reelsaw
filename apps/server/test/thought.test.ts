/** A clip ends on a complete thought and starts at the start of one. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Word } from "@reelsaw/shared";
import { finishThought, sentenceEndAfter, isConnector } from "../src/pipeline/thought.js";

/** "text@gap" tokens: each word is 0.4 s long, `gap` seconds of silence follows it (default 0.05). */
function words(spec: string): Word[] {
  let t = 0;
  return spec.split(/\s+/).map((tok) => {
    const [text, gap] = tok.split("@");
    const w = { text: text!, start: t, end: t + 0.4 };
    t = w.end + (gap === undefined ? 0.05 : Number(gap));
    return w;
  });
}
const limits = { minSec: 2, maxSec: 30 };
const text = (ws: Word[], a: number, b: number) =>
  ws
    .filter((w) => (w.start + w.end) / 2 > a && (w.start + w.end) / 2 < b)
    .map((w) => w.text)
    .join(" ");

describe("sentenceEndAfter", () => {
  it("punctuation always ends a sentence, even before a lower-case word", () => {
    const ws = words("we left. then it rained");
    assert.equal(sentenceEndAfter(ws, 1), "punctuation");
  });
  it("a pause ends it, a pause after a connector does not", () => {
    const ws = words("it was fine@0.8 and then the@0.9 end");
    assert.equal(sentenceEndAfter(ws, 2), "pause");
    assert.equal(sentenceEndAfter(ws, 5), undefined);
  });
  it("a capital after a gap ends it when there is no punctuation; names and 'I' do not", () => {
    const ws = words("grow into@0.1 And this is it told Alex and I know");
    assert.equal(sentenceEndAfter(ws, 1), "capital");
    assert.equal(sentenceEndAfter(ws, 6), undefined); // "told | Alex": no gap, a name
    assert.equal(sentenceEndAfter(ws, 8), undefined); // "and | I"
  });
  it("lower-case continuation with no pause is inside the sentence", () => {
    assert.equal(sentenceEndAfter(words("different that you can"), 0), undefined);
  });
  it("connectors, with apostrophe variants", () => {
    assert.ok(isConnector("so") && isConnector("And,") && isConnector("You’re") && isConnector("the"));
    assert.ok(!isConnector("different"));
  });
});

describe("finishThought: end", () => {
  // 20 words ≈ 9 s; the clip ends after "so" (word 7), the sentence ends at "friends" (word 14)
  const ws = words("Growing up you change and you're now so different that you can no longer resonate with friends@0.7 And later it ends@1");
  it("extends forward to the next sentence end within budget", () => {
    const r = finishThought(ws, 0, ws[7]!.end, limits);
    assert.equal(text(ws, r.start, r.end).split(" ").at(-1), "friends");
    assert.equal(r.changes[0]!.action, "extend");
    assert.equal(r.changes[0]!.reason, "pause");
  });
  it("does not extend past maxExtendSec; pulls back when that keeps 70% of the clip", () => {
    const long = words("Sentence one runs for quite a while before it ends right here@0.7 then two goes on a bit more");
    const end = long[14]!.end;
    const r = finishThought(long, 0, end, { minSec: 2, maxSec: 30, maxExtendSec: 0.5 });
    assert.equal(r.changes[0]!.action, "pull-back");
    assert.equal(text(long, r.start, r.end).split(" ").at(-1), "here");
  });
  it("pulls back when extending would exceed the max length", () => {
    const w = words("One full thought here@0.7 and now we go on and on so different that it keeps going@0.7 Later it ends@1");
    const r = finishThought(w, 0, w[11]!.end, { minSec: 1, maxSec: 6, maxExtendSec: 20, keepFraction: 0.2 });
    assert.equal(r.changes[0]!.action, "pull-back");
    assert.equal(text(w, r.start, r.end).split(" ").at(-1), "here");
  });
  it("leaves the end alone when nothing is near, and says why", () => {
    const mono = words(Array.from({ length: 40 }, (_, i) => (i % 2 ? "on" : "and")).join(" "));
    const r = finishThought(mono, 0, mono[9]!.end, { minSec: 2, maxSec: 30 });
    assert.equal(r.end, mono[9]!.end);
    assert.equal(r.changes.at(-1)!.action, "left");
  });
  it("never pulls back below the minimum or the kept fraction", () => {
    const w = words("Short one@0.7 and this part is much longer than the start of it all really");
    const r = finishThought(w, 0, w.at(-1)!.end, { minSec: 2, maxSec: 30, maxExtendSec: 0 });
    assert.equal(r.end, w.at(-1)!.end);
  });
  it("a clip already ending on a sentence end is untouched", () => {
    const w = words("It was done. We left@0.3 Later it rained");
    const r = finishThought(w, 0, w[4]!.end, limits);
    assert.deepEqual(r.changes, []);
    assert.equal(r.end, w[4]!.end);
  });
  it("a connector end is extended even when a pause follows it", () => {
    const w = words("we were there and@0.8 then it was over@0.7 Next");
    const r = finishThought(w, 0, w[3]!.end, limits);
    assert.equal(text(w, r.start, r.end).split(" ").at(-1), "over");
  });
  it("respects the bounds of a user selection", () => {
    const r = finishThought(ws, 0, ws[7]!.end, { ...limits, bounds: [0, ws[9]!.end] });
    assert.notEqual(r.changes[0]!.action, "extend");
  });
});

describe("finishThought: start", () => {
  const ws = words("Something happened@0.7 and then you realise@0.1 Because the thing is simple and it ends here@1");
  it("moves earlier to the sentence start within 3 s", () => {
    const from = ws[4]!.start + 0.1; // inside "and then you realise"
    const r = finishThought(ws, from, ws.at(-1)!.end, limits);
    assert.equal(r.start, ws[2]!.start);
    assert.equal(r.changes[0]!.action, "earlier");
  });
  it("moves later when earlier is out of reach but the clip keeps 70%", () => {
    const w = words("a b c d e f g h i j k l m n o p q r s t u v w x y z@0.7 Fresh start here and it goes on for a good while longer yes@1");
    const r = finishThought(w, w[25]!.start - 0.1, w.at(-1)!.end, { minSec: 2, maxSec: 30, maxStartShiftSec: 3 });
    assert.equal(r.start, w[26]!.start);
    assert.equal(r.changes[0]!.action, "later");
  });
  it("leaves a start with no sentence start in reach", () => {
    const w = words("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen");
    const r = finishThought(w, w[8]!.start, w.at(-1)!.end, limits);
    assert.equal(r.start, w[8]!.start);
    assert.equal(r.changes[0]!.action, "left");
  });
});
