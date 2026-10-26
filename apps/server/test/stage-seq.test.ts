/**
 * Stage versions: projects.stage_seq is bumped by a retry, re-analyze or delete, every stage job carries the value it
 * was queued under, and a job whose value is no longer current can neither start, commit its results (clips, the next
 * stage's job), nor mark the newer run failed. Postgres only.
 * node --import tsx --test test/stage-seq.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lifecycleHarness } from "./lifecycle-harness.js";
import { schema } from "../src/db/index.js";
import { StageContext, StaleJobError, failProject } from "../src/pipeline/common.js";
import { supersedeStages } from "../src/pipeline/lifecycle.js";
import { retryProject, deleteProject, reanalyzeProject } from "../src/projects/service.js";
import { reconcile } from "../src/queue/reconcile.js";
import { QUEUES } from "../src/queue/boss.js";

const h = lifecycleHarness();
const notReady = await h.ready();

describe("stage versions", { skip: notReady ?? false }, () => {
  let userId: string;
  before(async () => {
    userId = await h.makeUser();
  });
  after(() => h.cleanup());

  const project = async (id: string) => (await h.pool.query(`select status, stage_seq, error from projects where id = $1`, [id])).rows[0];
  const clipCount = async (id: string) => (await h.pool.query(`select count(*)::int as n from clips where project_id = $1`, [id])).rows[0].n;
  const jobData = async (id: string) => (await h.pool.query(`select name, data from pgboss.job where singleton_key = $1 and state in ('created','retry','active') order by created_on`, [id])).rows;
  const ctxFor = (id: string, seq: number | undefined) => StageContext.open(h.svc, id, "analyze", new AbortController().signal, {}, seq);
  // what analyze's hand-off writes: a clip and its render job
  const handoff = (id: string) => async (u: Parameters<Parameters<typeof h.tx>[0]>[0]) => {
    const clipId = `c-${randomUUID().slice(0, 8)}`;
    h.mine.add(clipId);
    await u.db.insert(schema.clips).values({ id: clipId, projectId: id, index: 0, title: "t", hook: "h", startSec: 0, endSec: 10, score: 1, reasoning: "r", hashtags: [], status: "pending" });
    await u.enqueue(QUEUES.render, { projectId: id, clipId, gen: 0 });
  };

  it("a job queued before a supersede commits nothing: no clips, no render job, StaleJobError", async () => {
    const id = await h.makeProject(userId, "analyzing");
    const ctx = await ctxFor(id, 0);
    await h.tx((u) => supersedeStages(u, id)); // a re-analyze while this one was still picking
    await assert.rejects(ctx.complete({}, handoff(id)), StaleJobError);
    assert.equal(await clipCount(id), 0);
    assert.equal(await h.eventCount(id, "stage.completed"), 0);
  });

  it("the current job commits its results", async () => {
    const id = await h.makeProject(userId, "analyzing");
    const ctx = await ctxFor(id, 0);
    await ctx.complete({}, handoff(id));
    assert.equal(await clipCount(id), 1);
    assert.equal(await h.eventCount(id, "stage.completed"), 1);
  });

  it("a job of a deleted project commits nothing, and cannot start", async () => {
    const id = await h.makeProject(userId, "analyzing");
    const ctx = await ctxFor(id, 0);
    await h.tx((u) => deleteProject(h.svc, u, id));
    await assert.rejects(ctx.complete({}, handoff(id)), StaleJobError);
    await assert.rejects(ctx.start("analyzing"), StaleJobError);
    assert.equal(await clipCount(id), 0);
    assert.equal((await project(id)).status, "failed", "stopped by the delete, not moved on by the stale job");
  });

  it("a stale job that gives up does not mark the newer run failed; the current one does", async () => {
    const id = await h.makeProject(userId, "analyzing");
    await h.tx((u) => supersedeStages(u, id));
    await failProject(h.svc, id, "analyze", new Error("old job broke"), 0);
    assert.equal((await project(id)).status, "analyzing");
    assert.equal(await h.eventCount(id, "project.failed"), 0);
    await failProject(h.svc, id, "analyze", new Error("current job broke"), 1);
    assert.equal((await project(id)).status, "failed");
  });

  it("a retry bumps the version and the job it queues carries the new one", async () => {
    const id = await h.makeProject(userId, "failed");
    const old = await ctxFor(id, 0);
    await h.tx((u) => retryProject(h.svc, u, id));
    assert.equal((await project(id)).stage_seq, 1);
    const jobs = await jobData(id);
    assert.deepEqual(jobs.map((j) => [j.name, j.data.seq]), [[QUEUES.ingest, 1]]);
    await assert.rejects(old.start("ingesting"), StaleJobError, "the job from before the retry can't take the project back");
  });

  it("re-analyze clicked twice while analyze runs: only the newest job's picks can land", async () => {
    const id = await h.makeProject(userId, "analyzing");
    await h.pool.query(`insert into transcripts (project_id, text, words, segments) values ($1, '', '[]', '[]')`, [id]);
    const running = await ctxFor(id, 0);
    await reanalyzeProject(h.svc, null, id);
    await reanalyzeProject(h.svc, null, id);
    const jobs = await jobData(id);
    assert.deepEqual(jobs.map((j) => [j.name, j.data.seq]), [[QUEUES.analyze, 2]], "one live analyze job, for the newest version");
    await assert.rejects(running.complete({}, handoff(id)), StaleJobError);
    const newest = await ctxFor(id, jobs[0]!.data.seq);
    await newest.complete({}, handoff(id));
    assert.equal(await clipCount(id), 1);
  });

  it("a job queued before versions existed (no seq) counts as current", async () => {
    const id = await h.makeProject(userId, "analyzing");
    await h.tx((u) => supersedeStages(u, id));
    const ctx = await ctxFor(id, undefined);
    assert.equal(ctx.seq, 1);
    await ctx.complete({}, handoff(id));
    assert.equal(await clipCount(id), 1);
  });

  it("the reconciler re-enqueues with the current version", async () => {
    const id = await h.makeProject(userId, "analyzing");
    await h.tx((u) => supersedeStages(u, id));
    await h.tx((u) => supersedeStages(u, id));
    await reconcile(h.svc);
    assert.deepEqual((await jobData(id)).map((j) => [j.name, j.data.seq]), [[QUEUES.analyze, 2]]);
  });
});
