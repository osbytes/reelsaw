/** Pure estimate math: medians over same-model history, defaults otherwise, local vs cloud detection. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FACTORS, defaultFactors, estimateStages, isLocalModel, median, processingTimes, type StageSample } from "../src/pipeline/estimates.js";

const cfgLocal = { OPENAI_BASE_URL: "http://speaches:8000/v1", OPENAI_COMPATIBLE_NAME: "compat" };
const cfgCloud = { OPENAI_BASE_URL: undefined, OPENAI_COMPATIBLE_NAME: "compat" };
const local = { language: "compat:qwen2.5:14b", transcription: "openai:Systran/faster-whisper-small" };
const cloud = { language: "gateway:openai/gpt-4o-mini", transcription: "deepgram:nova-3" };

const sample = (i: number, durationSec: number, stages: StageSample["stages"], models = local): StageSample => ({
  projectId: `p${i}`,
  title: `P${i}`,
  durationSec,
  finishedAt: "2026-10-17T00:00:00Z",
  models,
  stages,
});

describe("estimates", () => {
  it("median handles odd, even and empty", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.ok(Number.isNaN(median([])));
  });

  it("local = compat, or openai behind a base URL; vendors and the gateway are cloud", () => {
    assert.equal(isLocalModel("compat:qwen2.5:14b", cfgLocal), true);
    assert.equal(isLocalModel("openai:Systran/faster-whisper-small", cfgLocal), true);
    assert.equal(isLocalModel("openai:whisper-1", cfgCloud), false);
    assert.equal(isLocalModel("gateway:openai/whisper-1", cfgLocal), false);
    assert.equal(isLocalModel("deepgram:nova-3", cfgLocal), false);
  });

  it("defaults pick per stage from the model that runs it", () => {
    const mixed = defaultFactors({ language: "gateway:anthropic/claude-haiku-4.5", transcription: "openai:Systran/faster-whisper-small" }, cfgLocal);
    assert.equal(mixed.transcribe, DEFAULT_FACTORS.local.transcribe);
    assert.equal(mixed.analyze, DEFAULT_FACTORS.cloud.analyze);
    assert.equal(mixed.refine, DEFAULT_FACTORS.cloud.refine);
  });

  it("uses the median of comparable history per stage, defaults where history is missing", () => {
    const history = [
      sample(1, 600, { transcribe: 120, analyze: 60 }),
      sample(2, 1200, { transcribe: 360, analyze: 120 }),
      sample(3, 300, { transcribe: 30 }),
      sample(9, 600, { transcribe: 6, render: 30 }, cloud),
    ];
    const est = estimateStages(1200, local, history, defaultFactors(local, cfgLocal));
    const by = Object.fromEntries(est.map((e) => [e.stage, e]));
    // factors 0.2, 0.3, 0.1 → median 0.2 → 240 s; the cloud-STT project is not comparable for transcribe
    assert.deepEqual(by.transcribe, { stage: "transcribe", expectedSec: 240, source: "history", samples: 3 });
    assert.equal(by.analyze!.expectedSec, 120);
    assert.equal(by.analyze!.samples, 2);
    // render depends on no model: the cloud project counts (30 / 600 = 0.05 → 60 s)
    assert.deepEqual(by.render, { stage: "render", expectedSec: 60, source: "history", samples: 1 });
    assert.equal(by.ingest!.source, "default");
    assert.equal(by.ingest!.expectedSec, Math.round(DEFAULT_FACTORS.local.ingest * 1200));
  });

  it("matches per stage on the model that drives it, so a transcript-only artifact still counts", () => {
    // older projects recorded only the language model (no transcribe artifact): comparable for analyze, not for transcribe
    const history = [sample(1, 600, { transcribe: 120, analyze: 60 }, { language: local.language } as never)];
    const by = Object.fromEntries(estimateStages(600, local, history, defaultFactors(local, cfgLocal)).map((e) => [e.stage, e]));
    assert.equal(by.analyze!.source, "history");
    assert.equal(by.transcribe!.source, "default");
  });

  it("processingTimes reports factor, fit and the recent projects for the current models", () => {
    const history = [sample(1, 600, { transcribe: 120 }), sample(2, 1200, { transcribe: 360 }), sample(9, 600, { transcribe: 6 }, cloud)];
    const pt = processingTimes(local, history, defaultFactors(local, cfgLocal));
    assert.equal(pt.samples, 2);
    const t = pt.stages.find((s) => s.stage === "transcribe")!;
    assert.equal(t.source, "history");
    assert.equal(t.factor, 0.25);
    assert.equal(t.actualAvgSec, 240);
    assert.equal(t.expectedAvgSec, Math.round((0.25 * 600 + 0.25 * 1200) / 2));
    assert.equal(pt.recent.length, 2);
    assert.deepEqual(pt.recent[0]!.stages.transcribe, { actualSec: 120, expectedSec: 150 });
    assert.equal(pt.stages.find((s) => s.stage === "render")!.source, "default");
  });
});
