/**
 * Failed-work list filters and bulk retry (lifecycle harness: Postgres + pg-boss, no running workers).
 * node --import tsx --test test/ops-failures.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { lifecycleHarness } from "./lifecycle-harness.js";
import { clipFailureStage, errorSnippet, listFailures, retryFailures } from "../src/ops/failures.js";
import { QUEUES } from "../src/queue/boss.js";

describe("errorSnippet / clipFailureStage", () => {
  it("shortens a long reason and names an empty one", () => {
    assert.equal(errorSnippet(null), "Failed with no reason recorded");
    assert.equal(errorSnippet("disk was full"), "disk was full");
    assert.equal(errorSnippet("x".repeat(200)).length, 120);
    assert.ok(errorSnippet("x".repeat(200)).endsWith("…"));
  });
  it("treats an unprepared user clip as prepare, otherwise render", () => {
    assert.equal(clipFailureStage({ origin: "manual", reasoning: "", scores: null }), "prepare");
    assert.equal(clipFailureStage({ origin: "ai", reasoning: "hook", scores: {} }), "render");
  });
});

const h = lifecycleHarness();
const notReady = await h.ready();

describe("listFailures / retryFailures", { skip: notReady ?? false }, () => {
  let userId: string;
  let email: string;
  before(async () => {
    userId = await h.makeUser();
    email = `${userId}@example.test`;
  });
  after(() => h.cleanup());

  async function failProject(stage: string, error: string, agoMs = 0) {
    const id = await h.makeProject(userId, "failed");
    await h.pool.query(`update projects set stage = $2, error = $3, updated_at = now() - ($4::int * interval '1 millisecond') where id = $1`, [id, stage, error, agoMs]);
    return id;
  }
  async function failClip(projectStatus: string, error: string) {
    const projectId = await h.makeProject(userId, projectStatus);
    const clipId = await h.makeClip(projectId, 0, "failed");
    await h.pool.query(`update clips set error = $2, updated_at = now() where id = $1`, [clipId, error]);
    return { projectId, clipId };
  }

  it("filters by error substring and stage, and skips clips of a failed project", async () => {
    const disk = await failProject("render", "Disk was full; ffmpeg could not write");
    await failProject("ingest", "model down: connection refused");
    const { clipId } = await failClip("done", "encoder missing nvenc");
    const orphaned = await failClip("failed", "also disk"); // parent failed: clip must not appear

    const diskHits = await listFailures(h.svc, { q: "disk" });
    assert.ok(diskHits.items.some((i) => i.id === disk && i.kind === "project"));
    assert.ok(!diskHits.items.some((i) => i.id === orphaned.clipId));

    const renderHits = await listFailures(h.svc, { stage: "render" });
    assert.ok(renderHits.items.some((i) => i.id === disk));
    assert.ok(renderHits.items.some((i) => i.id === clipId && i.kind === "clip"));

    const ingestHits = await listFailures(h.svc, { stage: "ingest" });
    assert.ok(ingestHits.items.every((i) => i.stage === "ingest"));
  });

  it("retries through lifecycle, caps the batch, and writes failures.retried", async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await failProject("ingest", `disk full ${i}`));
    const page = await retryFailures(h.svc, { q: "disk full", stage: "ingest" }, { id: userId, email }, { limit: 2 });
    assert.equal(page.retried, 2);
    assert.ok(page.nextCursor);

    const jobs = await h.jobsFor(ids);
    assert.equal(jobs.filter((j) => j.name === QUEUES.ingest).length, 2);

    const ev = await h.pool.query(`select type, payload from admin_events where type = 'failures.retried' and user_id = $1 order by id desc limit 1`, [userId]);
    assert.equal(ev.rows[0]?.type, "failures.retried");
    assert.equal((ev.rows[0]?.payload as { retried: number }).retried, 2);

    const rest = await retryFailures(h.svc, { q: "disk full", stage: "ingest" }, { id: userId, email });
    assert.equal(rest.retried, 1);
    assert.equal(await h.jobsFor(ids).then((j) => j.filter((x) => x.name === QUEUES.ingest).length), 3);
  });

  it("retries a failed clip on a done project via requestRender", async () => {
    const { projectId, clipId } = await failClip("done", "encoder missing");
    const r = await retryFailures(h.svc, {}, { id: userId, email }, { ids: [{ kind: "clip", id: clipId }] });
    assert.equal(r.retried, 1);
    const jobs = await h.jobsFor([clipId]);
    assert.ok(jobs.some((j) => j.name === QUEUES.render && j.singleton_key === clipId));
    const p = await h.pool.query(`select status from projects where id = $1`, [projectId]);
    assert.equal(p.rows[0].status, "rendering");
  });
});
