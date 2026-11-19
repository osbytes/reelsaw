/** Queue depth folding (no database). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { foldCounts, queueLabel, QUEUE_ORDER } from "../src/ops/queue.js";
import { QUEUES } from "../src/queue/boss.js";
import { queuePriorityOf } from "../src/quota.js";
import { formatPriority, formatSeconds } from "@reelsaw/shared";

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

describe("queue priority", () => {
  const grants = (queuePriority: number) => ({ plan: "pro", planLabel: "Pro", limits: {}, watermark: false, queuePriority, period: null });
  it("an admin's override wins over the plan, 0 included; without either it is 0", () => {
    assert.deepEqual(queuePriorityOf(null, null), { value: 0, source: "instance", plan: 0, override: null });
    assert.deepEqual(queuePriorityOf(null, grants(5)), { value: 5, source: "plan", plan: 5, override: null });
    assert.deepEqual(queuePriorityOf(0, grants(5)), { value: 0, source: "override", plan: 5, override: 0 });
    assert.deepEqual(queuePriorityOf(-3, null), { value: -3, source: "override", plan: 0, override: -3 });
  });

  it("reads the waiting time whether the driver hands back a Date or Postgres text", () => {
    // drizzle's node-postgres driver returns raw db.execute timestamps as text, not Date
    const rows = foldCounts([{ name: QUEUES.render, state: "created", n: 1, oldest: "2026-01-01 00:02:00.5+00" }]);
    assert.equal(rows.find((r) => r.queue === QUEUES.render)!.oldestWaitingAt, "2026-01-01T00:02:00.500Z");
  });

  it("starts every stage with no pickups measured", () => {
    for (const r of foldCounts([])) assert.deepEqual(r.pickup, { started: 0, p50Sec: null, p95Sec: null, maxSec: null });
  });

  it("formats a priority as an offset", () => {
    assert.deepEqual([formatPriority(5), formatPriority(0), formatPriority(-3)], ["+5", "0", "-3"]);
  });

  it("formats waits the way people read them", () => {
    assert.equal(formatSeconds(null), "—");
    assert.equal(formatSeconds(0.2), "<1 s");
    assert.equal(formatSeconds(42.4), "42 s");
    assert.equal(formatSeconds(59.7), "1 min");
    assert.equal(formatSeconds(7 * 60 + 5), "7 min");
    assert.equal(formatSeconds(2 * 3600 + 5 * 60), "2 h 5 min");
  });
});
