/**
 * API mutations that touch clips and the project row take locks in the fixed order (transcript → clip → project), so
 * they never deadlock against render completions (clip, then project) committing at the same moment. The procedures
 * run in-process through the real router (this branch's code, not the deployed app) against the local stack's
 * Postgres; a completion is the transaction render.ts commits. Also: the project quota holds under concurrent creates.
 *
 * Needs the local stack's Postgres (TEST_DATABASE_URL), migrated to this branch; the test user is a row it inserts.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { createUnitOfWork } from "../src/uow.js";
import { finalizeProjectIfDone } from "../src/pipeline/lifecycle.js";
import { appRouter } from "../src/trpc/router.js";
import { checkProjectQuota } from "../src/quota.js";
import { schema, type Db } from "../src/db/index.js";
import type { Queue } from "../src/queue/boss.js";
import type { Services } from "../src/services.js";
import type { Config } from "../src/config.js";
import { db } from "./helpers.js";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, trace() {}, child() { return quiet; } } as never;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noQueue = { enqueue: async () => null, cancelLiveJobs: async () => {}, hasLiveJob: async () => false, admission: async () => ({ userId: null, live: 0, userRendersLastHour: 0 }) } as unknown as Queue;

describe("lock order of API mutations against render completions", () => {
  let pool: pg.Pool;
  let userId: string;
  let svc: Services;
  const projects: string[] = [];
  // svc.tx retries a deadlock victim, which would hide a lock-order bug: count the retries and require none
  let retries = 0;
  const txLog = { ...(quiet as object), warn: (_o: unknown, msg: string) => void (/retrying/.test(msg) && retries++) } as never;
  const tx = (fn: Parameters<ReturnType<typeof createUnitOfWork>>[0]) => createUnitOfWork(pool, noQueue, txLog)(fn);
  const api = () =>
    appRouter.createCaller({ svc, who: { user: { id: userId, role: "user" }, blocked: null } as never, req: new Request("http://test.local"), requestId: "test", log: quiet });

  before(async () => {
    pool = db();
    userId = `test-${randomUUID()}`;
    await pool.query(`insert into "user" (id, name, email, approved_at) values ($1, 'Test', $2, now())`, [userId, `${userId}@example.test`]);
    // only what these procedures reach: the unit of work and (after commit) file deletes of superseded renders
    svc = { tx, database: { db: drizzle(pool, { schema }) as unknown as Db, pool }, storage: { delete: async () => {} }, paths: { project: () => "/nonexistent" }, log: quiet } as unknown as Services;
  });
  after(async () => {
    for (const id of projects) await pool.query("delete from projects where id = $1", [id]);
    await pool.query("delete from projects where user_id = $1", [userId]);
    await pool.query(`delete from "user" where id = $1`, [userId]);
    await pool.end();
  });

  /** a rendering project: the first `rendering` clips are still rendering (gen 2), the rest failed */
  async function seed(clips: number, rendering: number) {
    const id = randomUUID();
    projects.push(id);
    await pool.query(`insert into projects (id, user_id, title, source_type, source_url, status, stage, run_seq, settings) values ($1, $2, 'Lock order test', 'url', 'https://example.com/v.mp4', 'rendering', 'render', 1, '{}')`, [id, userId]);
    const ids: string[] = [];
    for (let i = 0; i < clips; i++) {
      const cid = randomUUID();
      ids.push(cid);
      await pool.query(`insert into clips (id, project_id, index, title, hook, start_sec, end_sec, score, reasoning, hashtags, status, render_gen, origin) values ($1, $2, $3, 'c', 'h', 0, 10, 50, 'r', '[]', $4, 2, 'ai')`, [cid, id, i, i < rendering ? "rendering" : "failed"]);
    }
    return { id, ids };
  }

  /** what render.ts commits when a render of generation 2 finishes: only while that generation is current */
  const complete = (projectId: string, clipId: string, index: number) =>
    tx(async (u) => {
      const [cur] = await u.db.select({ gen: schema.clips.renderGen }).from(schema.clips).where(eq(schema.clips.id, clipId)).for("update");
      if (cur?.gen !== 2) return; // superseded by a re-render: the stale job exits
      await u.db.update(schema.clips).set({ status: "done", updatedAt: new Date() }).where(and(eq(schema.clips.id, clipId), eq(schema.clips.renderGen, 2)));
      await u.emit(projectId, "clip.done", { clipId, index });
      await sleep(40); // hold the clip lock while the mutation runs: the window in which a project-first order deadlocks
      await finalizeProjectIfDone(svc, u, projectId);
    });

  const mutations: Array<[string, (projectId: string) => Promise<unknown>]> = [
    ["projects.retry", (id) => api().projects.retry({ id })],
    ["projects.setSourceText", (id) => api().projects.setSourceText({ id, sourceText: "keep" })],
    ["projects.updateStyle", (id) => api().projects.updateStyle({ id, style: { fontScale: 1.1 } as never, rerender: true })],
    ["projects.setBumpers", (id) => api().projects.setBumpers({ id, intro: "none", rerender: true })],
  ];

  for (const [name, call] of mutations) {
    it(`${name} racing render completions: no deadlock, consistent state`, async () => {
      retries = 0;
      for (let round = 0; round < 10; round++) {
        const { id, ids } = await seed(6, 3);
        const completions = ids.slice(0, 3).map((cid, i) => complete(id, cid, i));
        await sleep(10); // the completions hold their clip locks by now
        const results = await Promise.allSettled([call(id), ...completions]);
        const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => String(r.reason));
        assert.deepEqual(failed, [], `round ${round}`);
        const done = await pool.query(`select count(*)::int n from project_events where project_id = $1 and type = 'project.done'`, [id]);
        assert.ok(done.rows[0].n <= 1, `round ${round}: at most one project.done`);
      }
      assert.equal(retries, 0, "no transaction was aborted for a deadlock");
    });
  }

  it("concurrent creates can't pass MAX_PROJECTS_PER_USER", async () => {
    const config = { MAX_PROJECTS_PER_USER: 2, MAX_NEW_PROJECTS_PER_HOUR: 0, MAX_SOURCE_MINUTES_PER_DAY: 0 } as Config;
    const before = (await pool.query("select count(*)::int n from projects where user_id = $1", [userId])).rows[0].n as number;
    config.MAX_PROJECTS_PER_USER = before + 2;
    // what projects.create does in its unit of work: the locked check, then the insert
    const create = () =>
      tx(async (u) => {
        await checkProjectQuota(u.db, config, userId, { lock: true });
        await u.db.insert(schema.projects).values({ id: randomUUID(), userId, title: "Quota test", sourceType: "url", sourceUrl: "https://example.com/v.mp4", settings: {} as never, status: "queued" });
      });
    const results = await Promise.allSettled(Array.from({ length: 8 }, create));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
    const after = (await pool.query("select count(*)::int n from projects where user_id = $1", [userId])).rows[0].n as number;
    assert.equal(after, before + 2);
  });
});
