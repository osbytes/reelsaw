/**
 * The shared word-timestamp verdict store (ai/word-timestamps.ts dbVerdictStore) against the local stack's Postgres
 * (TEST_DATABASE_URL): verdicts from two processes merge into one row instead of overwriting each other, and
 * `exclusive` lets one process test a model at a time. Uses its own keys and removes them afterwards.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "../src/db/index.js";
import { dbVerdictStore, type WordTimestampVerdict } from "../src/ai/word-timestamps.js";
import { db } from "./helpers.js";

const verdict = (text: string): WordTimestampVerdict => ({ wordLevel: true, segments: 13, text, checkedAt: new Date().toISOString() });

describe("dbVerdictStore", () => {
  let pool: pg.Pool;
  const run = randomUUID().slice(0, 8);
  const keys = [`test-${run}:a`, `test-${run}:b`];

  before(() => {
    pool = db();
  });
  after(async () => {
    await pool.query("update instance_settings set value = value - $1::text - $2::text where key = 'transcription_probes'", keys);
    await pool.end();
  });

  it("merges verdicts written by two processes at once", async () => {
    const one = dbVerdictStore();
    const two = dbVerdictStore();
    one.attach(drizzle(pool, { schema }));
    two.attach(drizzle(pool, { schema }));
    await Promise.all([one.set(keys[0]!, verdict("one")), two.set(keys[1]!, verdict("two"))]);
    const all = await one.all();
    assert.equal(all[keys[0]!]?.text, "one");
    assert.equal(all[keys[1]!]?.text, "two");
    assert.equal((await two.get(keys[0]!))?.text, "one");
  });

  it("runs one test of a model at a time across processes", async () => {
    const one = dbVerdictStore();
    const two = dbVerdictStore();
    one.attach(drizzle(pool, { schema }));
    two.attach(drizzle(pool, { schema }));
    let inside = 0;
    let most = 0;
    const work = async () => {
      inside++;
      most = Math.max(most, inside);
      await new Promise((r) => setTimeout(r, 150));
      inside--;
    };
    await Promise.all([one.exclusive(keys[0]!, work), two.exclusive(keys[0]!, work)]);
    assert.equal(most, 1);
  });
});
