/**
 * Report import: timestamps arrive as ISO strings and must become Date for Drizzle's timestamp columns
 * (a re-rendered project carries runStartedAt / stageStartedAt; an edited clip editedAt). No database needed.
 * Run: node --import tsx --test test/report-dates.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ImportError, withDates } from "../src/report/import.js";

describe("withDates", () => {
  it("turns the named ISO strings into dates and leaves null, absent and other keys alone", () => {
    const row = { runStartedAt: "2026-10-24T18:46:10.147Z", stageStartedAt: null, title: "2026-10-24T18:46:10.147Z", settings: { a: 1 } };
    const out = withDates(row, ["runStartedAt", "stageStartedAt", "sourceExpiredAt"]);
    assert.ok(out.runStartedAt instanceof Date);
    assert.equal((out.runStartedAt as unknown as Date).toISOString(), "2026-10-24T18:46:10.147Z");
    assert.equal(out.stageStartedAt, null);
    assert.equal("sourceExpiredAt" in out, false);
    assert.equal(out.title, row.title, "only the named keys change");
    assert.equal(out.settings, row.settings);
    assert.equal(row.runStartedAt, "2026-10-24T18:46:10.147Z", "the input is not mutated");
  });

  it("refuses a string that is not a date", () => {
    assert.throws(() => withDates({ editedAt: "yesterday" }, ["editedAt"]), ImportError);
  });
});
