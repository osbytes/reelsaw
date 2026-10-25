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
import type { Services } from "../src/services.js";

const h = lifecycleHarness();
const notReady = await h.ready();
after(() => h.cleanup());

const sent: Array<{ to: string; subject: string; key?: string }> = [];
let failSend = false;
const svc = {
  ...h.svc,
  config: { ...h.svc.config, APP_URL: "https://app.example.test/" },
  email: {
    enabled: true,
    send: async (m: { to: string; subject: string }, o?: { idempotencyKey?: string }) => {
      if (failSend) throw new Error("provider down");
      sent.push({ to: m.to, subject: m.subject, key: o?.idempotencyKey });
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
  await h.pool.query(`insert into project_events (project_id, type, payload, created_at) values ($1, 'project.done', '{"clips":2,"failed":0,"runSeq":1,"runReason":"created"}', now() - interval '${ago}')`, [p]);
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
    const r = await h.pool.query(`select count(*)::int as n from completion_notices where user_id = $1`, [u]);
    assert.equal(r.rows[0].n, 2);
    await deliverCompletionNotice(svc, u);
    assert.equal(sent.length, 1);
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
});
