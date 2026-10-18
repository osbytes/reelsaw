/** Planning for history pruning: batch-delete selection. No database. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planPruneBatch, retentionCutoff, PROTECTED_EVENT_TYPES, type PruneRow } from "../src/events-retention.js";

const CUT = new Date("2026-07-19T00:00:00Z");
const old = (id: number, type = "stage.progress"): PruneRow => ({ id, type, createdAt: new Date("2026-01-01T00:00:00Z") });
const young = (id: number, type = "stage.progress"): PruneRow => ({ id, type, createdAt: new Date("2026-10-01T00:00:00Z") });

describe("retentionCutoff", () => {
  it("0 days = off, otherwise now minus days", () => {
    assert.equal(retentionCutoff(0), null);
    assert.equal(retentionCutoff(90, Date.parse("2026-10-17T00:00:00Z"))!.toISOString(), "2026-07-19T00:00:00.000Z");
  });
});

describe("planPruneBatch", () => {
  it("deletes old rows in id order and moves the cursor to the last one", () => {
    const p = planPruneBatch([old(1), old(2), old(3)], 0, CUT, 3);
    assert.deepEqual(p.deleteIds, [1, 2, 3]);
    assert.equal(p.cursor, 3);
    assert.equal(p.done, false); // a full page: ask for the next
  });
  it("keeps the run skeleton but moves the cursor past it so it is never rescanned", () => {
    const rows = [old(1, "project.created"), old(2, "run.started"), old(3), old(4, "project.done"), old(5, "clip.done")];
    const p = planPruneBatch(rows, 0, CUT, 5, PROTECTED_EVENT_TYPES);
    assert.deepEqual(p.deleteIds, [3, 5]);
    assert.equal(p.cursor, 5);
  });
  it("stops at the first row newer than the cutoff and does not advance past it", () => {
    const p = planPruneBatch([old(1), old(2), young(3), old(4)], 0, CUT, 10);
    assert.deepEqual(p.deleteIds, [1, 2]);
    assert.equal(p.cursor, 2);
    assert.equal(p.done, true);
  });
  it("a short page is the end", () => {
    assert.equal(planPruneBatch([old(7)], 6, CUT, 5000).done, true);
    assert.deepEqual(planPruneBatch([], 6, CUT, 5000), { deleteIds: [], cursor: 6, done: true });
  });
  it("tables without a type column delete everything old", () => {
    assert.deepEqual(planPruneBatch([{ id: 1, createdAt: new Date("2026-01-01") }], 0, CUT, 5).deleteIds, [1]);
  });
});
