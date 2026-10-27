/** Where a retry resumes. Run: node --import tsx --test test/retry-queue.test.ts (no stack needed) */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { retryQueueFor } from "../src/projects/service.js";
import { QUEUES } from "../src/queue/boss.js";

const base = { clips: [], transcript: true, refineDone: true, stage: null, sourceKey: "k" };

describe("retryQueueFor", () => {
  it("renders when live clips exist", () => {
    assert.equal(retryQueueFor({ ...base, clips: [{ origin: "ai" }], stage: "render" }), QUEUES.render);
  });
  it("picks again when analyze failed and only clips the user kept survived", () => {
    assert.equal(retryQueueFor({ ...base, clips: [{ origin: "manual" }], stage: "analyze" }), QUEUES.analyze);
  });
  it("renders when analyze failed but AI picks are there", () => {
    assert.equal(retryQueueFor({ ...base, clips: [{ origin: "ai" }], stage: "analyze" }), QUEUES.render);
  });
  it("falls back to the furthest finished stage without clips", () => {
    assert.equal(retryQueueFor(base), QUEUES.analyze);
    assert.equal(retryQueueFor({ ...base, refineDone: false }), QUEUES.refineEntities);
    assert.equal(retryQueueFor({ ...base, transcript: false }), QUEUES.transcribe);
    assert.equal(retryQueueFor({ ...base, transcript: false, sourceKey: null }), QUEUES.ingest);
  });
});
