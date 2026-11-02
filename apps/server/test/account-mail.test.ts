/**
 * Mail that follows an event (notify/account.ts) against Postgres: the event and its handler's
 * job commit together or not at all, and the handler mails the account as it is when the job runs.
 * Postgres only.  node --import tsx --test test/account-mail.test.ts
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { lifecycleHarness } from "./lifecycle-harness.js";
import { approveUser } from "../src/accounts.js";
import { eventHandlerQueue, eventHandlerQueues, parseEventHandlerJob, type AnyEventType } from "../src/event-handlers.js";
import { eventHandlerMap } from "../src/event-handler-map.js";
import { createLogger } from "../src/log.js";
import { createUnitOfWork } from "../src/uow.js";
import type { Services } from "../src/services.js";

const h = lifecycleHarness();
const notReady = await h.ready();
after(() => h.cleanup());
if (!notReady) for (const q of eventHandlerQueues(eventHandlerMap)) await h.svc.queue.boss.createQueue(q.name, { policy: q.policy });

const sent: Array<{ to: string; subject: string; text: string; key?: string }> = [];
const email = {
  enabled: true,
  send: async (m: { to: string; subject: string; text: string }, o?: { idempotencyKey?: string }) =>
    void sent.push({ to: m.to, subject: m.subject, text: m.text, key: o?.idempotencyKey }),
};
const svc = {
  ...h.svc,
  email,
  telemetry: { capture() {} },
  config: { ...h.svc.config, APP_URL: "https://app.example.test" },
} as unknown as Services;
svc.tx = createUnitOfWork(h.pool, h.svc.queue, createLogger({ LOG_LEVEL: "fatal", LOG_FORMAT: "json" }), undefined, undefined, undefined, {
  handlers: [eventHandlerMap],
  deps: () => svc,
});

const handlerOf = (type: AnyEventType) => {
  const [q] = eventHandlerQueues(eventHandlerMap).filter((x) => x.type === type);
  assert.ok(q, `a handler on ${type}`);
  return q;
};

/** The jobs queued for this account's `type` events, parked an hour out so a running app's worker leaves them alone. */
async function jobs(type: AnyEventType, userId: string) {
  const q = handlerOf(type);
  const r = await h.pool.query(
    `update pgboss.job set start_after = now() + interval '1 hour' where name = $1 and data->'event'->>'userId' = $2 returning id, data`,
    [q.name, userId],
  );
  return r.rows;
}

/** Run a queued job the way the worker does. */
async function run(type: AnyEventType, data: unknown) {
  const q = handlerOf(type);
  const { event, key } = parseEventHandlerJob(type, data);
  await q.def.handle({ event, key, svc, signal: new AbortController().signal, idempotencyKey: `${q.name}:${event.id}`, again: async () => null });
}

const made: string[] = [];
async function account(over: { approved?: boolean; role?: string } = {}): Promise<string> {
  const id = await h.makeUser();
  made.push(id);
  await h.pool.query(`update "user" set approved_at = ${over.approved === false ? "null" : "now()"}, role = $2 where id = $1`, [id, over.role ?? "user"]);
  return id;
}

describe("account mail", { skip: notReady ?? false }, () => {
  after(async () => {
    await h.pool.query(`delete from pgboss.job where name like 'event.%' and data->'event'->>'userId' = any($1)`, [made]);
  });

  it("approval: the event and its mail job commit together, and the job mails the account once it runs", async () => {
    const u = await account({ approved: false });
    await approveUser(svc, null, u);
    const [job, more] = await jobs("user.approved", u);
    assert.ok(job);
    assert.equal(more, undefined);
    sent.length = 0;
    await run("user.approved", job.data);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, `${u}@example.test`);
    assert.equal(sent[0]!.subject, "Your Reelsaw account is ready");
    assert.equal(sent[0]!.key, `${eventHandlerQueue("user.approved", "approvedEmail")}:${job.data.event.id}`);
  });

  it("a rolled-back change leaves neither the event nor its job", async () => {
    const u = await account();
    await assert.rejects(
      svc.tx(async (w) => {
        await w.emitEvent("webhook.disabled", {
          userId: u,
          email: `${u}@example.test`,
          payload: { endpointId: "e1", url: "https://hooks.example.test/…", reason: "gone" },
        });
        throw new Error("abort");
      }),
      /abort/,
    );
    assert.equal((await h.pool.query(`select count(*)::int as n from events where user_id = $1`, [u])).rows[0].n, 0);
    assert.deepEqual(await jobs("webhook.disabled", u), []);
  });

  it("webhook turned off: the owner is mailed the endpoint and why, and a suspended owner is not", async () => {
    const u = await account();
    await svc.tx((w) =>
      w.emitEvent("webhook.disabled", {
        userId: u,
        email: `${u}@example.test`,
        payload: { endpointId: "e1", url: "https://hooks.example.test/…", reason: "Turned off after 3 days of failed deliveries." },
      }),
    );
    const [job] = await jobs("webhook.disabled", u);
    assert.ok(job);
    sent.length = 0;
    await run("webhook.disabled", job.data);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.subject, "A Reelsaw webhook was turned off");
    assert.match(sent[0]!.text, /hooks\.example\.test/);
    assert.match(sent[0]!.text, /3 days of failed deliveries/);
    await h.pool.query(`update "user" set banned = true where id = $1`, [u]);
    await run("webhook.disabled", job.data);
    assert.equal(sent.length, 1);
  });

  it("sign-up: only one that waits for approval queues the admins' note, and none goes once it is approved", async () => {
    const admin = await account({ role: "admin" });
    const open = await account();
    const waiting = await account({ approved: false });
    const signUp = (u: string, approved: boolean) =>
      svc.tx((w) => w.emitEvent("user.signed_up", { userId: u, email: `${u}@example.test`, payload: { role: "user", approved, mode: "approval" } }));
    await signUp(open, true);
    await signUp(waiting, false);
    assert.deepEqual(await jobs("user.signed_up", open), []);
    const [job] = await jobs("user.signed_up", waiting);
    assert.ok(job);
    sent.length = 0;
    await run("user.signed_up", job.data);
    const toAdmin = sent.filter((s) => s.to === `${admin}@example.test`);
    assert.equal(toAdmin.length, 1);
    assert.match(toAdmin[0]!.subject, /is waiting for approval/);
    assert.ok(toAdmin[0]!.key?.endsWith(`:${admin}`));
    sent.length = 0;
    await h.pool.query(`update "user" set approved_at = now() where id = $1`, [waiting]);
    await run("user.signed_up", job.data);
    assert.equal(sent.length, 0);
  });
});
