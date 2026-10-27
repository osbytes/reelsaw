import { test } from "node:test";
import assert from "node:assert/strict";
import { expireInSecondsFor, QUEUES } from "../src/queue/boss.js";

test("long LLM stages get twice the media duration, clamped to 30 min .. 3 h", () => {
  assert.equal(expireInSecondsFor(QUEUES.analyze, 300), 1800);
  assert.equal(expireInSecondsFor(QUEUES.analyze, 3600), 7200);
  assert.equal(expireInSecondsFor(QUEUES.refineEntities, 5 * 3600), 3 * 3600);
});

test("other queues and unknown durations keep the queue default", () => {
  assert.equal(expireInSecondsFor(QUEUES.render, 7200), undefined);
  assert.equal(expireInSecondsFor(QUEUES.analyze, null), undefined);
  assert.equal(expireInSecondsFor(QUEUES.analyze, 0), undefined);
});
