/**
 * Reopening a finished project. There is no `reopenProject` function in lifecycle.ts: the one place an idle
 * project starts working again is `startRun`, a conditional update (`status in ('done','failed')`), which
 * requestRender/requestRenders call. These tests pin its exactly-once contract. Postgres only.
 * node --import tsx --test test/reopen-transitions.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { lifecycleHarness } from "./lifecycle-harness.js";
import { requestRender, requestRenders, startRun } from "../src/pipeline/lifecycle.js";

const h = lifecycleHarness();
const notReady = await h.ready();

describe("startRun / reopening a project", { skip: notReady ?? false }, () => {
  let userId: string;
  before(async () => {
    userId = await h.makeUser();
  });
  after(() => h.cleanup());

  const row = async (id: string) => (await h.pool.query(`select status, stage, run_seq, run_reason, error from projects where id = $1`, [id])).rows[0];

  it("from done it moves to rendering, bumps run_seq and emits run.started once", async () => {
    const id = await h.makeProject(userId, "done", { runSeq: 3 });
    const seq = await h.tx((u) => startRun(u, id, { reason: "rerender", status: "rendering", stage: "render" }));
    assert.equal(seq, 4);
    assert.deepEqual(await row(id), { status: "rendering", stage: "render", run_seq: 4, run_reason: "rerender", error: null });
    assert.equal(await h.eventCount(id, "run.started"), 1);
  });

  it("from failed it reopens too (a retry), clearing the error", async () => {
    const id = await h.makeProject(userId, "failed", { runSeq: 1 });
    await h.pool.query(`update projects set error = 'boom' where id = $1`, [id]);
    assert.equal(await h.tx((u) => startRun(u, id, { reason: "retry", status: "ingesting", stage: "ingest" })), 2);
    assert.deepEqual(await row(id), { status: "ingesting", stage: "ingest", run_seq: 2, run_reason: "retry", error: null });
  });

  it("a project already running joins the current run: null, no bump, no event", async () => {
    const id = await h.makeProject(userId, "rendering", { runSeq: 2 });
    assert.equal(await h.tx((u) => startRun(u, id, { reason: "rerender", status: "rendering", stage: "render" })), null);
    assert.equal((await row(id)).run_seq, 2);
    assert.equal(await h.eventCount(id, "run.started"), 0);
  });

  it("called concurrently from two transactions, it emits once", async () => {
    for (let round = 0; round < 5; round++) {
      const id = await h.makeProject(userId, "done", { runSeq: 1 });
      const results = await Promise.all([
        h.tx((u) => startRun(u, id, { reason: "rerender", status: "rendering", stage: "render" })),
        h.tx((u) => startRun(u, id, { reason: "rerender", status: "rendering", stage: "render" })),
      ]);
      assert.deepEqual(
        results.filter((r) => r !== null),
        [2],
        `round ${round}: exactly one winner`,
      );
      assert.equal((await row(id)).run_seq, 2);
      assert.equal(await h.eventCount(id, "run.started"), 1, `round ${round}`);
    }
  });

  it("a rolled-back reopen leaves the project done and emits nothing", async () => {
    const id = await h.makeProject(userId, "done", { runSeq: 1 });
    await assert.rejects(
      h.tx(async (u) => {
        await startRun(u, id, { reason: "rerender", status: "rendering", stage: "render" });
        throw new Error("boom");
      }),
    );
    assert.equal((await row(id)).status, "done");
    assert.equal(await h.eventCount(id, "run.started"), 0);
  });

  it("re-rendering several clips at once from two requests starts one run and queues each clip once", async () => {
    const id = await h.makeProject(userId, "done", { runSeq: 1 });
    const clips = [await h.makeClip(id, 0, "done"), await h.makeClip(id, 1, "done"), await h.makeClip(id, 2, "done")];
    const results = await Promise.all([h.tx((u) => requestRenders(h.svc, u, id, clips)), h.tx((u) => requestRenders(h.svc, u, id, clips))]);
    // the second batch finds its clips already pending (it waited on their locks), so it skips them
    assert.equal(
      results.reduce((n, r) => n + r.rerendered, 0),
      3,
    );
    assert.equal(await h.eventCount(id, "run.started"), 1);
    assert.equal((await row(id)).status, "rendering");
    const jobs = await h.jobsFor(clips);
    assert.equal(jobs.length, 3);
  });

  it("requestRender on a done project reopens it once even when two clips are edited concurrently", async () => {
    const id = await h.makeProject(userId, "done", { runSeq: 1 });
    const [a, b] = [await h.makeClip(id, 0, "done"), await h.makeClip(id, 1, "done")];
    await Promise.all([h.tx((u) => requestRender(h.svc, u, id, a)), h.tx((u) => requestRender(h.svc, u, id, b))]);
    assert.equal(await h.eventCount(id, "run.started"), 1);
    assert.equal((await row(id)).run_seq, 2);
  });
});
