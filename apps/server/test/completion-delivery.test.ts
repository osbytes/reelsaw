/**
 * deliverCompletionNotice against Postgres: one note for what finished while the account was away,
 * marked on each project (ready_mailed_through) so a second run sends nothing, nothing for what they have seen,
 * and a failed send records nothing (the retry sends the same batch with the same key).
 * Postgres only.  node --import tsx --test test/completion-delivery.test.ts
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { lifecycleHarness } from "./lifecycle-harness.js";
import { deliverCompletionNotice } from "../src/notify/completion.js";
import { emailPreferences, setEmailPreferences } from "../src/notify/preferences.js";
import { eventHandlerQueues } from "../src/event-handlers.js";
import { eventHandlerMap } from "../src/event-handler-map.js";
import type { Services } from "../src/services.js";

const h = lifecycleHarness();
const notReady = await h.ready();
after(() => h.cleanup());
// the app creates handler queues at boot (createQueue().start()); a fresh test database has none
if (!notReady) for (const q of eventHandlerQueues(eventHandlerMap)) await h.svc.queue.boss.createQueue(q.name, { policy: q.policy });

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
  await h.pool.query(
    `insert into events (project_id, user_id, type, payload, created_at) values ($1, $2, 'project.done', '{"clips":2,"failed":0,"runSeq":1,"runReason":"created"}', now() - interval '${ago}')`,
    [p, userId],
  );
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
    const r = await h.pool.query(`select count(*)::int as n from projects where user_id = $1 and ready_mailed_through is not null`, [u]);
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
    const r = await h.pool.query(`select count(*)::int as n from projects where user_id = $1 and ready_mailed_through is not null`, [u]);
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

  it("refuses a preference for an account that no longer exists, as not found", async () => {
    await assert.rejects(setEmailPreferences(h.svc, "no-such-account", { ready: false }, "unsubscribe_link"), { code: "NOT_FOUND" });
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

  it("mails a re-render's finish after the project's first note: it is above the project's mark", async () => {
    const u = await account(null);
    const p = await finished(u, "30 minutes");
    sent.length = 0;
    await deliverCompletionNotice(svc, u);
    assert.equal(sent.length, 1);
    await h.pool.query(
      `insert into events (project_id, user_id, type, payload) values ($1, $2, 'project.done', '{"clips":3,"failed":0,"runSeq":2,"runReason":"rerender"}')`,
      [p, u],
    );
    await deliverCompletionNotice(svc, u);
    assert.equal(sent.length, 2);
    assert.match(sent[1]!.subject, /new render is ready/);
    await deliverCompletionNotice(svc, u);
    assert.equal(sent.length, 2);
  });

  it("skips what finished before they were last here", async () => {
    const u = await account("5 minutes");
    await finished(u, "30 minutes");
    sent.length = 0;
    await deliverCompletionNotice(svc, u);
    assert.equal(sent.length, 0);
  });

  it("skips what finished before the lookback, and counts a stamp at the same instant as seen", async () => {
    const u = await account(null);
    await finished(u, "8 days");
    sent.length = 0;
    await deliverCompletionNotice(svc, u);
    assert.equal(sent.length, 0);
    const v = await account(null);
    await finished(v, "10 minutes");
    await h.pool.query(
      `update "user" u set last_active_at = e.created_at from events e join projects p on p.id = e.project_id where u.id = $1 and p.user_id = $1`,
      [v],
    );
    await deliverCompletionNotice(svc, v);
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
    const r = await h.pool.query(`select count(*)::int as n from projects where user_id = $1 and ready_mailed_through is not null`, [u]);
    assert.equal(r.rows[0].n, 0);
    await deliverCompletionNotice(svc, u);
    assert.equal(sent.length, 1);
  });

  it("covers a big batch in one note: the first projects listed, the rest counted, every one marked mailed", async () => {
    // one project finished and seen before they left, so this is not their first note
    const u = await account("2 hours");
    await finished(u, "3 hours");
    for (let i = 0; i < 41; i++) await finished(u, `${50 - i} minutes`);
    sent.length = 0;
    await deliverCompletionNotice(svc, u);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.subject, /41 projects are ready/);
    assert.match(sent[0]!.text ?? "", /And 33 more/);
    const marked = await h.pool.query(`select count(*)::int as n from projects where user_id = $1 and ready_mailed_through is not null`, [u]);
    assert.equal(marked.rows[0].n, 41); // the one seen before they left is not in the note
    await deliverCompletionNotice(svc, u);
    assert.equal(sent.length, 1);
  });
});
