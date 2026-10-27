import { test } from "node:test";
import assert from "node:assert/strict";
import { expireInSecondsFor, MAX_JOB_EXPIRE_SECONDS, QUEUES } from "../src/queue/boss.js";

test("long LLM stages get the queue default plus the media duration, up to 24 h", () => {
  assert.equal(expireInSecondsFor(QUEUES.analyze, 300), 2100);
  assert.equal(expireInSecondsFor(QUEUES.analyze, 3600), 5400);
  assert.equal(expireInSecondsFor(QUEUES.refineEntities, 5 * 3600), 1800 + 5 * 3600);
  assert.equal(expireInSecondsFor(QUEUES.analyze, 40 * 3600), MAX_JOB_EXPIRE_SECONDS);
});

test("a self-hosted language model gets four times the duration", () => {
  assert.equal(expireInSecondsFor(QUEUES.analyze, 3600, true), 1800 + 4 * 3600);
  assert.equal(expireInSecondsFor(QUEUES.analyze, 3397, true), 1800 + 4 * 3397);
  assert.equal(expireInSecondsFor(QUEUES.refineDisfluency, 5 * 3600, true), 1800 + 4 * 5 * 3600);
});

test("the backstop never passes 24 h, the most pg-boss and the disk leases allow", () => {
  assert.equal(MAX_JOB_EXPIRE_SECONDS, 24 * 3600);
  assert.equal(expireInSecondsFor(QUEUES.analyze, 10 * 24 * 3600, true), 24 * 3600);
});

test("other queues and unknown durations keep the queue default", () => {
  assert.equal(expireInSecondsFor(QUEUES.render, 7200), undefined);
  assert.equal(expireInSecondsFor(QUEUES.render, 7200, true), undefined);
  assert.equal(expireInSecondsFor(QUEUES.analyze, null), undefined);
  assert.equal(expireInSecondsFor(QUEUES.analyze, 0), undefined);
});
