/** Queue / operations core decisions that need no database: reconciler give-up, WORKER_ID collision, health checks, disk queues. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INTERRUPTED_MESSAGE, MAX_RECONCILE_REQUEUES, shouldGiveUp } from "../src/queue/reconcile.js";
import { disambiguateWorkerId, WORKER_ID_IN_USE_MS, WORKER_STALE_MS } from "../src/ops/workers.js";
import { healthy, heartbeatFresh, settle } from "../src/health.js";
import { DISK_QUEUES } from "../src/queue/disk-gate.js";
import { QUEUES } from "../src/queue/boss.js";

describe("reconciler give-up", () => {
  it("re-enqueues three times and fails on the fourth", () => {
    assert.equal(MAX_RECONCILE_REQUEUES, 3);
    assert.deepEqual([1, 2, 3, 4, 5].map(shouldGiveUp), [false, false, false, true, true]);
  });
  it("says what happened and what to do in plain words", () => {
    assert.match(INTERRUPTED_MESSAGE, /interrupted 4 times/);
    assert.match(INTERRUPTED_MESSAGE, /Retry to try again\.$/);
  });
});

describe("WORKER_ID collision", () => {
  const now = new Date("2026-10-26T12:00:00.000Z");
  it("keeps the pinned id when nobody beat under it lately", () => {
    assert.equal(disambiguateWorkerId("worker", null, now, "ab12"), "worker");
    assert.equal(disambiguateWorkerId("worker", new Date(now.getTime() - WORKER_ID_IN_USE_MS - 1), now, "ab12"), "worker");
  });
  it("appends the suffix when a live process beat under it", () => {
    assert.equal(disambiguateWorkerId("worker", new Date(now.getTime() - 5_000), now, "ab12"), "worker-ab12");
    assert.equal(disambiguateWorkerId("worker", new Date(now.getTime() - WORKER_ID_IN_USE_MS), now, "ab12"), "worker-ab12");
  });
});

describe("health checks", () => {
  it("settle reports ok, a reason, a rejection and a timeout", async () => {
    const errors: unknown[] = [];
    assert.equal(await settle(async () => null, (e) => errors.push(e)), "ok");
    assert.equal(await settle(async () => "queue is down", (e) => errors.push(e)), "queue is down");
    assert.equal(await settle(async () => Promise.reject(new Error("ECONNREFUSED 10.0.0.5")), (e) => errors.push(e)), "unreachable");
    assert.equal(errors.length, 1, "the rejection goes to the log, not the response");
    assert.equal(await settle(() => new Promise<string | null>(() => {}), (e) => errors.push(e), 20), "timed out after 0.02 s");
    assert.equal(errors.length, 1);
  });
  it("is healthy only when every check is ok", () => {
    assert.equal(healthy({ db: "ok", events: "ok", queue: "ok" }), true);
    assert.equal(healthy({ db: "ok", events: "ok", queue: "ok", workers: "ok" }), true);
    assert.equal(healthy({ db: "ok", events: "event listener is not connected", queue: "ok" }), false);
    assert.equal(healthy({ db: "ok", events: "ok", queue: "ok", workers: "worker heartbeat is stale" }), false);
  });
  it("a heartbeat is fresh for three missed beats", () => {
    const now = new Date("2026-10-26T12:00:00.000Z");
    assert.equal(heartbeatFresh(undefined, now), false);
    assert.equal(heartbeatFresh(new Date(now.getTime() - WORKER_STALE_MS), now), true);
    assert.equal(heartbeatFresh(new Date(now.getTime() - WORKER_STALE_MS - 1), now), false);
  });
});

describe("disk queues", () => {
  it("includes refine.scenes (it pulls the full source) but not the transcript-only refine queues", () => {
    assert.ok(DISK_QUEUES.includes(QUEUES.refineScenes));
    assert.ok(!DISK_QUEUES.includes(QUEUES.refineEntities));
    assert.ok(!DISK_QUEUES.includes(QUEUES.refineDisfluency));
  });
});
