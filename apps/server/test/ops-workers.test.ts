/** Worker registry: identity, live vs stale, sort order (no database). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyWorkers, processRole, workerIdOf, WORKER_STALE_MS } from "../src/ops/workers.js";
import type { WorkerRenders, WorkerRole } from "../src/db/schema.js";

const renders: WorkerRenders = { running: 0, limit: 2, max: 2, mode: "auto" };
const now = new Date("2026-10-20T16:00:00.000Z");

function row(p: { id: string; role: WorkerRole; hostname: string; seenAgoMs: number }) {
  const lastSeenAt = new Date(now.getTime() - p.seenAgoMs);
  return {
    id: p.id,
    role: p.role,
    hostname: p.hostname,
    startedAt: new Date(now.getTime() - 60_000),
    lastSeenAt,
    version: "dev",
    commit: "abc",
    pid: 1,
    cpus: 4,
    memTotalMB: 8192,
    diskFreeMB: 4096,
    diskTotalMB: 102400,
    gpu: null,
    renders,
    queues: ["project.ingest"],
    processing: [] as [],
  };
}

describe("workerIdOf / processRole", () => {
  it("uses WORKER_ID when set, otherwise hostname:pid", () => {
    assert.equal(workerIdOf({ WORKER_ID: "worker-2" }, "box", 99), "worker-2");
    assert.equal(workerIdOf({ WORKER_ID: undefined }, "box", 99), "box:99");
    assert.equal(workerIdOf({ WORKER_ID: "  " }, "box", 99), "box:99");
  });
  it("names the process from RUN_HTTP / RUN_WORKERS", () => {
    assert.equal(processRole({ RUN_HTTP: true, RUN_WORKERS: true }), "app");
    assert.equal(processRole({ RUN_HTTP: true, RUN_WORKERS: false }), "api");
    assert.equal(processRole({ RUN_HTTP: false, RUN_WORKERS: true }), "worker");
  });
});

describe("classifyWorkers", () => {
  it("marks a beat older than 45 s stale, keeps a fresh one live, and flags this process", () => {
    const items = classifyWorkers(
      [row({ id: "a", role: "app", hostname: "api", seenAgoMs: 5_000 }), row({ id: "b", role: "worker", hostname: "w1", seenAgoMs: WORKER_STALE_MS + 1 })],
      now,
      "a",
    );
    assert.equal(items[0]?.id, "a");
    assert.equal(items[0]?.live, true);
    assert.equal(items[0]?.thisProcess, true);
    assert.equal(items[0]?.diskFreeMB, 4096);
    assert.equal(items[0]?.diskTotalMB, 102400);
    assert.equal(items[1]?.id, "b");
    assert.equal(items[1]?.live, false);
    assert.equal(items[1]?.thisProcess, false);
  });
  it("sorts live first, then workers before API, then hostname", () => {
    const items = classifyWorkers(
      [
        row({ id: "api", role: "api", hostname: "z", seenAgoMs: 1000 }),
        row({ id: "w2", role: "worker", hostname: "b", seenAgoMs: 1000 }),
        row({ id: "w1", role: "worker", hostname: "a", seenAgoMs: 1000 }),
        row({ id: "gone", role: "worker", hostname: "a", seenAgoMs: 60_000 }),
      ],
      now,
      "none",
    );
    assert.deepEqual(
      items.map((w) => w.id),
      ["w1", "w2", "api", "gone"],
    );
  });
});
