/** Queue depth folding (no database). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldCounts, queueLabel, QUEUE_ORDER } from "../src/ops/queue.js";
import { QUEUES } from "../src/queue/boss.js";

describe("foldCounts", () => {
  it("keeps every pipeline queue even when empty, and maps pg-boss states", () => {
    const rows = foldCounts([
      { name: QUEUES.ingest, state: "created", n: 2 },
      { name: QUEUES.ingest, state: "active", n: 1 },
      { name: QUEUES.render, state: "retry", n: 3 },
      { name: QUEUES.render, state: "failed", n: 4 },
      { name: "billing.sync", state: "created", n: 1 },
    ]);
    assert.deepEqual(
      rows.map((r) => r.queue),
      [...QUEUE_ORDER, "billing.sync"],
    );
    const ingest = rows.find((r) => r.queue === QUEUES.ingest)!;
    assert.deepEqual(
      { waiting: ingest.waiting, running: ingest.running, retrying: ingest.retrying, failed: ingest.failed },
      { waiting: 2, running: 1, retrying: 0, failed: 0 },
    );
    const render = rows.find((r) => r.queue === QUEUES.render)!;
    assert.deepEqual(
      { waiting: render.waiting, running: render.running, retrying: render.retrying, failed: render.failed },
      { waiting: 0, running: 0, retrying: 3, failed: 4 },
    );
    assert.equal(queueLabel(QUEUES.refineDisfluency), "fillers");
  });

  it("drops pg-boss's own queues and keeps the earliest eligible wait across waiting and retrying", () => {
    const rows = foldCounts([
      { name: "__pgboss__send-it", state: "created", n: 1, oldest: new Date("2026-01-01T00:00:00Z") },
      { name: QUEUES.render, state: "created", n: 2, oldest: new Date("2026-01-01T00:05:00Z") },
      { name: QUEUES.render, state: "retry", n: 1, oldest: new Date("2026-01-01T00:02:00Z") },
      { name: QUEUES.render, state: "active", n: 1, oldest: new Date("2025-12-31T00:00:00Z") },
    ]);
    assert.ok(!rows.some((r) => r.queue.startsWith("__pgboss")));
    assert.equal(rows.find((r) => r.queue === QUEUES.render)!.oldestWaitingAt, "2026-01-01T00:02:00.000Z");
    assert.equal(rows.find((r) => r.queue === QUEUES.ingest)!.oldestWaitingAt, null);
  });
});
