/**
 * Several clips of one project finish rendering at the same moment (a batch re-render). Each completion is the
 * transaction render.ts commits with: lock the clip, mark it done, emit clip.done, finalizeProjectIfDone. They must
 * not deadlock on the project row, and exactly one of them announces project.done.
 *
 * Needs the local stack's Postgres (TEST_DATABASE_URL) and a running app for sign-up (REELSAW_URL).
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { and, eq } from "drizzle-orm";
import { createUnitOfWork, isRetryableTxError } from "../src/uow.js";
import { finalizeProjectIfDone, lockProjectClips, startRun } from "../src/pipeline/lifecycle.js";
import { schema } from "../src/db/index.js";
import type { Queue } from "../src/queue/boss.js";
import type { Services } from "../src/services.js";
import { db, signUp } from "./helpers.js";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, trace() {}, child() { return quiet; } } as never;
const noQueue = { enqueue: async () => null, cancelLiveJobs: async () => {}, hasLiveJob: async () => false, admission: async () => ({ userId: null, live: 0, userRendersLastHour: 0 }) } as unknown as Queue;
// finalize only touches svc for the after-commit workdir cleanup, which the unit of work logs and swallows
const svc = {} as Services;

describe("render completions in parallel", () => {
  let pool: pg.Pool;
  let userId: string;
  const projects: string[] = [];
  const tx = (fn: Parameters<ReturnType<typeof createUnitOfWork>>[0]) => createUnitOfWork(pool, noQueue, quiet)(fn);

  before(async () => {
    pool = db();
    userId = (await signUp()).userId;
  });
  after(async () => {
    for (const id of projects) await pool.query("delete from projects where id = $1", [id]);
    await pool.end();
  });

  async function seed(clips: number) {
    const id = randomUUID();
    projects.push(id);
    await pool.query(`insert into projects (id, user_id, title, source_type, source_url, status, stage, run_seq, settings) values ($1, $2, 'Deadlock test', 'url', 'https://example.com/v.mp4', 'rendering', 'render', 1, '{}')`, [id, userId]);
    const ids: string[] = [];
    for (let i = 0; i < clips; i++) {
      const cid = randomUUID();
      ids.push(cid);
      await pool.query(`insert into clips (id, project_id, index, title, hook, start_sec, end_sec, score, reasoning, hashtags, status, render_gen) values ($1, $2, $3, 'c', 'h', 0, 10, 50, 'r', '[]', 'rendering', 2)`, [cid, id, i]);
    }
    return { id, ids };
  }

  /** what render.ts commits when a render finishes */
  const complete = (projectId: string, clipId: string, index: number) =>
    tx(async (u) => {
      const [cur] = await u.db.select({ gen: schema.clips.renderGen }).from(schema.clips).where(eq(schema.clips.id, clipId)).for("update");
      assert.equal(cur!.gen, 2);
      await u.db.update(schema.clips).set({ status: "done", outputKey: `k/${clipId}`, updatedAt: new Date() }).where(eq(schema.clips.id, clipId));
      await u.emit(projectId, "clip.done", { clipId, index });
      await finalizeProjectIfDone(svc, u, projectId);
    });

  it("9 completions at once: no deadlock, one project.done", async () => {
    for (let round = 0; round < 15; round++) {
      const { id, ids } = await seed(9);
      const results = await Promise.allSettled(ids.map((cid, i) => complete(id, cid, i)));
      const failed = results.filter((r) => r.status === "rejected");
      assert.deepEqual(failed.map((r) => String((r as PromiseRejectedResult).reason)), [], `round ${round}`);
      const events = await pool.query(`select type from project_events where project_id = $1 and type in ('project.done', 'clip.done')`, [id]);
      assert.equal(events.rows.filter((e) => e.type === "clip.done").length, 9);
      assert.equal(events.rows.filter((e) => e.type === "project.done").length, 1, `round ${round}`);
      const p = await pool.query("select status from projects where id = $1", [id]);
      assert.equal(p.rows[0].status, "done");
    }
  });

  it("completions racing a re-render that locks the clips first end with one consistent state", async () => {
    const { id, ids } = await seed(6);
    // a finished project is re-rendered (clips before the project row) while the last two renders commit
    await pool.query("update clips set status = 'done' where id = any($1) and index < 4", [ids]);
    const rerender = tx(async (u) => {
      await lockProjectClips(u, id);
      await u.db.update(schema.clips).set({ status: "pending", updatedAt: new Date() }).where(and(eq(schema.clips.projectId, id), eq(schema.clips.index, 0)));
      await startRun(u, id, { reason: "rerender", status: "rendering", stage: "render" });
    });
    const results = await Promise.allSettled([rerender, complete(id, ids[4]!, 4), complete(id, ids[5]!, 5)]);
    assert.deepEqual(results.filter((r) => r.status === "rejected"), []);
    const done = await pool.query(`select count(*)::int n from project_events where project_id = $1 and type = 'project.done'`, [id]);
    assert.ok(done.rows[0].n <= 1);
  });

  it("a transaction aborted by a deadlock is run again instead of failing", async () => {
    let calls = 0;
    const out = await tx(async () => {
      if (++calls === 1) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      return "ok";
    });
    assert.equal(out, "ok");
    assert.equal(calls, 2);
    assert.equal(isRetryableTxError({ cause: { cause: { code: "40P01" } } }), true);
    assert.equal(isRetryableTxError(new Error("syntax")), false);
    await assert.rejects(tx(async () => { throw Object.assign(new Error("unique"), { code: "23505" }); }));
  });
});
