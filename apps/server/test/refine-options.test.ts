/** Instance ceilings + project refine toggles → which refine steps (and the disfluency LLM) run. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { refineStepOn, resolveRefineOptions } from "../src/pipeline/refine-options.js";

const on = { TRANSCRIPT_CORRECTION: true, DISFLUENCY_REMOVAL: true, DISFLUENCY_LLM: true, REFINE_SCENES: true };

describe("resolveRefineOptions", () => {
  it("defaults every step off when the project omits fields (opt-in)", () => {
    const o = resolveRefineOptions(on, {});
    assert.deepEqual(o, { entities: false, disfluency: false, disfluencyLlm: false, scenes: false });
    assert.ok(!refineStepOn(o, "entities") && !refineStepOn(o, "disfluency") && !refineStepOn(o, "scenes"));
  });

  it("runs only the steps the project opts into when the instance ceiling is open", () => {
    const o = resolveRefineOptions(on, { refineEntities: false, refineDisfluency: true, disfluencyLlm: false, refineScenes: false });
    assert.deepEqual(o, { entities: false, disfluency: true, disfluencyLlm: false, scenes: false });
  });

  it("instance off wins over a project that asks for on", () => {
    const o = resolveRefineOptions(
      { TRANSCRIPT_CORRECTION: false, DISFLUENCY_REMOVAL: false, DISFLUENCY_LLM: true, REFINE_SCENES: false },
      { refineEntities: true, refineDisfluency: true, disfluencyLlm: true, refineScenes: true },
    );
    assert.deepEqual(o, { entities: false, disfluency: false, disfluencyLlm: false, scenes: false });
  });

  it("disfluencyLlm stays off when disfluency itself is off", () => {
    const o = resolveRefineOptions(on, { refineDisfluency: false, disfluencyLlm: true });
    assert.equal(o.disfluency, false);
    assert.equal(o.disfluencyLlm, false);
  });

  it("runs the model pass only when both disfluency and disfluencyLlm are opted in", () => {
    const o = resolveRefineOptions(on, { refineDisfluency: true, disfluencyLlm: true });
    assert.deepEqual(o, { entities: false, disfluency: true, disfluencyLlm: true, scenes: false });
  });
});
