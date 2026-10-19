/**
 * CTC forced-align lattice: pure function over synthetic emissions, no ONNX.
 * Run: node --import tsx --test test/align.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { forceAlign } from "../src/audio/align.js";

/** Minimal wav2vec2-style vocab: blank, letters, word separator. */
const VOCAB: Record<string, number> = {
  "<pad>": 0,
  A: 1,
  B: 2,
  E: 3,
  H: 4,
  L: 5,
  O: 6,
  "|": 7,
};
const BLANK = 0;
const SEP = 7;
const C = 8;

/** One-hot-ish log emissions: chosen class ≈ 0, others ≈ -10. */
function emissions(path: number[]): Float32Array {
  const T = path.length;
  const emit = new Float32Array(T * C);
  for (let t = 0; t < T; t++) {
    for (let c = 0; c < C; c++) emit[t * C + c] = -10;
    emit[t * C + path[t]!] = 0;
  }
  return emit;
}

describe("forceAlign CTC lattice", () => {
  it("aligns a word without repeated letters", () => {
    // H E L O with optional blanks — no doubled letter
    const path = [BLANK, VOCAB.H!, VOCAB.E!, VOCAB.L!, VOCAB.O!, BLANK];
    const spans = forceAlign(emissions(path), path.length, C, ["HELO"], VOCAB, BLANK, SEP);
    assert.equal(spans.length, 1);
    assert.ok(spans[0]!.start !== undefined);
    assert.ok(spans[0]!.end! > spans[0]!.start!);
  });

  it("requires a blank between adjacent repeated letters", () => {
    // Valid CTC path for HELLO: … L blank L …
    const path = [VOCAB.H!, VOCAB.E!, VOCAB.L!, BLANK, VOCAB.L!, VOCAB.O!];
    const spans = forceAlign(emissions(path), path.length, C, ["HELLO"], VOCAB, BLANK, SEP);
    assert.equal(spans.length, 1);
    assert.ok(spans[0]!.start !== undefined, "HELLO must be reachable via L ∅ L");
    assert.ok(spans[0]!.end! > spans[0]!.start!);
  });

  it("does not treat L L without a blank as a path for HELLO", () => {
    // Illegal for HELLO (collapses to HELO). With a proper lattice the full label is unreachable,
    // so the word is left without a span rather than aligned on an invalid path.
    const path = [VOCAB.H!, VOCAB.E!, VOCAB.L!, VOCAB.L!, VOCAB.O!];
    const spans = forceAlign(emissions(path), path.length, C, ["HELLO"], VOCAB, BLANK, SEP);
    assert.equal(spans[0]!.start, undefined);
  });

  it("still aligns AA when a blank separates the two A's", () => {
    const path = [VOCAB.A!, BLANK, VOCAB.A!];
    const spans = forceAlign(emissions(path), path.length, C, ["AA"], VOCAB, BLANK, SEP);
    assert.ok(spans[0]!.start !== undefined);
    assert.equal(spans[0]!.start, 0);
    assert.equal(spans[0]!.end, 0.06); // frames 0 and 2 at 20 ms
  });

  it("leaves AA unaligned when only A A frames exist (no blank)", () => {
    const path = [VOCAB.A!, VOCAB.A!];
    const spans = forceAlign(emissions(path), path.length, C, ["AA"], VOCAB, BLANK, SEP);
    assert.equal(spans[0]!.start, undefined);
  });

  it("keeps word order across a separator", () => {
    const path = [VOCAB.A!, SEP, VOCAB.B!];
    const spans = forceAlign(emissions(path), path.length, C, ["A", "B"], VOCAB, BLANK, SEP);
    assert.ok(spans[0]!.start !== undefined && spans[1]!.start !== undefined);
    assert.ok(spans[0]!.start! <= spans[1]!.start!);
  });
});
