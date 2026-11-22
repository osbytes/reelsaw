/**
 * A render refused by its account's capacity goes back to pg-boss as if it had never started (queue/workers.ts
 * `deferForCapacity`): no attempt spent, one more deferral in its data, a capped priority bump, and a backoff. Runs
 * against the local stack's Postgres (TEST_DATABASE_URL) on a throwaway pg-boss queue no worker listens on.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { PgBoss } from "pg-boss";
import { DEFERRAL_AGING_MAX, deferForCapacity, deferralDelaySeconds } from "../src/queue/workers.js";
import { db } from "./helpers.js";

describe("deferralDelaySeconds", () => {
  it("15, 30, then 60 seconds, with jitter of a fifth either way", () => {
    assert.deepEqual(
      [1, 2, 3, 9].map((n) => deferralDelaySeconds(n, () => 0.5)),
      [15, 30, 60, 60],
    );
    assert.equal(
      deferralDelaySeconds(3, () => 0),
      48,
    );
    assert.equal(
      deferralDelaySeconds(3, () => 1),
      72,
    );
  });
});

describe("deferForCapacity (pg-boss)", () => {
  let pool: pg.Pool;
  let boss: PgBoss;
  const name = `test.capacity-${randomUUID().slice(0, 8)}`;
  const row = async (id: string) =>
    (
      await pool.query<{ state: string; retry_count: number; started_on: Date | null; priority: number; data: { deferrals?: number }; wait: number }>(
        "select state, retry_count, started_on, priority, data, extract(epoch from start_after - now())::int as wait from pgboss.job where id = $1",
        [id],
      )
    ).rows[0];

  before(async () => {
    pool = db();
    boss = new PgBoss({ db: { executeSql: (text, values) => pool.query(text, values) }, schema: "pgboss", useListenNotify: false });
    boss.on("error", () => {});
    await boss.start();
    await boss.createQueue(name, { retryLimit: 2, retryDelay: 15, retryBackoff: true });
  });
  after(async () => {
    await boss.deleteQueue(name).catch(() => {});
    await boss.stop({ graceful: false }).catch(() => {});
    await pool.end();
  });

  it("puts the job back without spending an attempt, aged and counted, and pg-boss's completion leaves it", async () => {
    const svc = { database: { pool } } as never;
    const id = await boss.send(name, { clipId: "c1" });
    assert.ok(id);
    for (let deferrals = 1; deferrals <= DEFERRAL_AGING_MAX + 2; deferrals++) {
      await pool.query("update pgboss.job set start_after = now() where id = $1", [id]);
      const [job] = await boss.fetch(name);
      assert.equal(job?.id, id);
      await deferForCapacity(svc, id, deferrals);
      const r = await row(id);
      assert.ok(r);
      assert.equal(r.state, "retry");
      assert.equal(r.started_on, null, "the next fetch does not count an attempt");
      assert.equal(r.retry_count, 0, "no attempt spent");
      assert.equal(r.data.deferrals, deferrals);
      assert.equal(r.priority, Math.min(deferrals, DEFERRAL_AGING_MAX), "one point per deferral, capped");
      assert.ok(r.wait >= 10 && r.wait <= 75, `back within a minute or so (${r.wait} s)`);
      // the handler returns after deferring: pg-boss completes what is still active, which this row no longer is
      await boss.complete(name, id);
      assert.equal((await row(id))?.state, "retry");
    }
  });
});
