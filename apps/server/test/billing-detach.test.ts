/**
 * Removing a hosted account cancels its Stripe subscription through the outbox (ee/event-handlers.ts):
 * `billing.detached` and its job commit with the removal, and the handler cancels once, idempotently.
 * Postgres plus an in-test stand-in for the three Stripe calls.  node --import tsx --test test/billing-detach.test.ts
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { lifecycleHarness } from "./lifecycle-harness.js";
import { removeUser } from "../src/accounts.js";
import { createBilling } from "../src/ee/billing/service.js";
import { eeEventHandlerMap } from "../src/ee/event-handlers.js";
import { eventHandlerQueue, eventHandlerQueues, parseEventHandlerJob } from "../src/event-handlers.js";
import { eventHandlerMap } from "../src/event-handler-map.js";
import { createLogger } from "../src/log.js";
import { createUnitOfWork } from "../src/uow.js";
import type { Services } from "../src/services.js";

const h = lifecycleHarness();
const notReady = await h.ready();
const maps = [eventHandlerMap, eeEventHandlerMap];
if (!notReady) for (const q of eventHandlerQueues(...maps)) await h.svc.queue.boss.createQueue(q.name, { policy: q.policy });

/** Stripe, for subscriptions.retrieve / cancel and customers.update; every call recorded with its idempotency key. */
const calls: Array<{ method: string; path: string; key: string | undefined }> = [];
const canceled = new Set<string>();
const stripe = http.createServer((req, res) => {
  calls.push({ method: req.method ?? "", path: req.url ?? "", key: req.headers["idempotency-key"]?.toString() });
  req.resume();
  req.on("end", () => {
    const [, , kind, id = ""] = (req.url ?? "").split("?")[0]!.split("/");
    res.setHeader("content-type", "application/json");
    if (kind === "subscriptions" && req.method === "DELETE") canceled.add(id);
    if (kind === "subscriptions") return res.end(JSON.stringify({ id, object: "subscription", status: canceled.has(id) ? "canceled" : "active" }));
    if (kind === "customers") return res.end(JSON.stringify({ id, object: "customer", metadata: {} }));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing" } }));
  });
});
await new Promise<void>((r) => stripe.listen(0, "127.0.0.1", r));
after(async () => {
  stripe.close();
  await h.cleanup();
});

const log = createLogger({ LOG_LEVEL: "fatal", LOG_FORMAT: "json" });
const svc = {
  ...h.svc,
  telemetry: { capture() {}, identify() {} },
  config: {
    ...h.svc.config,
    APP_URL: "https://app.example.test",
    STRIPE_SECRET_KEY: "sk_test_detach",
    STRIPE_API_BASE: `http://127.0.0.1:${(stripe.address() as AddressInfo).port}`,
    BILLING_GRACE_DAYS: 3,
  },
} as unknown as Services;
svc.tx = createUnitOfWork(h.pool, h.svc.queue, log, undefined, undefined, undefined, { handlers: maps, deps: () => svc });
svc.ee = { billing: createBilling(svc, log) } as unknown as Services["ee"];

const QUEUE = eventHandlerQueue("billing.detached", "cancelAtStripe");

async function hosted(sub: string | null, cus: string | null): Promise<string> {
  const u = await h.makeUser();
  if (cus) await h.pool.query(`insert into billing_customers (user_id, stripe_customer_id) values ($1, $2)`, [u, cus]);
  if (sub)
    await h.pool.query(
      `insert into billing_subscriptions (user_id, stripe_subscription_id, stripe_customer_id, plan, status) values ($1, $2, $3, 'pro', 'active')`,
      [u, sub, cus],
    );
  return u;
}

async function jobOf(u: string) {
  const r = await h.pool.query(
    `update pgboss.job set start_after = now() + interval '1 hour' where name = $1 and data->'event'->'payload'->>'userId' = $2 returning data`,
    [QUEUE, u],
  );
  return r.rows;
}

async function run(data: unknown) {
  const [q] = eventHandlerQueues(eeEventHandlerMap);
  const { event, key } = parseEventHandlerJob("billing.detached", data);
  await q!.def.handle({ event, key, svc, signal: new AbortController().signal, again: async () => null });
}

describe("removing a hosted account", { skip: notReady ?? false }, () => {
  it("commits billing.detached and its cancel job with the removal; the job cancels once and clears the customer", async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const u = await hosted(`sub_${tag}`, `cus_${tag}`);
    await removeUser(svc, null, u);
    const ev = await h.pool.query(`select payload from events where user_id = $1 and type = 'billing.detached'`, [u]);
    assert.equal(ev.rows[0]?.payload.subscriptionId, `sub_${tag}`);
    assert.equal(ev.rows[0]?.payload.customerId, `cus_${tag}`);
    const [job, more] = await jobOf(u);
    assert.ok(job);
    assert.equal(more, undefined);

    calls.length = 0;
    await run(job.data);
    const cancel = calls.filter((c) => c.method === "DELETE");
    assert.equal(cancel.length, 1);
    assert.equal(cancel[0]!.path.split("?")[0], `/v1/subscriptions/sub_${tag}`);
    assert.equal(cancel[0]!.key, `cancel:sub_${tag}`);
    assert.ok(calls.some((c) => c.method === "POST" && c.path.startsWith(`/v1/customers/cus_${tag}`)));

    // a retry after it went through cancels nothing twice
    calls.length = 0;
    await run(job.data);
    assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
    await h.pool.query(`delete from pgboss.job where name = $1 and data->'event'->'payload'->>'userId' = $2`, [QUEUE, u]);
  });

  it("emits nothing for an account Stripe never knew", async () => {
    const u = await hosted(null, null);
    await removeUser(svc, null, u);
    assert.equal((await h.pool.query(`select count(*)::int as n from events where user_id = $1 and type = 'billing.detached'`, [u])).rows[0].n, 0);
    assert.deepEqual(await jobOf(u), []);
  });
});
