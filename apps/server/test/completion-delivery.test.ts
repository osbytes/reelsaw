/**
 * deliverCompletionNotice against Postgres: one note for what finished while the account was away,
 * recorded in completion_notices so a second run sends nothing, nothing for what they have seen,
 * and a failed send records nothing (the retry sends the same batch with the same key).
 * Postgres only.  node --import tsx --test test/completion-delivery.test.ts
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { lifecycleHarness } from "./lifecycle-harness.js";
import { deliverCompletionNotice } from "../src/notify/completion.js";
import { emailPreferences, setEmailPreferences } from "../src/notify/preferences.js";
import { eventHandlerQueues } from "../src/event-handlers.js";
import { projectEventHandlers } from "../src/project-event-handlers.js";
import type { Services } from "../src/services.js";
import type { UnitOfWork } from "../src/uow.js";

const QUEUE = "event.project.done.readyEmail";

const h = lifecycleHarness();
const notReady = await h.ready();
after(() => h.cleanup());
// the app creates handler queues at boot (createQueue().start()); a fresh test database has none
if (!notReady) for (const q of eventHandlerQueues(projectEventHandlers)) await h.svc.queue.boss.createQueue(q.name, { policy: q.policy });

const sent: Array<{ to: string; subject: string; text?: string; key?: string; headers?: Record<string, string> }> = [];
let failSend = false;
const svc = {
  ...h.svc,
  config: { ...h.svc.config, APP_URL: "https://app.example.test/", BETTER_AUTH_SECRET: "test-secret-at-least-sixteen" },
  email: {
    enabled: true,
    send: async (m: { to: string; subject: string; text: string; headers?: Record<string, string> }, o?: { idempotencyKey?: string }) => {
      if (failSend) throw new Error("provider down");
      sent.push({ to: m.to, subject: m.subject, text: m.text, key: o?.idempotencyKey, headers: m.headers });
    },
  },
} as unknown as Services;

async function account(lastActive: string | null): Promise<string> {
  const id = await h.makeUser();
  await h.pool.query(`update "user" set approved_at = now(), last_active_at = ${lastActive ? `now() - interval '${lastActive}'` : "null"} where id = $1`, [id]);
  return id;
}
async function finished(userId: string, ago: string): Promise<string> {
  const p = await h.makeProject(userId, "done");
  const e = await h.pool.query(
    `insert into project_events (project_id, type, payload, created_at) values ($1, 'project.done', '{"clips":2,"failed":0,"runSeq":1,"runReason":"created"}', now() - interval '${ago}') returning id`,
    [p],
  );
  // what finalizeProjectIfDone writes with the first finish
  await h.pool.query(`insert into finished_projects (project_id, user_id, first_event_id) values ($1, $2, $3) on conflict do nothing`, [
    p,
    userId,
    e.rows[0].id,
  ]);
  return p;
}

describe("deliverCompletionNotice", { skip: notReady ?? false }, () => {
  it("sends one note for everything finished since they left, then nothing", async () => {
    const u = await account("2 hours");
    await finished(u, "30 minutes");
    await finished(u, "20 minutes");
    sent.length = 0;
    await deliverCompletionNotice(svc, u);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, `${u}@example.test`);
    assert.match(sent[0]!.key ?? "", /^ready-[0-9a-f]{40}$/);
    assert.match(sent[0]!.headers?.["List-Unsubscribe"] ?? "", /^<https:\/\/app\.example\.test\/api\/email\/unsubscribe\?u=/);
    const r = await h.pool.query(`select count(*)::int as n from completion_notices where user_id = $1`, [u]);
    assert.equal(r.rows[0].n, 2);
    await deliverCompletionNotice(svc, u);
    assert.equal(sent.length, 1);
  });

  it("sends nothing to an account that turned the note off, and keeps the batch for when it is back on", async () => {
    const u = await account(null);
    await finished(u, "10 minutes");
    await setEmailPreferences(h.svc, u, { ready: false }, "settings");
    sent.length = 0;
    await deliverCompletionNotice(svc, u);
    assert.equal(sent.length, 0);
    const r = await h.pool.query(`select count(*)::int as n from completion_notices where user_id = $1`, [u]);
    assert.equal(r.rows[0].n, 0);
  });

  it("follows the topic's default until the account chooses, and records where the choice was made", async () => {
    const u = await account(null);
    assert.deepEqual(await emailPreferences(h.svc.database.db, u), { ready: true });
    assert.equal((await h.pool.query(`select count(*)::int as n from email_topic_prefs where user_id = $1`, [u])).rows[0].n, 0);
    await setEmailPreferences(h.svc, u, { ready: false }, "unsubscribe_link");
    await setEmailPreferences(h.svc, u, {}, "settings");
    assert.deepEqual(await emailPreferences(h.svc.database.db, u), { ready: false });
    const r = await h.pool.query(`select topic, enabled, source from email_topic_prefs where user_id = $1`, [u]);
    assert.deepEqual(r.rows, [{ topic: "ready", enabled: false, source: "unsubscribe_link" }]);
    await setEmailPreferences(h.svc, u, { ready: true }, "mcp");
    const back = await h.pool.query(`select enabled, source from email_topic_prefs where user_id = $1`, [u]);
    assert.deepEqual(back.rows, [{ enabled: true, source: "mcp" }]);
  });

  it("announces the 10th project once, even after an earlier project is deleted forever", async () => {
    const u = await account("1 hour");
    const old: string[] = [];
    for (let i = 0; i < 9; i++) old.push(await finished(u, `${2 + i} hours`)); // seen: before they were last here
    await finished(u, "10 minutes");
    sent.length = 0;
    await deliverCompletionNotice(svc, u);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text ?? "", /That's 10 projects finished/);
    // a purge drops the project and its events; the ledger keeps the count at 10, so the 11th is no milestone
    await h.pool.query(`delete from projects where id = $1`, [old[0]]);
    await finished(u, "5 minutes");
    await deliverCompletionNotice(svc, u);
    assert.equal(sent.length, 2);
    assert.doesNotMatch(sent[1]!.text ?? "", /projects finished/);
  });

  it("skips what finished before they were last here", async () => {
    const u = await account("5 minutes");
    await finished(u, "30 minutes");
    sent.length = 0;
    await deliverCompletionNotice(svc, u);
    assert.equal(sent.length, 0);
  });

  it("records nothing when the send fails, so the retry sends the same batch with the same key", async () => {
    const u = await account(null);
    await finished(u, "10 minutes");
    sent.length = 0;
    failSend = true;
    try {
      await assert.rejects(deliverCompletionNotice(svc, u), /provider down/);
    } finally {
      failSend = false;
    }
    const r = await h.pool.query(`select count(*)::int as n from completion_notices where user_id = $1`, [u]);
    assert.equal(r.rows[0].n, 0);
    await deliverCompletionNotice(svc, u);
    assert.equal(sent.length, 1);
  });

  it("records a batch cut short and queues its follow-up together, or neither", async () => {
    const u = await account(null);
    for (let i = 0; i < 41; i++) await finished(u, `${50 - i} minutes`);
    const recorded = async () => (await h.pool.query(`select count(*)::int as n from completion_notices where user_id = $1`, [u])).rows[0].n;
    const followUps = async () =>
      (await h.pool.query(`select count(*)::int as n from pgboss.job where name = $1 and singleton_key = $2`, [QUEUE, u])).rows[0].n;
    const again = (u2: UnitOfWork) => u2.send(QUEUE, { key: u }, { singletonKey: u, startAfterSeconds: 3600 });
    try {
      // the follow-up fails: the record rolls back with it, so the retry sends this batch again (same key)
      await assert.rejects(
        deliverCompletionNotice(svc, u, async () => {
          throw new Error("queue down");
        }),
        /queue down/,
      );
      assert.equal(await recorded(), 0);
      assert.equal(await followUps(), 0);
      await deliverCompletionNotice(svc, u, again);
      assert.equal(await recorded(), 40);
      assert.equal(await followUps(), 1);
    } finally {
      await h.pool.query(`delete from pgboss.job where name = $1 and singleton_key = $2`, [QUEUE, u]);
    }
  });
});
