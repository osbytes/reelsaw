/**
 * Event subscriptions are a transactional outbox: the job a subscription asks for commits with the
 * event, is rolled back with it, sees the transition's own writes, and a failing `react` rolls the
 * transition back. Postgres only.  node --import tsx --test test/event-subscriptions.test.ts
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { lifecycleHarness } from "./lifecycle-harness.js";
import { createEventSubscriptions } from "../src/event-handlers.js";
import { createUnitOfWork } from "../src/uow.js";
import { schema } from "../src/db/index.js";
import { COMPLETION_NOTIFY_QUEUE } from "../src/queue/boss.js";

const h = lifecycleHarness();
const notReady = await h.ready();
after(() => h.cleanup());

const subs = createEventSubscriptions();
let failNext = false;
subs.add({
  name: "test reaction",
  on: "project.done",
  async react(e, db) {
    const [p] = await db.select({ title: schema.projects.title }).from(schema.projects).where(eq(schema.projects.id, e.projectId));
    // singletonKey = the project, so the harness cleanup removes the job
    return { queue: COMPLETION_NOTIFY_QUEUE, data: { userId: "nobody", title: p?.title }, singletonKey: e.projectId, startAfter: 3600 };
  },
});
// registered second: when it fails, the job the first one already wrote must roll back too
subs.add({
  name: "failing reaction",
  on: "project.done",
  react() {
    if (failNext) throw new Error("react failed");
    return null;
  },
});
const tx = createUnitOfWork(h.pool, h.svc.queue, h.svc.log, undefined, undefined, undefined, subs);

async function jobData(projectId: string): Promise<Array<{ title?: string }>> {
  const r = await h.pool.query(`select data from pgboss.job where name = $1 and singleton_key = $2`, [COMPLETION_NOTIFY_QUEUE, projectId]);
  return r.rows.map((x) => x.data);
}

describe("event subscriptions", { skip: notReady ?? false }, () => {
  it("writes the job with the event, after the transition's own writes", async () => {
    const p = await h.makeProject(await h.makeUser(), "rendering");
    await tx(async (u) => {
      await u.emit(p, "project.done", {});
      await u.db.update(schema.projects).set({ title: "renamed later in the transition" }).where(eq(schema.projects.id, p));
    });
    assert.equal(await h.eventCount(p, "project.done"), 1);
    assert.deepEqual((await jobData(p)).map((d) => d.title), ["renamed later in the transition"]);
  });

  it("leaves no job when the transition rolls back", async () => {
    const p = await h.makeProject(await h.makeUser(), "rendering");
    await assert.rejects(tx(async (u) => {
      await u.emit(p, "project.done", {});
      throw new Error("transition failed");
    }));
    assert.equal(await h.eventCount(p, "project.done"), 0);
    assert.equal((await jobData(p)).length, 0);
  });

  it("leaves no job when COMMIT itself fails, after the reactions were written", async () => {
    // a deferred constraint fails at COMMIT, after the uow wrote the jobs: a job sent outside the transaction would survive
    await h.pool.query(`create table if not exists test_outbox_defer (id int primary key, ref int not null, constraint test_outbox_defer_ref foreign key (ref) references test_outbox_defer (id) deferrable initially deferred)`);
    try {
      const p = await h.makeProject(await h.makeUser(), "rendering");
      await assert.rejects(tx(async (u) => {
        await u.emit(p, "project.done", {});
        await u.db.execute(sql`insert into test_outbox_defer (id, ref) values (1, 999)`);
      }));
      assert.equal(await h.eventCount(p, "project.done"), 0);
      assert.equal((await jobData(p)).length, 0);
    } finally {
      await h.pool.query(`drop table if exists test_outbox_defer`);
    }
  });

  it("rolls the transition and earlier reactions' jobs back when a reaction fails", async () => {
    const p = await h.makeProject(await h.makeUser(), "rendering");
    failNext = true;
    try {
      await assert.rejects(tx(async (u) => {
        await u.emit(p, "project.done", {});
      }), /react failed/);
    } finally {
      failNext = false;
    }
    assert.equal(await h.eventCount(p, "project.done"), 0);
    assert.equal((await jobData(p)).length, 0);
  });
});
