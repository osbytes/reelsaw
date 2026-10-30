/**
 * Render generations: every requestRender bumps clips.render_gen, supersedes queued work, and a stale job
 * (older generation) can neither start, commit, nor mark the newer version failed. Postgres only.
 * node --import tsx --test test/render-gen.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { lifecycleHarness } from "./lifecycle-harness.js";
import { schema } from "../src/db/index.js";
import { requestRender } from "../src/pipeline/lifecycle.js";
import { markClipFailed, renderClip } from "../src/pipeline/render.js";
import type { StageContext } from "../src/pipeline/common.js";

const h = lifecycleHarness();
const notReady = await h.ready();

describe("render generations", { skip: notReady ?? false }, () => {
  let projectId: string;
  let clipId: string;
  before(async () => {
    projectId = await h.makeProject(await h.makeUser(), "done", { runSeq: 1 });
    clipId = await h.makeClip(projectId, 0, "done", { outputKey: "projects/x/clips/old.0.mp4" });
  });
  after(() => h.cleanup());

  const clipRow = async () => (await h.pool.query(`select render_gen, status, output_key, thumbnail_key from clips where id = $1`, [clipId])).rows[0];
  const liveJobs = async () =>
    (await h.pool.query(`select data from pgboss.job where singleton_key = $1 and state in ('created','retry','active')`, [clipId])).rows;

  it("requestRender twice bumps render_gen each time and leaves exactly one live job, for the newest generation", async () => {
    const g1 = await h.tx((u) => requestRender(h.svc, u, projectId, clipId));
    assert.equal(g1, 1);
    assert.deepEqual(
      (await liveJobs()).map((j) => j.data.gen),
      [1],
    );

    const g2 = await h.tx((u) => requestRender(h.svc, u, projectId, clipId));
    assert.equal(g2, 2);
    const row = await clipRow();
    assert.equal(row.render_gen, 2);
    assert.equal(row.status, "pending");
    assert.equal(row.output_key, null, "the superseded output is no longer referenced");
    assert.deepEqual(
      (await liveJobs()).map((j) => j.data.gen),
      [2],
      "the generation-1 job was cancelled, not left alongside",
    );
  });

  it("deletes the superseded files after commit, and the project reopens once", async () => {
    assert.deepEqual(h.deletedKeys, ["projects/x/clips/old.0.mp4"]);
    const p = (await h.pool.query(`select status, run_seq from projects where id = $1`, [projectId])).rows[0];
    assert.equal(p.status, "rendering");
    assert.equal(p.run_seq, 2, "one run.started for two requests: the second joined the running run");
    assert.equal(await h.eventCount(projectId, "run.started"), 1);
  });

  it("a rolled-back requestRender changes nothing: no bump, no cancelled job, no deleted file", async () => {
    await assert.rejects(
      h.tx(async (u) => {
        await requestRender(h.svc, u, projectId, clipId);
        throw new Error("boom");
      }),
    );
    assert.equal((await clipRow()).render_gen, 2);
    assert.deepEqual(
      (await liveJobs()).map((j) => j.data.gen),
      [2],
    );
    assert.deepEqual(h.deletedKeys, ["projects/x/clips/old.0.mp4"]);
  });

  it("a stale job exits at the start of renderClip without touching the clip", async () => {
    const ctx = { svc: h.svc, projectId, db: h.svc.database.db, log: h.svc.log, project: async () => ({ id: projectId }) } as unknown as StageContext;
    const before = await clipRow();
    await renderClip(ctx, clipId, 1); // generation 1 was superseded by 2
    assert.deepEqual(await clipRow(), before);
    assert.equal(await h.eventCount(projectId, "clip.rendering"), 0);
  });

  it("a stale render that fails does not mark the newer pending version failed", async () => {
    await markClipFailed(h.svc, projectId, clipId, new Error("old attempt died"), 1);
    assert.equal((await clipRow()).status, "pending");
    assert.equal(await h.eventCount(projectId, "clip.failed"), 0);
  });

  // render.ts commits inside renderClip (needs ffmpeg), so the commit unit is mirrored here statement for statement:
  // lock the row, compare the generation, only then write the output and emit. If render.ts changes that unit,
  // change this too. (Exporting it as `commitRender` would let this call the real thing.)
  async function commit(gen: number, outputKey: string) {
    return h.tx(async (u) => {
      const [cur] = await u.db.select({ gen: schema.clips.renderGen }).from(schema.clips).where(eq(schema.clips.id, clipId)).for("update");
      if (!cur || cur.gen !== gen) return false;
      await u.db
        .update(schema.clips)
        .set({ status: "done", outputKey })
        .where(and(eq(schema.clips.id, clipId), eq(schema.clips.renderGen, gen)));
      await u.emit(projectId, "clip.done", { clipId });
      return true;
    });
  }

  it("a stale generation's commit leaves outputKey alone; the current generation's commit lands", async () => {
    assert.equal(await commit(1, "projects/x/clips/stale.1.mp4"), false);
    let row = await clipRow();
    assert.equal(row.output_key, null);
    assert.equal(row.status, "pending");
    assert.equal(await h.eventCount(projectId, "clip.done"), 0);

    assert.equal(await commit(2, "projects/x/clips/new.2.mp4"), true);
    row = await clipRow();
    assert.equal(row.output_key, "projects/x/clips/new.2.mp4");
    assert.equal(row.status, "done");
    const all = (await h.pool.query(`select output_key, thumbnail_key from clips where project_id = $1`, [projectId])).rows;
    assert.ok(!JSON.stringify(all).includes("stale.1"), "the stale generation's files are referenced nowhere");
  });
});
