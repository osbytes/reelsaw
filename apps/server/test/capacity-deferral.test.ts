/**
 * A render refused by its account's capacity goes back to pg-boss through its own API (queue/workers.ts
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

  it("puts the job back through pg-boss without spending an attempt, aged and counted, under the same id", async () => {
    const svc = { database: { pool }, queue: { boss } } as never;
    const id = await boss.send(name, { clipId: "c1" }, { singletonKey: "clip:c1", priority: -2 });
    assert.ok(id);
    for (let deferrals = 1; deferrals <= DEFERRAL_AGING_MAX + 2; deferrals++) {
      await boss.update(name, undefined, { id, startAfter: new Date() }); // skip the backoff
      const [job] = await boss.fetch(name);
      assert.equal(job?.id, id);
      assert.ok(job);
      assert.equal(await deferForCapacity(svc, name, job, deferrals), true);
      const r = await boss.getJobById<{ clipId: string; deferrals?: number }>(name, id);
      assert.ok(r);
      assert.equal(r.state, "created");
      assert.equal(r.retryCount, 0, "no attempt spent");
      assert.equal(r.retryLimit, 2, "the attempts it had left");
      assert.equal(r.singletonKey, "clip:c1");
      assert.deepEqual(r.data, { clipId: "c1", deferrals });
      assert.equal(r.priority, -2 + Math.min(deferrals, DEFERRAL_AGING_MAX), "one point per deferral, capped");
      const wait = (r.startAfter.getTime() - Date.now()) / 1000;
      assert.ok(wait >= 10 && wait <= 75, `back within a minute or so (${wait} s)`);
      // the handler returns after deferring: pg-boss completes what is still active, which this row no longer is
      await boss.complete(name, id);
      assert.equal((await boss.getJobById(name, id))?.state, "created");
    }
  });

  it("a real failure before the wait keeps counting: the attempts left carry over", async () => {
    const svc = { database: { pool }, queue: { boss } } as never;
    const id = await boss.send(name, { clipId: "c2" }, { singletonKey: "clip:c2" });
    assert.ok(id);
    await boss.fetch(name);
    await boss.fail(name, id, { message: "ffmpeg crashed" });
    await boss.update(name, undefined, { id, startAfter: new Date() }); // skip the backoff
    const [job] = await boss.fetch(name);
    assert.equal(job?.retryCount, 1);
    assert.ok(job);
    await deferForCapacity(svc, name, job, 1);
    const r = await boss.getJobById(name, id);
    assert.equal(r?.retryLimit, 1, "two attempts, one spent: one left");
  });

  it("an attempt this worker no longer holds is left alone", async () => {
    const svc = { database: { pool }, queue: { boss } } as never;
    const id = await boss.send(name, { clipId: "c3" });
    assert.ok(id);
    const [job] = await boss.fetch(name);
    assert.ok(job);
    assert.equal(await deferForCapacity(svc, name, { id, retryCount: job.retryCount + 1 }, 1), false, "another attempt's claim");
    assert.equal((await boss.getJobById(name, id))?.state, "active");
  });
});
