/**
 * Event handlers are a transactional outbox: the job a handler's event queues commits with the event,
 * is rolled back with it, is keyed from the transition's own writes, and a failing `key` rolls the
 * transition back. Opted-in concurrency is the queue's pg-boss policy: a coalescing, one-at-a-time
 * handler keeps one waiting and one running job per key. Postgres only.
 * node --import tsx --test test/event-handlers.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { lifecycleHarness } from "./lifecycle-harness.js";
import { defineEventHandlers, eventHandlerQueues } from "../src/event-handlers.js";
import { createUnitOfWork } from "../src/uow.js";
import { schema } from "../src/db/index.js";

const h = lifecycleHarness();
const notReady = await h.ready();

let failNext = false;
const handle = async () => {};
const map = defineEventHandlers({
  "project.done": {
    testWrites: {
      async key({ event, db }) {
        const [p] = await db.select({ title: schema.projects.title }).from(schema.projects).where(eq(schema.projects.id, event.projectId));
        return `${event.projectId}|${p?.title}`;
      },
      handle,
    },
    // runs second: when it fails, the job the first one asked for must roll back too
    testFailing: {
      key: () => {
        if (failNext) throw new Error("handler failed");
        return null;
      },
      handle,
    },
    testOnce: { key: ({ event }) => `${event.projectId}|once`, coalesce: true, oneAtATime: true, delaySeconds: () => 3600, handle },
  },
});
const tx = createUnitOfWork(h.pool, h.svc.queue, h.svc.log, undefined, undefined, undefined, { handlers: map, deps: () => h.svc });
const done = { clips: 1, failed: 0, runSeq: 1, runReason: "created" };

async function jobs(queue: string, key: string): Promise<Array<{ state: string }>> {
  const r = await h.pool.query(`select state from pgboss.job where name = $1 and singleton_key = $2 order by created_on`, [`event.project.done.${queue}`, key]);
  return r.rows;
}

before(async () => {
  if (notReady) return;
  for (const q of eventHandlerQueues(map)) await h.svc.queue.boss.createQueue(q.name, { policy: q.policy });
});
after(async () => {
  if (!notReady) await h.pool.query(`delete from pgboss.job where name like 'event.project.done.test%'`).catch(() => {});
  await h.cleanup();
});

describe("event handlers", { skip: notReady ?? false }, () => {
  it("writes the job with the event, keyed after the transition's own writes", async () => {
    const p = await h.makeProject(await h.makeUser(), "rendering");
    await tx(async (u) => {
      await u.emit(p, "project.done", done);
      await u.db.update(schema.projects).set({ title: "renamed later" }).where(eq(schema.projects.id, p));
    });
    assert.equal(await h.eventCount(p, "project.done"), 1);
    assert.equal((await jobs("testWrites", `${p}|renamed later`)).length, 1);
    // the payload names its project (filled in by emit), in the row and in the job
    const row = await h.pool.query(`select payload->>'projectId' as id from project_events where project_id = $1`, [p]);
    assert.equal(row.rows[0].id, p);
    const job = await h.pool.query(`select data->'event'->'payload'->>'projectId' as id from pgboss.job where name = 'event.project.done.testWrites' and singleton_key = $1`, [`${p}|renamed later`]);
    assert.equal(job.rows[0].id, p);
  });

  it("leaves no job when the transition rolls back", async () => {
    const p = await h.makeProject(await h.makeUser(), "rendering");
    await assert.rejects(tx(async (u) => {
      await u.emit(p, "project.done", done);
      throw new Error("transition failed");
    }));
    assert.equal(await h.eventCount(p, "project.done"), 0);
    assert.equal((await jobs("testWrites", `${p}|lifecycle test`)).length, 0);
  });

  it("leaves no job when COMMIT itself fails, after the handlers' jobs were written", async () => {
    // a deferred constraint fails at COMMIT, after the uow wrote the jobs: a job sent outside the transaction would survive
    await h.pool.query(`create table if not exists test_outbox_defer (id int primary key, ref int not null, constraint test_outbox_defer_ref foreign key (ref) references test_outbox_defer (id) deferrable initially deferred)`);
    try {
      const p = await h.makeProject(await h.makeUser(), "rendering");
      await assert.rejects(tx(async (u) => {
        await u.emit(p, "project.done", done);
        await u.db.execute(sql`insert into test_outbox_defer (id, ref) values (1, 999)`);
      }));
      assert.equal(await h.eventCount(p, "project.done"), 0);
      assert.equal((await jobs("testWrites", `${p}|lifecycle test`)).length, 0);
    } finally {
      await h.pool.query(`drop table if exists test_outbox_defer`);
    }
  });

  it("rolls the transition and earlier handlers' jobs back when a handler's key fails", async () => {
    const p = await h.makeProject(await h.makeUser(), "rendering");
    failNext = true;
    try {
      await assert.rejects(tx(async (u) => {
        await u.emit(p, "project.done", done);
      }), /handler failed/);
    } finally {
      failNext = false;
    }
    assert.equal(await h.eventCount(p, "project.done"), 0);
    assert.equal((await jobs("testWrites", `${p}|lifecycle test`)).length, 0);
  });

  it("coalesce + oneAtATime keeps one waiting and one running job per key", async () => {
    const p = await h.makeProject(await h.makeUser(), "rendering");
    const key = `${p}|once`;
    const emit = () => tx(async (u) => void (await u.emit(p, "project.done", done)));
    await emit();
    await emit(); // joins the waiting job
    assert.deepEqual((await jobs("testOnce", key)).map((j) => j.state), ["created"]);
    // the waiting job starts: a new event may queue the next one, but only one
    await h.pool.query(`update pgboss.job set state = 'active', started_on = now() where name = 'event.project.done.testOnce' and singleton_key = $1`, [key]);
    await emit();
    await emit();
    assert.deepEqual((await jobs("testOnce", key)).map((j) => j.state), ["active", "created"]);
    // a second running job for the key is refused by the queue itself
    await assert.rejects(h.pool.query(`update pgboss.job set state = 'active' where name = 'event.project.done.testOnce' and singleton_key = $1 and state = 'created'`, [key]));
  });
});
