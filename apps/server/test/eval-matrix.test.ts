/**
 * Pure units of the eval matrix: profile parsing, call metering and the gateway → vendor mapping
 * for transcription options. No stack needed: node --import tsx --test test/eval-matrix.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProfiles } from "../src/eval/profiles.js";
import { createMeter, percentile, reportedCost, summarize } from "../src/eval/meter.js";
import { underlyingProvider, providerOf } from "../src/ai/registry.js";

describe("profiles", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reelsaw-matrix-"));
  const file = path.join(dir, "m.json");
  fs.writeFileSync(file, JSON.stringify({ profiles: { a: { AI_MODEL: "gateway:openai/gpt-4o-mini" }, b: { AI_MODEL: "compat:qwen3:8b", TRANSCRIPTION_MODEL: "deepgram:nova-3" } } }));

  it("reads every profile of a matrix file in order", () => {
    const p = parseProfiles({ matrix: file, set: [] });
    assert.deepEqual(
      p.map((x) => x.name),
      ["a", "b"],
    );
    assert.equal(p[1]!.env.TRANSCRIPTION_MODEL, "deepgram:nova-3");
  });

  it("filters with --profiles and rejects unknown names", () => {
    assert.deepEqual(
      parseProfiles({ matrix: file, profiles: "b", set: [] }).map((x) => x.name),
      ["b"],
    );
    assert.throws(() => parseProfiles({ matrix: file, profiles: "zzz", set: [] }), /unknown profile\(s\) zzz/);
  });

  it("builds one ad-hoc profile from --set pairs, named after the values", () => {
    const [p] = parseProfiles({ set: ["AI_MODEL=gateway:openai/gpt-4o-mini", "DISFLUENCY_LLM=false"] });
    assert.equal(p!.name, "gateway:openai/gpt-4o-mini+false");
    assert.deepEqual(p!.env, { AI_MODEL: "gateway:openai/gpt-4o-mini", DISFLUENCY_LLM: "false" });
    assert.throws(() => parseProfiles({ set: ["NOPE"] }), /KEY=VALUE/);
  });

  it("returns nothing without --matrix or --set (the runner then uses the default .env)", () => {
    assert.deepEqual(parseProfiles({ set: [] }), []);
  });
});

describe("meter", () => {
  it("percentiles use nearest-rank on the sorted list", () => {
    assert.equal(percentile([], 50), 0);
    assert.equal(percentile([10], 95), 10);
    assert.equal(percentile([1, 2, 3, 4], 50), 2);
    assert.equal(percentile([1, 2, 3, 4], 95), 4);
  });

  it("summarises calls since the last mark, by kind, with cost only when reported", () => {
    const m = createMeter();
    m.record({ kind: "llm", model: "x", ms: 100, ok: true, inputTokens: 10, outputTokens: 5 });
    m.mark();
    m.record({ kind: "llm", model: "x", ms: 200, ok: true, inputTokens: 1000, outputTokens: 50, costUsd: 0.001 });
    m.record({ kind: "llm", model: "x", ms: 400, ok: false, error: "boom" });
    m.record({ kind: "stt", model: "y", ms: 2000, ok: true, audioSec: 60 });
    const llm = m.summary("llm");
    assert.equal(llm.calls, 2);
    assert.equal(llm.errors, 1);
    assert.equal(llm.inputTokens, 1000);
    assert.equal(llm.p50Ms, 200);
    assert.equal(llm.p95Ms, 400);
    assert.equal(llm.costUsd, 0.001);
    const stt = m.summary("stt");
    assert.equal(stt.calls, 1);
    assert.equal(stt.sttRealtimeFactor, 30);
    assert.equal(stt.costUsd, undefined);
    assert.equal(m.summary().calls, 3);
  });

  it("reads the AI Gateway's per-request cost and ignores anything else", () => {
    assert.equal(reportedCost({ gateway: { cost: "0.00042" } }), 0.00042);
    assert.equal(reportedCost({ gateway: { cost: 0.1 } }), 0.1);
    assert.equal(reportedCost({ gateway: {} }), undefined);
    assert.equal(reportedCost({ openai: { cost: "1" } }), undefined);
    assert.equal(reportedCost(undefined), undefined);
    assert.equal(summarize([]).costUsd, undefined);
  });
});

describe("underlyingProvider", () => {
  it("is the provider itself for direct ids", () => {
    assert.equal(underlyingProvider("openai:whisper-1"), "openai");
    assert.equal(underlyingProvider("deepgram:nova-3"), "deepgram");
    assert.equal(underlyingProvider("compat:qwen3:8b"), "compat");
    assert.equal(providerOf("compat:qwen3:8b"), "compat");
  });
  it("is the vendor inside a gateway id, Microsoft served through Azure", () => {
    assert.equal(underlyingProvider("gateway:openai/whisper-1"), "openai");
    assert.equal(underlyingProvider("gateway:anthropic/claude-sonnet-4.5"), "anthropic");
    assert.equal(underlyingProvider("gateway:microsoft/mai-transcribe-2"), "azure");
  });
});
