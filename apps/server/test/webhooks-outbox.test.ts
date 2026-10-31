/**
 * The webhook outbox commits with its event (docs/specs/webhooks.md): a unit that emits and then throws leaves no
 * delivery and no job; a committed one leaves one delivery per enabled endpoint of the owner subscribed to the type.
 * Needs Postgres only (lifecycle-harness.ts).
 * node --import tsx --test test/webhooks-outbox.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { lifecycleHarness } from "./lifecycle-harness.js";

const h = lifecycleHarness();
const notReady = await h.ready();

describe("webhook outbox", { skip: notReady ?? false }, () => {
  let owner: string;
  let other: string;
  let projectId: string;
  const endpoints: string[] = [];
  const deliveryJobs = async (eventId: number) =>
    (
      await h.pool.query(`select j.name, j.state from pgboss.job j join webhook_deliveries d on j.singleton_key = 'delivery:' || d.id where d.event_id = $1`, [
        eventId,
      ])
    ).rows;
  const endpoint = async (userId: string, events: string[], enabled = true) => {
    const id = `whk_t${randomUUID().slice(0, 8)}`;
    endpoints.push(id);
    await h.pool.query(
      `insert into webhook_endpoints (id, user_id, url, events, secret_sealed, enabled) values ($1, $2, 'https://example.test/hook', $3, 'v1:x', $4)`,
      [id, userId, events, enabled],
    );
    return id;
  };

  before(async () => {
    owner = await h.makeUser();
    other = await h.makeUser();
    projectId = await h.makeProject(owner, "done");
  });
  after(async () => {
    // the jobs were made for real; drop them before the running app's worker tries a fake endpoint
    await h.pool.query(
      `delete from pgboss.job where name = 'webhooks.deliver' and singleton_key in (select 'delivery:' || id from webhook_deliveries where endpoint_id = any($1))`,
      [endpoints],
    );
    await h.cleanup();
  });

  it("one delivery and one job per matching endpoint, none for others", async () => {
    const done = await endpoint(owner, ["project.done", "clip.done"]);
    await endpoint(owner, ["clip.failed"]);
    await endpoint(owner, ["project.done"], false);
    await endpoint(other, ["project.done"]);
    const eventId = await h.tx((u) => u.emit(projectId, "project.done", { clips: 0, failed: 0 }));
    const rows = (await h.pool.query(`select endpoint_id, status, type from webhook_deliveries where event_id = $1`, [eventId])).rows;
    assert.deepEqual(rows, [{ endpoint_id: done, status: "pending", type: "project.done" }]);
    const jobs = await deliveryJobs(eventId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].name, "webhooks.deliver");
  });

  it("a unit that emits and then throws leaves no delivery", async () => {
    await endpoint(owner, ["clip.failed"]);
    let eventId = 0;
    await assert.rejects(
      h.tx(async (u) => {
        eventId = await u.emit(projectId, "clip.failed", { clipId: "c-x", error: "x" });
        const inside = (await u.db.execute<{ n: number }>(sql`select count(*)::int as n from webhook_deliveries where event_id = ${eventId}`)).rows[0]!;
        assert.ok(inside.n >= 1, "written inside the unit");
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal((await h.pool.query(`select 1 from webhook_deliveries where event_id = $1`, [eventId])).rowCount, 0);
  });

  it("events that are not subscribable write nothing", async () => {
    const eventId = await h.tx((u) => u.emit(projectId, "project.updated", { changed: ["title"] }));
    assert.equal((await h.pool.query(`select 1 from webhook_deliveries where event_id = $1`, [eventId])).rowCount, 0);
  });
});
