/**
 * Billing against the running app with the Stripe mock (test/stripe-mock.ts): checkout → webhooks (delivered in
 * reverse and twice) → plan in force within seconds; a failed payment keeps the plan inside the grace period; a
 * cancellation returns the account to Free; a redelivered event is acknowledged without a second sync; an unsigned
 * webhook is refused. Skipped unless STRIPE_MOCK_URL is set.
 *
 *   pnpm stripe:mock                                    (terminal 1)
 *   app running with REELSAW_EE=true STRIPE_API_BASE=http://host.docker.internal:4242 STRIPE_SECRET_KEY=sk_test_mock STRIPE_WEBHOOK_SECRET=whsec_mock
 *   STRIPE_MOCK_URL=http://localhost:4242 pnpm test -- test/billing-stack.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BASE, db, signUp } from "./helpers.js";

const MOCK = process.env.STRIPE_MOCK_URL;
const json = { "content-type": "application/json", origin: BASE };
async function trpc(cookie: string, path: string, input?: unknown, method: "GET" | "POST" = "POST") {
  const url = method === "GET" ? `${BASE}/api/trpc/${path}${input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ""}` : `${BASE}/api/trpc/${path}`;
  const res = await fetch(url, { method, headers: { ...json, cookie }, body: method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  const body = (await res.json()) as { result?: { data: unknown }; error?: { message: string; data: { code: string } } };
  return { status: res.status, data: body.result?.data as never, error: body.error };
}
const mock = async (path: string, body: unknown = {}) => (await fetch(`${MOCK}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<{ subscription?: string; delivered: Array<{ status: number; body: string }>; status?: number }>;
type State = { plan: { name: string }; reason: string; subscription: { status: string; cancelAtPeriodEnd: boolean } | null; limits: Record<string, number>; usage: Record<string, number>; watermark: { on: boolean; source: string }; period: { source?: string } | null; canManage: boolean };
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() - t0 > ms) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe("billing (stack + stripe mock)", { skip: !MOCK && "STRIPE_MOCK_URL not set" }, () => {
  const pool = db();
  let user: Awaited<ReturnType<typeof signUp>>;
  let subscriptionId = "";
  before(async () => {
    user = await signUp();
  });
  after(async () => {
    await pool.query(`delete from "user" where id = $1`, [user.userId]);
    await pool.end();
  });
  const state = async () => (await trpc(user.cookie, "billing.get", undefined, "GET")).data as State;
  const events = async (type: string) => Number((await pool.query(`select count(*)::int as n from admin_events where user_id = $1 and type = $2`, [user.userId, type])).rows[0].n);

  it("a new account is on Free with the watermark and the Free limits", async () => {
    const s = await state();
    assert.equal(s.plan.name, "free");
    assert.equal(s.limits.MAX_SOURCE_MINUTES_PER_MONTH, 20);
    assert.equal(s.watermark.on, true);
    assert.equal(s.canManage, false);
    const me = (await trpc(user.cookie, "me.get", undefined, "GET")).data as { ee: { billing: boolean }; watermark: { on: boolean } };
    assert.equal(me.ee.billing, true);
    assert.equal(me.watermark.on, true);
  });

  it("the first video is free up to 60 minutes; the next ones count against the 20-minute month", async () => {
    // minutes come from source_usage (the ledger a purged project keeps), so each video is a project row and a usage row
    let n = 0;
    const mk = async (title: string, sec: number) => {
      const id = randomUUID();
      await pool.query(
        `insert into projects (id, user_id, title, source_type, source_url, duration_sec, status, settings, created_at, updated_at) values ($1, $2, $3, 'url', 'https://example.com/v.mp4', $4, 'done', '{}', now(), now())`,
        [id, user.userId, title, sec],
      );
      await pool.query(`insert into source_usage (user_id, project_id, duration_sec, created_at) values ($1, $2, $3, now() + ($4 || ' seconds')::interval)`, [user.userId, id, sec, String(n++)]);
    };
    await mk("First, 45 min", 45 * 60);
    let s = await state();
    assert.equal(s.usage.MAX_SOURCE_MINUTES_PER_MONTH, 0, "the first video does not count");
    await mk("Second, 15 min", 15 * 60);
    s = await state();
    assert.equal(s.usage.MAX_SOURCE_MINUTES_PER_MONTH, 15);
    await mk("Third, 10 min", 10 * 60);
    const refused = await trpc(user.cookie, "projects.create", { sourceUrl: "https://example.com/other.mp4" });
    assert.equal(refused.error?.data.code, "TOO_MANY_REQUESTS");
    assert.match(refused.error!.message, /Monthly limit of 20 minutes of video reached \(25 used\); resets on .*Starter gives 100 minutes a month: http/);
    await pool.query(`delete from projects where user_id = $1`, [user.userId]);
    await pool.query(`delete from source_usage where user_id = $1`, [user.userId]);
  });

  // stack only: source_usage rows with no length (still downloading, or failed before the probe) never take the free first video
  it("the first-video allowance goes to the earliest video whose length is known", async () => {
    const mk = (title: string, sec: number | null, ageMin: number) => {
      const id = `fv-${title}-${Date.now()}`;
      return pool.query(`insert into source_usage (user_id, project_id, duration_sec, created_at) values ($1, $2, $3, now() - ($4 || ' minutes')::interval)`, [user.userId, id, sec, String(ageMin)]);
    };
    await mk("pending", null, 30);
    let s = await state();
    assert.equal(s.usage.MAX_SOURCE_MINUTES_PER_MONTH, 0);
    await mk("first", 45 * 60, 20);
    await mk("second", 15 * 60, 10);
    s = await state();
    assert.equal(s.usage.MAX_SOURCE_MINUTES_PER_MONTH, 15, "the 45-minute video is the free one, not the earlier row without a length");
    await pool.query(`delete from source_usage where user_id = $1`, [user.userId]);
  });

  it("checkout returns the mock's page; completing it delivers events in reverse and twice, and the plan lands", async () => {
    const r = await trpc(user.cookie, "billing.checkout", { plan: "creator", interval: "month" });
    assert.equal(r.error, undefined, r.error?.message);
    const { url, kind } = r.data as { url: string; kind: string };
    assert.equal(kind, "checkout");
    const sessionId = /\/_mock\/checkout\/(cs_[a-z0-9]+)/.exec(url)?.[1];
    assert.ok(sessionId, url);
    const done = await mock(`/_mock/complete/${sessionId}`, { reverse: true, duplicate: true });
    subscriptionId = done.subscription!;
    assert.equal(done.delivered.length, 4);
    for (const d of done.delivered) assert.equal(d.status, 200, d.body);
    const dup = done.delivered[3]!;
    assert.match(dup.body, /"duplicate":true/);
    const s = await until(state, (x) => x.plan.name === "creator");
    assert.equal(s.plan.name, "creator");
    assert.equal(s.reason, "active");
    assert.equal(s.limits.MAX_SOURCE_MINUTES_PER_MONTH, 300);
    assert.equal(s.watermark.on, false);
    assert.equal(s.watermark.source, "plan");
    assert.equal(s.period?.source, undefined); // the Billing page gets ISO dates; the source is on the admin query
    assert.equal(s.canManage, true);
    assert.equal(await events("billing.subscribed"), 1);
    const ev = await pool.query(`select count(*)::int as n from billing_events where subscription_id = $1 and processed_at is null`, [subscriptionId]);
    assert.equal(ev.rows[0].n, 0, "every event processed");
    const row = await pool.query(`select plan, status, interval, period_end from billing_subscriptions where user_id = $1`, [user.userId]);
    assert.equal(row.rows[0].plan, "creator");
    assert.equal(row.rows[0].interval, "month");
    assert.ok(row.rows[0].period_end > new Date());
  });

  it("a second checkout for a live subscription becomes a portal plan change, not a new subscription", async () => {
    const r = await trpc(user.cookie, "billing.checkout", { plan: "pro", interval: "month" });
    assert.equal(r.error, undefined, r.error?.message);
    assert.equal((r.data as { kind: string }).kind, "change");
    assert.match((r.data as { url: string }).url, /flow=subscription_update_confirm/);
    const same = await trpc(user.cookie, "billing.checkout", { plan: "creator", interval: "month" });
    assert.match(same.error?.message ?? "", /already on Creator/);
  });

  // stack + Stripe mock only: a lagging cache row must not lead to a second subscription
  it("a stale cache row does not start a second Checkout: the existing subscription is resynced and the Portal offered", async () => {
    await pool.query(`delete from billing_subscriptions where user_id = $1`, [user.userId]);
    const r = await trpc(user.cookie, "billing.checkout", { plan: "pro", interval: "month" });
    assert.equal(r.error, undefined, r.error?.message);
    assert.equal((r.data as { kind: string }).kind, "portal");
    const s = await until(state, (x) => x.subscription !== null);
    assert.ok(s.subscription, "the row is back, rewritten from Stripe");
  });

  it("a plan change at Stripe reaches the row and writes billing.changed", async () => {
    await mock(`/_mock/change/${subscriptionId}`, { lookupKey: "pro_yearly" });
    const s = await until(state, (x) => x.plan.name === "pro");
    assert.equal(s.plan.name, "pro");
    assert.equal(s.limits.MAX_SOURCE_MINUTES_PER_MONTH, 750);
    assert.equal(await events("billing.changed"), 1);
  });

  it("a failed payment keeps the plan inside the grace period and is audited once", async () => {
    await mock(`/_mock/fail/${subscriptionId}`, { reverse: true });
    const s = await until(state, (x) => x.subscription?.status === "past_due");
    assert.equal(s.subscription?.status, "past_due");
    assert.equal(s.plan.name, "pro");
    assert.equal(s.reason, "grace");
    assert.equal(await events("billing.payment_failed"), 1);
    await mock(`/_mock/fail/${subscriptionId}`); // again: no second audit row, still past_due
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await events("billing.payment_failed"), 1);
  });

  it("recovery and a redelivered old event leave the row in Stripe's current state", async () => {
    await mock(`/_mock/recover/${subscriptionId}`);
    const s = await until(state, (x) => x.subscription?.status === "active");
    assert.equal(s.reason, "active");
    const re = await mock(`/_mock/redeliver/${subscriptionId}`);
    assert.match(re.delivered[0]!.body, /"duplicate":true/);
    const after = await state();
    assert.equal(after.subscription?.status, "active");
    const pending = await pool.query(`select count(*)::int as n from billing_events where subscription_id = $1 and processed_at is null`, [subscriptionId]);
    assert.equal(pending.rows[0].n, 0);
  });

  it("an unsigned webhook is refused with 400 and records nothing", async () => {
    const before = (await pool.query(`select count(*)::int as n from billing_events`)).rows[0].n;
    const r = await mock("/_mock/unsigned");
    assert.equal(r.status, 400);
    assert.equal((await pool.query(`select count(*)::int as n from billing_events`)).rows[0].n, before);
  });

  it("cancel at period end keeps the plan; a deletion returns the account to Free with the watermark", async () => {
    await mock(`/_mock/cancel/${subscriptionId}`, { atPeriodEnd: true });
    const s = await until(state, (x) => !!x.subscription?.cancelAtPeriodEnd);
    assert.equal(s.plan.name, "pro");
    assert.equal(await events("billing.canceled"), 1);
    await mock(`/_mock/cancel/${subscriptionId}`);
    const f = await until(state, (x) => x.plan.name === "free");
    assert.equal(f.plan.name, "free");
    assert.equal(f.reason, "ended");
    assert.equal(f.watermark.on, true);
    assert.equal(f.limits.MAX_SOURCE_MINUTES_PER_MONTH, 20);
  });

  it("a complimentary grant survives a late event of the ended subscription, and admin sync keeps it", async () => {
    const r = await trpc(user.cookie, "admin.billing.setPlan", { id: user.userId, plan: "creator" }).catch(() => null);
    // the account is not an admin yet; grant through the database helper the admin UI uses once promoted below
    await pool.query(`update "user" set role = 'admin' where id = $1`, [user.userId]);
    const set = await trpc(user.cookie, "admin.billing.setPlan", { id: user.userId, plan: "creator" });
    assert.equal(set.error, undefined, set.error?.message ?? String(r));
    assert.equal((await state()).reason, "complimentary");
    const re = await mock(`/_mock/redeliver/${subscriptionId}`);
    assert.match(re.delivered[0]!.body, /"duplicate":true|"queued":true/);
    await mock(`/_mock/cancel/${subscriptionId}`); // a fresh deleted event for the ended subscription
    await new Promise((res) => setTimeout(res, 2500));
    const s = await state();
    assert.equal(s.reason, "complimentary");
    assert.equal(s.plan.name, "creator");
    const sync = await trpc(user.cookie, "admin.billing.sync", { id: user.userId });
    assert.equal(sync.error, undefined, sync.error?.message);
    assert.equal((await state()).reason, "complimentary", "admin sync does not wipe the grant");
    await trpc(user.cookie, "admin.billing.setPlan", { id: user.userId, plan: null });
    await pool.query(`update "user" set role = 'user' where id = $1`, [user.userId]);
  });

  it("events for a removed account are recorded as orphans, not retried forever", async () => {
    const victim = await signUp();
    const r = await trpc(victim.cookie, "billing.checkout", { plan: "starter", interval: "month" });
    const sessionId = /\/_mock\/checkout\/(cs_[a-z0-9]+)/.exec((r.data as { url: string }).url)![1];
    const done = await mock(`/_mock/complete/${sessionId}`);
    const victimSub = done.subscription!;
    await until(async () => (await trpc(victim.cookie, "billing.get", undefined, "GET")).data as State, (x) => x.plan.name === "starter");
    await pool.query(`update "user" set role = 'admin' where id = $1`, [user.userId]);
    const removed = await trpc(user.cookie, "admin.users.remove", { id: victim.userId });
    assert.equal(removed.error, undefined, removed.error?.message);
    await new Promise((res) => setTimeout(res, 1500)); // the after-commit cancel at Stripe
    const late = await mock(`/_mock/cancel/${victimSub}`);
    assert.equal(late.delivered[0]!.status, 200);
    const ev = await until(
      async () => (await pool.query(`select processed_at is not null as done, error from billing_events where subscription_id = $1 order by received_at desc limit 1`, [victimSub])).rows[0] as { done: boolean; error: string | null },
      (x) => x.done,
    );
    assert.equal(ev.done, true);
    assert.match(ev.error ?? "", /account was removed|no account/);
    await pool.query(`update "user" set role = 'user' where id = $1`, [user.userId]);
  });

  it("reconcile finds nothing to fix afterwards", async () => {
    await pool.query(`update "user" set role = 'admin' where id = $1`, [user.userId]);
    const r = await trpc(user.cookie, "admin.billing.sync", { id: user.userId });
    assert.equal(r.error, undefined, r.error?.message);
    assert.equal((r.data as { synced: number }).synced, 0);
  });
});
