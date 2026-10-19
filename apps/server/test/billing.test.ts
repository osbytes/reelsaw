/**
 * Billing rules that need no Stripe and no database: which plan a cached subscription row grants (grace, lapse,
 * complimentary), how a Stripe subscription maps to our row, which webhook events carry a subscription, how the
 * plan feeds the quota chain, and that the plan list the website shows is the one the server enforces.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { effectivePlan, grantsOf } from "../src/ee/billing/entitlements.js";
import { mapSubscription, subscriptionIdOf } from "../src/ee/billing/service.js";
import { PLANS, planByLookupKey, planOf, ALL_LOOKUP_KEYS } from "../src/ee/billing/plans.js";
import { periodFor, type Grants } from "../src/quota.js";
import type { BillingSubscriptionRow } from "../src/db/schema.js";

const now = new Date("2026-10-19T12:00:00Z");
const row = (o: Partial<BillingSubscriptionRow>): BillingSubscriptionRow => ({
  userId: "u1",
  stripeSubscriptionId: "sub_1",
  stripeCustomerId: "cus_1",
  plan: "creator",
  status: "active",
  interval: "month",
  priceId: "price_1",
  periodStart: new Date("2026-10-01T00:00:00Z"),
  periodEnd: new Date("2026-11-01T00:00:00Z"),
  cancelAtPeriodEnd: false,
  pastDueSince: null,
  endedAt: null,
  syncedAt: now,
  createdAt: now,
  updatedAt: now,
  ...o,
});

describe("effectivePlan", () => {
  it("no row, canceled, unpaid, incomplete and paused are Free", () => {
    assert.equal(effectivePlan(null, 7, now).plan.name, "free");
    for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"] as const) assert.equal(effectivePlan(row({ status }), 7, now).plan.name, "free", status);
  });
  it("active and trialing grant the plan; cancel-at-period-end keeps it until Stripe says canceled", () => {
    assert.equal(effectivePlan(row({ status: "active" }), 7, now).plan.name, "creator");
    assert.equal(effectivePlan(row({ status: "trialing", plan: "pro" }), 7, now).reason, "trialing");
    assert.equal(effectivePlan(row({ status: "active", cancelAtPeriodEnd: true }), 7, now).plan.name, "creator");
  });
  it("past_due keeps the plan inside the grace period and falls back to Free after it", () => {
    const since = new Date(now.getTime() - 3 * 86_400_000);
    assert.deepEqual(effectivePlan(row({ status: "past_due", pastDueSince: since }), 7, now), { plan: planOf("creator"), reason: "grace" });
    assert.deepEqual(effectivePlan(row({ status: "past_due", pastDueSince: since }), 2, now), { plan: planOf("free"), reason: "lapsed" });
    assert.equal(effectivePlan(row({ status: "past_due", pastDueSince: since }), 0, now).plan.name, "free");
  });
  it("complimentary grants the plan with no period", () => {
    const g = grantsOf(row({ status: "complimentary", stripeSubscriptionId: null, plan: "pro" }), 7, "https://app.example.com", now);
    assert.equal(g.plan, "pro");
    assert.equal(g.period, null);
    assert.equal(g.watermark, false);
    assert.equal(g.upgrade, undefined);
  });
  it("an unknown plan name (a price with no lookup key) grants Free", () => {
    assert.equal(effectivePlan(row({ plan: "unknown:price_x" }), 7, now).plan.name, "free");
  });
});

describe("grants and the quota chain", () => {
  it("Free carries the upgrade hint and the calendar month; a paid plan carries its billing period", () => {
    const free = grantsOf(null, 7, "https://app.example.com", now);
    assert.equal(free.plan, "free");
    assert.match(free.upgrade!.text, /Starter gives 100 minutes a month/);
    assert.equal(free.firstVideoFreeMinutes, 60);
    assert.equal(free.upgrade!.url, "https://app.example.com/settings/billing");
    assert.equal(free.watermark, null);
    assert.deepEqual(periodFor(free, now), { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z"), source: "calendar" });
    const paid = grantsOf(row({}), 7, "https://app.example.com", now);
    assert.equal(periodFor(paid, now).source, "billing");
    assert.equal(paid.limits.MAX_SOURCE_MINUTES_PER_MONTH, 300);
    assert.equal(grantsOf(row({ plan: "pro" }), 7, "https://app.example.com", now).queuePriority, 5);
  });
  it("a stale period (row not yet synced past its end) falls back to the calendar month instead of counting forever", () => {
    const g: Grants = { plan: "creator", planLabel: "Creator", limits: {}, watermark: false, period: { start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-09-01T00:00:00Z") } };
    assert.equal(periodFor(g, now).source, "calendar");
  });
});

describe("mapSubscription", () => {
  const sub = (o: Record<string, unknown> = {}) =>
    ({
      id: "sub_9",
      customer: "cus_9",
      status: "active",
      cancel_at_period_end: false,
      ended_at: null,
      metadata: { userId: "u9" },
      items: { data: [{ id: "si_1", current_period_start: 1_760_000_000, current_period_end: 1_762_600_000, price: { id: "price_pro_m", lookup_key: "pro_monthly", recurring: { interval: "month" } } }] },
      ...o,
    }) as never;
  it("reads the plan from the price lookup key and the period from the item", () => {
    const m = mapSubscription(sub());
    assert.equal(m.plan, "pro");
    assert.equal(m.interval, "month");
    assert.equal(m.unknownPrice, false);
    assert.equal(m.periodStart?.toISOString(), new Date(1_760_000_000 * 1000).toISOString());
    assert.equal(m.stripeCustomerId, "cus_9");
  });
  it("keeps an unknown price visible instead of guessing a plan", () => {
    const m = mapSubscription(sub({ items: { data: [{ id: "si_1", price: { id: "price_old", lookup_key: "legacy_2025", recurring: { interval: "year" } } }] } }));
    assert.equal(m.plan, "unknown:price_old");
    assert.equal(m.interval, "year");
    assert.equal(m.unknownPrice, true);
  });
  it("accepts the legacy period fields on the subscription itself", () => {
    const m = mapSubscription(sub({ items: { data: [{ id: "si_1", price: { id: "p", lookup_key: "creator_yearly" } }] }, current_period_end: 1_762_600_000 }));
    assert.equal(m.periodEnd?.getTime(), 1_762_600_000 * 1000);
  });
});

describe("subscriptionIdOf", () => {
  const ev = (type: string, object: Record<string, unknown>) => ({ type, data: { object } }) as never;
  it("finds the subscription on subscription, checkout and invoice events, and ignores the rest", () => {
    assert.equal(subscriptionIdOf(ev("customer.subscription.updated", { id: "sub_a" })), "sub_a");
    assert.equal(subscriptionIdOf(ev("checkout.session.completed", { subscription: "sub_b" })), "sub_b");
    assert.equal(subscriptionIdOf(ev("checkout.session.completed", { subscription: { id: "sub_b2" } })), "sub_b2");
    assert.equal(subscriptionIdOf(ev("invoice.payment_failed", { parent: { subscription_details: { subscription: "sub_c" } } })), "sub_c");
    assert.equal(subscriptionIdOf(ev("invoice.paid", { subscription: "sub_d" })), "sub_d");
    assert.equal(subscriptionIdOf(ev("checkout.session.completed", { subscription: null })), null);
    assert.equal(subscriptionIdOf(ev("payment_intent.succeeded", { id: "pi_1" })), null);
  });
});

describe("plans", () => {
  it("every paid plan has both lookup keys, and the keys are unique", () => {
    assert.equal(new Set(ALL_LOOKUP_KEYS).size, ALL_LOOKUP_KEYS.length);
    for (const k of ALL_LOOKUP_KEYS) assert.ok(planByLookupKey(k));
    assert.equal(planByLookupKey("nope"), null);
  });
  it("the website's pricing content is the server's plan list", async () => {
    const { PRICING } = await import("../../../website/content/pricing.js").catch(() => ({ PRICING: null }));
    if (!PRICING) return; // website not checked out next to the server (the package is outside the workspace)
    assert.deepEqual(
      PRICING.map((p) => ({ name: p.name, price: p.price, minutes: p.minutes, storageMb: p.storageMb, projects: p.projects, watermark: p.watermark, first: p.firstVideoFreeMinutes })),
      PLANS.map((p) => ({ name: p.name, price: p.price, minutes: p.limits.MAX_SOURCE_MINUTES_PER_MONTH ?? 0, storageMb: p.limits.MAX_STORAGE_MB ?? 0, projects: p.limits.MAX_PROJECTS_PER_USER ?? 0, watermark: p.watermark !== false, first: p.firstVideoFreeMinutes })),
    );
  });
});
