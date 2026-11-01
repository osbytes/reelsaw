/**
 * svc.tx is atomic: rows, events and pg-boss jobs commit together or not at all; afterCommit and NOTIFY only fire
 * for a committed unit. Needs Postgres only (lifecycle-harness.ts).
 * node --import tsx --test test/uow-atomic.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { lifecycleHarness } from "./lifecycle-harness.js";
import { dotenv } from "./helpers.js";
import { schema } from "../src/db/index.js";
import { EVENTS_CHANNEL } from "../src/events.js";
import { QUEUES } from "../src/queue/boss.js";

const h = lifecycleHarness();
const notReady = await h.ready();

describe("unit of work", { skip: notReady ?? false }, () => {
  let projectId: string;
  before(async () => {
    projectId = await h.makeProject(await h.makeUser(), "done");
  });
  after(() => h.cleanup());

  it("a unit that writes, emits and enqueues, then throws, persists none of the three", async () => {
    const clipId = `c-rollback-${Date.now()}`;
    h.mine.add(clipId);
    await assert.rejects(
      h.tx(async (u) => {
        await u.db
          .insert(schema.clips)
          .values({ id: clipId, projectId, index: 0, title: "t", hook: "h", startSec: 0, endSec: 1, score: 1, reasoning: "r", hashtags: [] });
        await u.emit(projectId, "clip.done", { clipId });
        const jobId = await u.enqueue(QUEUES.render, { projectId, clipId, gen: 1 });
        assert.ok(jobId, "the job was created inside the unit");
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal((await h.pool.query(`select 1 from clips where id = $1`, [clipId])).rowCount, 0, "row rolled back");
    assert.equal(await h.eventCount(projectId, "clip.done"), 0, "event rolled back");
    assert.deepEqual(await h.jobsFor([clipId]), [], "pgboss job rolled back");
  });

  it("a committed unit persists the row, the event and the job together", async () => {
    const clipId = `c-commit-${Date.now()}`;
    h.mine.add(clipId);
    await h.tx(async (u) => {
      await u.db
        .insert(schema.clips)
        .values({ id: clipId, projectId, index: 1, title: "t", hook: "h", startSec: 0, endSec: 1, score: 1, reasoning: "r", hashtags: [] });
      await u.emit(projectId, "clip.done", { clipId });
      await u.enqueue(QUEUES.render, { projectId, clipId, gen: 1 });
    });
    assert.equal((await h.pool.query(`select 1 from clips where id = $1`, [clipId])).rowCount, 1);
    assert.equal(await h.eventCount(projectId, "clip.done"), 1);
    assert.equal((await h.jobsFor([clipId])).length, 1);
  });

  it("afterCommit runs after a successful commit and never on rollback", async () => {
    const calls: string[] = [];
    await h.tx(async (u) => {
      u.afterCommit(() => void calls.push("committed"));
    });
    assert.deepEqual(calls, ["committed"]);

    await assert.rejects(
      h.tx(async (u) => {
        u.afterCommit(() => void calls.push("rolled-back"));
        throw new Error("boom");
      }),
    );
    assert.deepEqual(calls, ["committed"], "rollback ran nothing");
  });

  it("afterCommit sees the committed data, and a throwing callback does not fail the unit", async () => {
    let seen = 0;
    const r = await h.tx(async (u) => {
      await u.emit(projectId, "clip.done", { marker: "after" });
      u.afterCommit(async () => {
        seen = await h.eventCount(projectId, "clip.done");
      });
      u.afterCommit(() => {
        throw new Error("cleanup failed");
      });
      return "ok";
    });
    assert.equal(r, "ok");
    assert.ok(seen >= 1, "the callback read the committed event");
  });

  it("NOTIFY arrives only after commit, when the event row is already readable", async () => {
    const pw = dotenv().POSTGRES_PASSWORD ?? "reelsaw";
    const listener = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL ?? `postgres://reelsaw:${pw}@127.0.0.1:5432/reelsaw` });
    await listener.connect();
    try {
      await listener.query(`LISTEN ${EVENTS_CHANNEL}`);
      const got: Array<{ id: number; projectId: string }> = [];
      listener.on("notification", (m) => {
        const p = JSON.parse(m.payload ?? "{}");
        if (p.projectId === projectId) got.push(p);
      });
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

      // rolled back: no notification, ever
      await assert.rejects(
        h.tx(async (u) => {
          await u.emit(projectId, "clip.done", {});
          throw new Error("boom");
        }),
      );
      await sleep(300);
      assert.equal(got.length, 0, "no NOTIFY for a rolled-back unit");

      // committed: not delivered while the unit is still open, delivered after, and the row is readable at that point
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let emitted = 0;
      const open = h.tx(async (u) => {
        emitted = await u.emit(projectId, "clip.done", {});
        await gate;
      });
      await sleep(300);
      assert.equal(got.length, 0, "no NOTIFY while the unit is open");
      release();
      await open;
      for (const end = Date.now() + 3000; Date.now() < end && !got.length; ) await sleep(25);
      assert.equal(got.length, 1);
      assert.equal(got[0]!.id, emitted);
      const row = await h.pool.query(`select 1 from project_events where id = $1`, [got[0]!.id]);
      assert.equal(row.rowCount, 1, "the event row is readable when the notification fires");
    } finally {
      await listener.end();
    }
  });
});
