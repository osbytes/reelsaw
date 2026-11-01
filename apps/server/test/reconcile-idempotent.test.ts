/**
 * The reconciler re-enqueues a stage that lost its job exactly once (pg-boss exclusive queue + singletonKey),
 * and leaves a project that already has a live job alone. Postgres only. Other projects in the database are
 * hidden from it by the harness queue, so a dev database with real work in it is safe.
 * node --import tsx --test test/reconcile-idempotent.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { lifecycleHarness } from "./lifecycle-harness.js";
import { reconcile } from "../src/queue/reconcile.js";
import { QUEUES } from "../src/queue/boss.js";

const h = lifecycleHarness();
const notReady = await h.ready();

describe("reconcile", { skip: notReady ?? false }, () => {
  let userId: string;
  before(async () => {
    userId = await h.makeUser();
  });
  after(() => h.cleanup());

  it("an analyzing project with no live job gets exactly one job, however often the reconciler runs", async () => {
    const orphan = await h.makeProject(userId, "analyzing");
    assert.deepEqual(await h.jobsFor([orphan]), []);

    const first = await reconcile(h.svc);
    assert.equal(first.requeued, 1);
    const second = await reconcile(h.svc);
    assert.equal(second.requeued, 0, "the second pass sees the live job");

    const jobs = await h.jobsFor([orphan]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.name, QUEUES.analyze);
  });

  it("two reconcilers racing still leave one job (singletonKey dedupes)", async () => {
    const orphan = await h.makeProject(userId, "transcribing");
    await Promise.all([reconcile(h.svc), reconcile(h.svc)]);
    const jobs = await h.jobsFor([orphan]);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.name, QUEUES.transcribe);
  });

  it("does not enqueue for a project that already has an active job", async () => {
    const busy = await h.makeProject(userId, "analyzing");
    await h.svc.queue.enqueue(QUEUES.analyze, { projectId: busy });
    await h.pool.query(`update pgboss.job set state = 'active', started_on = now() where singleton_key = $1`, [busy]);

    const r = await reconcile(h.svc);
    assert.equal(r.requeued, 0);
    const jobs = await h.jobsFor([busy]);
    assert.deepEqual(
      jobs.map((j) => j.state),
      ["active"],
    );
  });

  it("a rendering project re-queues a clip without a render job once, at the clip's current generation", async () => {
    const projectId = await h.makeProject(userId, "rendering");
    const clipId = await h.makeClip(projectId, 0, "pending");
    await h.pool.query(`update clips set render_gen = 4 where id = $1`, [clipId]);

    assert.equal((await reconcile(h.svc)).requeued, 1);
    assert.equal((await reconcile(h.svc)).requeued, 0);
    const jobs = await h.pool.query(`select data from pgboss.job where singleton_key = $1`, [clipId]);
    assert.equal(jobs.rowCount, 1);
    assert.equal(jobs.rows[0].data.gen, 4);
    assert.equal(
      (await h.pool.query(`select render_gen from clips where id = $1`, [clipId])).rows[0].render_gen,
      4,
      "reconciling does not bump the generation",
    );
  });

  it("projects that are done, failed or only scheduled are left alone", async () => {
    const ids = [await h.makeProject(userId, "done"), await h.makeProject(userId, "failed")];
    assert.equal((await reconcile(h.svc)).requeued, 0);
    assert.deepEqual(await h.jobsFor(ids), []);
  });
});
