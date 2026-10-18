/**
 * Caption reading pace: a line stays up max(0.7 s, 0.3 s per word, 1/20 s per character), capped at
 * the next line's start. Pure: no stack needed.
 * Run: node --import tsx --test test/caption-pace.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lineDisplayEnd, lineMinSeconds } from "@reelsaw/shared";

/** n words spoken quickly (0.1 s each) starting at t0 */
const line = (n: number, t0 = 0, word = "ab") => Array.from({ length: n }, (_, i) => ({ text: word, start: t0 + i * 0.1, end: t0 + i * 0.1 + 0.1 }));

describe("caption pace", () => {
  it("keeps the 0.7 s floor for 1- and 2-word lines", () => {
    assert.equal(lineDisplayEnd([line(1)], 0), 0.7);
    assert.equal(lineDisplayEnd([line(2)], 0), 0.7);
  });
  it("holds longer lines 0.3 s per word", () => {
    assert.ok(Math.abs(lineDisplayEnd([line(4)], 0) - 1.2) < 1e-9);
    assert.ok(Math.abs(lineDisplayEnd([line(6)], 0) - 1.8) < 1e-9);
  });
  it("holds a 28-character line for 1.4 s", () => {
    const l = [{ text: "internationalization", start: 0, end: 0.2 }, { text: "matters", start: 0.2, end: 0.4 }]; // 20 + 1 + 7 = 28
    assert.equal(lineMinSeconds(l), 1.4);
    assert.equal(lineDisplayEnd([l], 0), 1.4);
  });
  it("never runs into the next line", () => {
    const lines = [line(4), line(4, 0.9)];
    assert.equal(lineDisplayEnd(lines, 0), 0.9);
  });
  it("shows a line at least as long as it was spoken", () => {
    const slow = [{ text: "a", start: 0, end: 2 }];
    assert.equal(lineDisplayEnd([slow], 0), 2);
  });
});
