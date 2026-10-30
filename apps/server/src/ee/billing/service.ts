/**
 * Billing through Stripe (docs/specs/ee.md). Stripe is the source of truth for a subscription; the
 * `billing_subscriptions` row is a cache that only `sync()` writes, and it writes it whole from
 * `subscriptions.retrieve`, never from a webhook payload. So:
 *
 *   - A webhook is acknowledged only after its event row and its `billing.sync` job committed together
 *     (one unit of work; a failure returns 5xx and Stripe redelivers). The event id is the primary key, so a
 *     redelivery is a no-op that still gets a 200.
 *   - The sync job reads the subscription from Stripe at run time, locks the account's billing row, rewrites
 *     it and writes the admin events for whatever changed, in one transaction. Events that arrive out of
 *     order or twice converge on the same row. pg-boss retries a failed sync; one sync per subscription at a
 *     time (`exclusive` + singletonKey), and a sync queued while one runs waits its turn.
 *   - A daily reconcile (and `reelsaw billing sync`) walks Stripe's subscriptions and every pending event, so
 *     a lost webhook is repaired within a day without anyone noticing a locked-out customer.
 *
 * Money moves only in Stripe-hosted pages (Checkout, the Billing Portal): no card data and no proration
 * arithmetic here.
 */
import Stripe from "stripe";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { schema, type Db } from "../../db/index.js";
import { BILLING_STATUSES, type BillingInterval, type BillingStatus, type BillingSubscriptionRow } from "../../db/schema.js";
import type { Services } from "../../services.js";
import type { UnitOfWork } from "../../uow.js";
import type { Logger } from "../../log.js";
import { limitsDetail, limitUsage, watermarkFor } from "../../quota.js";
import { takeTxLock, txLock } from "../../locks.js";
import { billingPath } from "@reelsaw/shared";
import { ALL_LOOKUP_KEYS, PAID_PLANS, PLANS, planByLookupKey, planOf, publicPlan, type Interval } from "./plans.js";
import { createEntitlements, effectivePlan, LIVE_STATUSES } from "./entitlements.js";

export const SYNC_QUEUE = "billing.sync";
export const RECONCILE_QUEUE = "billing.reconcile";
export interface SyncJob {
  subscriptionId: string;
  /** the webhook event that asked for it, for the log */
  eventId?: string;
  reason?: string;
}

/** Event types that carry a subscription we track (also what scripts/stripe-setup.ts subscribes the endpoint to). Anything else is recorded and marked processed at once. */
export const TRACKED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
] as const satisfies readonly Stripe.Event.Type[];

/** Stripe's statuses are a subset of ours (ours adds `complimentary`); a status this SDK does not know grants nothing. */
export function toBillingStatus(s: string): BillingStatus {
  const known = BILLING_STATUSES.find((k) => k === s);
  return known ?? "incomplete";
}

/** Stripe references an object by id or by the expanded object; either way, its id. */
const idOf = (v: string | { id: string } | null | undefined): string | null => (typeof v === "string" ? v : (v?.id ?? null));
/** The same for a value the SDK's types do not know (a field from an older API version): narrowed at runtime. */
function idOfUnknown(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "id" in v && typeof v.id === "string") return v.id;
  return null;
}

/** The subscription id an event is about, for the kinds we track. `Stripe.Event` is a discriminated union, so each branch is typed. */
export function subscriptionIdOf(event: Stripe.Event): string | null {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
    case "customer.subscription.trial_will_end":
      return event.data.object.id;
    case "checkout.session.completed":
      return idOf(event.data.object.subscription);
    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.payment_action_required": {
      const invoice = event.data.object;
      const viaParent = idOf(invoice.parent?.subscription_details?.subscription);
      if (viaParent) return viaParent;
      // an account still on an API version before 2025-03-31 sends invoices with a top-level `subscription`
      // (events follow the account's version, not the SDK's); `in` narrows without a cast
      return "subscription" in invoice ? idOfUnknown(invoice.subscription) : null;
    }
    default:
      return null;
  }
}

type Mapped = Pick<
  BillingSubscriptionRow,
  | "stripeSubscriptionId"
  | "stripeCustomerId"
  | "stripeCreated"
  | "plan"
  | "status"
  | "interval"
  | "priceId"
  | "periodStart"
  | "periodEnd"
  | "cancelAtPeriodEnd"
  | "endedAt"
>;

/** Our row shape for a Stripe subscription. The price's lookup key names the plan; an unknown price is kept as `unknown:<id>` and logged. */
export function mapSubscription(sub: Stripe.Subscription): Mapped & { unknownPrice: boolean } {
  const item = sub.items.data[0];
  const price = item?.price;
  const found = planByLookupKey(price?.lookup_key);
  const sec = (n: number | null | undefined) => (n ? new Date(n * 1000) : null);
  const recurring = price?.recurring?.interval;
  // Stripe types its string unions with an escape hatch for values newer than the SDK; narrow to what we store
  const interval: BillingInterval | null = found?.interval ?? (recurring === "year" ? "year" : recurring === "month" ? "month" : null);
  const status = toBillingStatus(sub.status);
  return {
    stripeSubscriptionId: sub.id,
    stripeCustomerId: idOf(sub.customer),
    stripeCreated: sec(sub.created),
    plan: found?.plan.name ?? `unknown:${price?.id ?? "none"}`,
    status,
    interval,
    priceId: price?.id ?? null,
    // the period lives on the item (API versions from 2025 on)
    periodStart: sec(item?.current_period_start),
    periodEnd: sec(item?.current_period_end),
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    endedAt: sec(sub.ended_at),
    unknownPrice: !found,
  };
}

const isLive = (s: BillingStatus | string) => LIVE_STATUSES.has(s);

export type BillingService = ReturnType<typeof createBilling>;

export function createBilling(svc: Pick<Services, "config" | "database" | "tx" | "settings" | "queue" | "telemetry">, log: Logger) {
  const { config } = svc;
  const base = config.STRIPE_API_BASE ? new URL(config.STRIPE_API_BASE) : null;
  const stripe = new Stripe(config.STRIPE_SECRET_KEY!, {
    appInfo: { name: "Reelsaw", version: config.REELSAW_VERSION, url: config.APP_URL },
    maxNetworkRetries: 2,
    // development only: a stripe-mock or test/stripe-mock.ts instead of api.stripe.com
    ...(base
      ? { host: base.hostname, port: Number(base.port || (base.protocol === "https:" ? 443 : 80)), protocol: base.protocol === "https:" ? "https" : "http" }
      : {}),
  });
  if (base) log.warn({ base: base.origin }, "Stripe calls go to STRIPE_API_BASE, not api.stripe.com");
  const entitlements = createEntitlements({ graceDays: () => config.BILLING_GRACE_DAYS, appUrl: config.APP_URL });
  const db = () => svc.database.db;
  const url = (p: string) => new URL(p, config.APP_URL).toString();
  /** lookup key -> Stripe price id, resolved at boot (check) and refreshed when a key is missing */
  let prices = new Map<string, string>();

  async function resolvePrices() {
    const found = new Map<string, string>();
    for await (const p of stripe.prices.list({ lookup_keys: ALL_LOOKUP_KEYS, active: true, limit: 100 })) if (p.lookup_key) found.set(p.lookup_key, p.id);
    const missing = ALL_LOOKUP_KEYS.filter((k) => !found.has(k));
    if (missing.length)
      throw new Error(`Stripe has no active price for lookup key(s) ${missing.join(", ")}: create them in the Dashboard (ee/billing/plans.ts lists the keys)`);
    prices = found;
  }

  /**
   * The Stripe customer for an account, created on first use. Three guards against a second customer for one
   * account: the row (after the first success), the idempotency key (retries within Stripe's 24-hour window),
   * and a lookup by email + metadata.userId before creating (a crash between the create and the insert, found
   * again after the key expired).
   */
  async function ensureCustomer(user: { id: string; email: string; name: string }): Promise<string> {
    const have = await db().query.billingCustomers.findFirst({ where: eq(schema.billingCustomers.userId, user.id) });
    if (have) return have.stripeCustomerId;
    const existing = (await stripe.customers.list({ email: user.email, limit: 10 })).data.find((c) => c.metadata?.userId === user.id);
    const customer =
      existing ??
      (await stripe.customers.create({ email: user.email, name: user.name, metadata: { userId: user.id } }, { idempotencyKey: `customer:${user.id}` }));
    if (existing) log.info({ userId: user.id, customerId: existing.id }, "reusing the Stripe customer found by email and metadata");
    await db().insert(schema.billingCustomers).values({ userId: user.id, stripeCustomerId: customer.id }).onConflictDoNothing();
    const row = await db().query.billingCustomers.findFirst({ where: eq(schema.billingCustomers.userId, user.id) });
    if (row && row.stripeCustomerId !== customer.id)
      log.warn({ userId: user.id, kept: row.stripeCustomerId, duplicate: customer.id }, "two Stripe customers for one account; keeping the first");
    return row?.stripeCustomerId ?? customer.id;
  }

  const priceFor = async (plan: string, interval: Interval) => {
    const p = planOf(plan);
    if (!p.lookupKeys) throw new TRPCError({ code: "BAD_REQUEST", message: `${p.label} has no price` });
    const key = p.lookupKeys[interval];
    if (!prices.has(key)) await resolvePrices();
    return prices.get(key)!;
  };

  /**
   * Checkout → Stripe-hosted page. With a live subscription the plan change goes through the Billing Portal's
   * confirm-update flow instead (Stripe prorates and the webhook updates us); a new Checkout would make a
   * second subscription.
   */
  async function checkout(
    user: { id: string; email: string; name: string },
    plan: string,
    interval: Interval,
  ): Promise<{ url: string; kind: "checkout" | "change" | "portal" }> {
    const price = await priceFor(plan, interval);
    const row = await entitlements.rowFor(db(), user.id);
    const customer = await ensureCustomer(user);
    if (row?.stripeSubscriptionId && isLive(row.status) && row.status !== "complimentary") {
      if (row.priceId === price)
        throw new TRPCError({ code: "BAD_REQUEST", message: `You are already on ${planOf(plan).label} (${interval === "year" ? "yearly" : "monthly"}).` });
      const sub = await stripe.subscriptions.retrieve(row.stripeSubscriptionId);
      const item = sub.items.data[0];
      if (!item) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The subscription has no item to change; contact support." });
      const session = await stripe.billingPortal.sessions.create({
        customer,
        return_url: url(billingPath()),
        flow_data: {
          type: "subscription_update_confirm",
          subscription_update_confirm: { subscription: sub.id, items: [{ id: item.id, price, quantity: 1 }] },
          after_completion: { type: "redirect", redirect: { return_url: url(billingPath("changed")) } },
        },
      });
      log.info({ userId: user.id, plan, interval, subscriptionId: sub.id }, "plan change started");
      return { url: session.url, kind: "change" };
    }
    if (row?.status === "complimentary")
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: `This account has ${planOf(row.plan).label} as a courtesy; ask an admin before paying for a plan.`,
      });
    // our row can lag Stripe (a lost webhook, a sync still queued): never start a second subscription for a customer
    // who has one that is not over. Bring the row up to date and let them manage that one in the Billing Portal.
    const existing = await openSubscriptionOf(customer);
    if (existing) {
      await sync(existing.id, "checkout");
      const portalSession = await stripe.billingPortal.sessions.create({ customer, return_url: url(billingPath()) });
      log.warn(
        { userId: user.id, plan, interval, subscriptionId: existing.id, status: existing.status },
        "checkout skipped: the customer already has a subscription at Stripe",
      );
      return { url: portalSession.url, kind: "portal" };
    }
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      client_reference_id: user.id,
      line_items: [{ price, quantity: 1 }],
      success_url: url(billingPath("success")),
      cancel_url: url(billingPath("canceled")),
      allow_promotion_codes: true,
      subscription_data: { metadata: { userId: user.id, plan } },
      metadata: { userId: user.id, plan, interval },
      ...(config.STRIPE_MANAGED_PAYMENTS ? { managed_payments: { enabled: true } } : {}),
    });
    if (!session.url) throw new Error("Stripe returned a Checkout Session without a URL");
    log.info({ userId: user.id, plan, interval, sessionId: session.id, managedPayments: config.STRIPE_MANAGED_PAYMENTS }, "checkout started");
    return { url: session.url, kind: "checkout" };
  }

  /** A subscription of this Stripe customer that is not over (Stripe's list filters by one status at a time, so list them all and look). */
  async function openSubscriptionOf(customer: string): Promise<Stripe.Subscription | null> {
    const notOver: readonly string[] = ["active", "trialing", "past_due", "incomplete", "unpaid"];
    for await (const s of stripe.subscriptions.list({ customer, status: "all", limit: 20 })) if (notOver.includes(s.status)) return s;
    return null;
  }

  async function portal(user: { id: string; email: string; name: string }): Promise<{ url: string }> {
    const have = await db().query.billingCustomers.findFirst({ where: eq(schema.billingCustomers.userId, user.id) });
    if (!have) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No billing account yet: pick a plan first." });
    const session = await stripe.billingPortal.sessions.create({ customer: have.stripeCustomerId, return_url: url(billingPath()) });
    return { url: session.url };
  }

  /**
   * The webhook endpoint's work: verify, record, queue. Returns what happened; the HTTP layer maps a
   * `SignatureError` to 400 and anything else thrown to 500 (Stripe retries).
   */
  async function recordWebhook(
    raw: string,
    signature: string | null,
    rlog: Logger = log,
  ): Promise<{ eventId: string; type: string; duplicate: boolean; queued: boolean }> {
    if (!signature) throw new SignatureError("missing stripe-signature header");
    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(raw, signature, config.STRIPE_WEBHOOK_SECRET!);
    } catch (err) {
      throw new SignatureError((err as Error).message);
    }
    const subscriptionId = subscriptionIdOf(event);
    const r = await svc.tx(async (u) => {
      const inserted = await u.db
        .insert(schema.billingEvents)
        .values({
          id: event.id,
          type: event.type,
          subscriptionId,
          created: new Date(event.created * 1000),
          payload: event.data.object,
          processedAt: subscriptionId ? null : new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: schema.billingEvents.id });
      if (!inserted.length) return { duplicate: true, queued: false };
      if (!subscriptionId) return { duplicate: false, queued: false };
      // same transaction as the event row: an acknowledged event always has its job
      const jobId = await u.send(SYNC_QUEUE, { subscriptionId, eventId: event.id, reason: event.type } satisfies SyncJob, { singletonKey: subscriptionId });
      // null = a sync for this subscription is already queued (stately policy: one queued, one active per key); the
      // queued one runs after the active one and reads Stripe after this event. An active-only sync does not block a
      // new queued one, and a sync never marks events received after its own read, so nothing is lost.
      return { duplicate: false, queued: jobId !== null };
    });
    rlog[r.duplicate ? "debug" : "info"]({ eventId: event.id, type: event.type, subscriptionId, ...r }, "stripe webhook");
    return { eventId: event.id, type: event.type, ...r };
  }

  /** Which account a Stripe subscription belongs to: its metadata, else its customer, else the row that already points at it. */
  async function userIdFor(d: Db, sub: Stripe.Subscription | null, subscriptionId: string): Promise<string | null> {
    const meta = sub?.metadata?.userId;
    if (meta) return meta;
    const customerId = sub ? idOf(sub.customer) : null;
    if (customerId) {
      const c = await d.query.billingCustomers.findFirst({ where: eq(schema.billingCustomers.stripeCustomerId, customerId) });
      if (c) return c.userId;
    }
    const row = await d.query.billingSubscriptions.findFirst({ where: eq(schema.billingSubscriptions.stripeSubscriptionId, subscriptionId) });
    return row?.userId ?? null;
  }

  /**
   * Rewrite the account's billing row from Stripe. Idempotent and convergent: whatever events were missed or
   * reordered, the row ends up as Stripe has it now. One transaction: lock, upsert, admin events, mark events.
   */
  async function sync(
    subscriptionId: string,
    reason = "manual",
  ): Promise<{ userId: string | null; changed: boolean; plan: string | null; status: string | null }> {
    const slog = log.child({ subscriptionId, reason });
    // events received after this instant were not seen by this read: they stay pending for the next sync
    const readAt = new Date();
    let sub: Stripe.Subscription | null;
    try {
      sub = await stripe.subscriptions.retrieve(subscriptionId);
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError && (err.code === "resource_missing" || err.statusCode === 404)) sub = null;
      else throw err;
    }
    const userId = await userIdFor(db(), sub, subscriptionId);
    const account = userId ? await db().query.user.findFirst({ where: eq(schema.user.id, userId), columns: { id: true, email: true } }) : null;
    if (!userId || !account) {
      // nobody we know (or an account that was removed): record it so the reconcile lists orphans, then stop
      const why = userId ? "the account was removed" : "no account for this subscription";
      slog.warn(
        { userId, customerId: sub ? idOf(sub.customer) : null, live: sub ? isLive(sub.status) : false },
        userId ? "subscription of a removed account" : "subscription without a Reelsaw account",
      );
      await db()
        .update(schema.billingEvents)
        .set({ processedAt: new Date(), error: why })
        .where(
          and(eq(schema.billingEvents.subscriptionId, subscriptionId), isNull(schema.billingEvents.processedAt), lt(schema.billingEvents.receivedAt, readAt)),
        );
      return { userId: null, changed: false, plan: null, status: null };
    }
    const mapped = sub ? mapSubscription(sub) : null;
    if (mapped?.unknownPrice)
      slog.error({ priceId: mapped.priceId }, "subscription price has no plan (lookup key unknown); the account gets Free until it is fixed");
    const graceDays = config.BILLING_GRACE_DAYS;
    return svc.tx(async (u) => {
      await takeTxLock(u.db, txLock.billing(userId));
      const [cur] = await u.db.select().from(schema.billingSubscriptions).where(eq(schema.billingSubscriptions.userId, userId)).for("update");
      const now = new Date();
      const unchanged = async (why: string) => {
        await markProcessed(u, subscriptionId, readAt);
        u.afterCommit(() => slog.debug({ userId, why, row: cur?.stripeSubscriptionId ?? null }, "subscription event left the row alone"));
        return { userId, changed: false, plan: cur?.plan ?? null, status: cur?.status ?? null };
      };
      let next: Mapped | null = mapped;
      if (!next) {
        // gone at Stripe: our row for it (if that is the one) becomes canceled; another subscription's row is left alone
        if (cur?.stripeSubscriptionId !== subscriptionId) return unchanged("gone at Stripe, not our row");
        next = { ...cur, status: "canceled", endedAt: cur.endedAt ?? now };
      } else if (cur?.status === "complimentary" && !isLive(next.status)) {
        // an admin's grant outranks the history of a subscription that grants nothing any more
        return unchanged("complimentary grant kept over an ended subscription");
      } else if (cur?.stripeSubscriptionId && cur.stripeSubscriptionId !== subscriptionId) {
        // an old subscription's late event must not overwrite the live one
        if (isLive(cur.status) && !isLive(next.status)) return unchanged("ended subscription is not the live one");
        if (isLive(cur.status) && isLive(next.status)) {
          // two live Stripe subscriptions for one account (two checkouts racing): the newer owns the row, whichever
          // event arrives last; the operator cancels the other in Stripe (`reelsaw billing` shows both)
          const curCreated = cur.stripeCreated?.getTime() ?? 0;
          const nextCreated = next.stripeCreated?.getTime() ?? 0;
          if (nextCreated < curCreated) {
            slog.error({ userId, keeping: cur.stripeSubscriptionId, older: subscriptionId }, "account has two live subscriptions; the newer keeps the row");
            return unchanged("older of two live subscriptions");
          }
          slog.error(
            { userId, keeping: subscriptionId, other: cur.stripeSubscriptionId },
            "account has two live subscriptions; the newer takes the row, cancel the other in Stripe",
          );
        }
      }
      const pastDueSince = next.status === "past_due" ? (cur?.status === "past_due" ? (cur.pastDueSince ?? now) : now) : null;
      const values = { ...next, userId, pastDueSince, syncedAt: now, updatedAt: now };
      await u.db.insert(schema.billingSubscriptions).values(values).onConflictDoUpdate({ target: schema.billingSubscriptions.userId, set: values });
      const before = effectivePlan(cur, graceDays, now);
      const after = effectivePlan(values, graceDays, now);
      const changed =
        !cur ||
        cur.status !== next.status ||
        cur.plan !== next.plan ||
        cur.interval !== next.interval ||
        cur.cancelAtPeriodEnd !== next.cancelAtPeriodEnd ||
        cur.periodEnd?.getTime() !== next.periodEnd?.getTime() ||
        cur.stripeSubscriptionId !== next.stripeSubscriptionId;
      const base = { actorId: null, userId, email: account.email };
      const ids = { subscriptionId, plan: next.plan, interval: next.interval, status: next.status };
      const audit = async (
        type: "billing.subscribed" | "billing.changed" | "billing.payment_failed" | "billing.canceled",
        payload: Record<string, unknown>,
      ) => {
        await u.db.insert(schema.adminEvents).values({ ...base, type, payload });
        u.afterCommit(() => svc.telemetry.capture(type, userId, { plan: next!.plan, interval: next!.interval, status: next!.status }));
      };
      if ((!cur || !isLive(cur.status)) && isLive(next.status)) await audit("billing.subscribed", ids);
      else if (cur && isLive(cur.status) && isLive(next.status) && (cur.plan !== next.plan || cur.interval !== next.interval))
        await audit("billing.changed", { ...ids, from: { plan: cur.plan, interval: cur.interval } });
      if (cur?.status !== "past_due" && next.status === "past_due")
        await audit("billing.payment_failed", { ...ids, graceEndsAt: new Date(now.getTime() + graceDays * 86_400_000).toISOString() });
      if ((cur && isLive(cur.status) && !isLive(next.status)) || (!cur?.cancelAtPeriodEnd && next.cancelAtPeriodEnd))
        await audit("billing.canceled", { ...ids, endsAt: (next.cancelAtPeriodEnd ? next.periodEnd : (next.endedAt ?? now))?.toISOString() ?? null });
      // a price no plan matches puts the account on Free without anyone being told: say so once per price
      if (mapped?.unknownPrice && next === mapped && (!cur || cur.stripeSubscriptionId !== subscriptionId || cur.priceId !== next.priceId)) {
        const message = `Subscription ${subscriptionId} uses a price Reelsaw does not know (${next.priceId ?? "none"}); the account is on Free until a plan matches.`;
        await u.db.insert(schema.adminEvents).values({ ...base, type: "billing.unknown_price", payload: { ...ids, priceId: next.priceId, message } });
        u.afterCommit(() => svc.telemetry.captureException(new Error(message), { userId, subscriptionId, priceId: next!.priceId }));
      }
      await markProcessed(u, subscriptionId, readAt);
      u.afterCommit(() =>
        slog[changed ? "info" : "debug"](
          { userId, plan: next!.plan, status: next!.status, effective: after.plan.name, was: before.plan.name, cancelAtPeriodEnd: next!.cancelAtPeriodEnd },
          changed ? "subscription synced" : "subscription unchanged",
        ),
      );
      return { userId, changed, plan: next.plan, status: next.status };
    });
  }

  /** Only the events this sync's read could have seen: anything received after `readAt` stays pending for the next one. */
  const markProcessed = (u: UnitOfWork, subscriptionId: string, readAt: Date) =>
    u.db
      .update(schema.billingEvents)
      .set({ processedAt: new Date(), error: null })
      .where(
        and(eq(schema.billingEvents.subscriptionId, subscriptionId), isNull(schema.billingEvents.processedAt), lt(schema.billingEvents.receivedAt, readAt)),
      );

  /** The statuses that grant anything (plus `unpaid`, which must be seen to revoke): what the walk lists. Ended subscriptions are history. */
  const LISTED_STATUSES = ["active", "trialing", "past_due", "unpaid", "paused"] as const satisfies readonly Stripe.SubscriptionListParams.Status[];

  /**
   * Walk Stripe and our rows and sync whatever disagrees. Bounded: only the statuses that matter are listed (not
   * every subscription the account ever had), one subscription at a time. Rows Stripe no longer lists are
   * re-read one by one, but never en masse: a wrong or rotated key would otherwise cancel every account at
   * once, so when more than a few rows are unseen the walk refuses and says so. Returns what it looked at.
   */
  async function reconcile(
    opts: { userId?: string } = {},
  ): Promise<{ checked: number; synced: number; orphans: string[]; pendingEvents: number; refused?: string }> {
    const d = db();
    const orphans: string[] = [];
    const out: { checked: number; synced: number; orphans: string[]; pendingEvents: number; refused?: string } = {
      checked: 0,
      synced: 0,
      orphans,
      pendingEvents: 0,
    };
    const seen = new Set<string>();
    const consider = async (s: Stripe.Subscription) => {
      out.checked++;
      seen.add(s.id);
      const row = await d.query.billingSubscriptions.findFirst({ where: eq(schema.billingSubscriptions.stripeSubscriptionId, s.id) });
      const m = mapSubscription(s);
      if (!row && !isLive(m.status)) return; // an ended subscription we never recorded: nothing to grant or revoke
      const differs =
        !row ||
        row.status !== m.status ||
        row.plan !== m.plan ||
        row.interval !== m.interval ||
        row.cancelAtPeriodEnd !== m.cancelAtPeriodEnd ||
        row.periodEnd?.getTime() !== m.periodEnd?.getTime();
      if (!differs) return;
      const r = await sync(s.id, "reconcile");
      if (!r.userId) orphans.push(s.id);
      else if (r.changed) out.synced++;
    };
    if (opts.userId) {
      const c = await d.query.billingCustomers.findFirst({ where: eq(schema.billingCustomers.userId, opts.userId) });
      if (c) for await (const s of stripe.subscriptions.list({ customer: c.stripeCustomerId, status: "all", limit: 20 })) await consider(s);
      log.info({ ...out, userId: opts.userId }, "billing reconcile (one account)");
      return out;
    }
    for (const status of LISTED_STATUSES) for await (const s of stripe.subscriptions.list({ status, limit: 100 })) await consider(s);
    // rows that point at a subscription Stripe no longer lists among the live ones: ended since, or deleted test data
    const rows = await d
      .select({ id: schema.billingSubscriptions.stripeSubscriptionId, status: schema.billingSubscriptions.status })
      .from(schema.billingSubscriptions)
      .where(sql`${schema.billingSubscriptions.stripeSubscriptionId} is not null`);
    const unseen = rows.filter((r) => r.id && !seen.has(r.id) && isLive(r.status));
    if (unseen.length > 10 && unseen.length > rows.length * 0.2) {
      out.refused = `${unseen.length} of ${rows.length} live rows are unknown to Stripe; refusing to cancel them all (wrong or rotated STRIPE_SECRET_KEY?)`;
      log.error({ unseen: unseen.length, rows: rows.length }, "billing reconcile refused the mass cancel");
    } else {
      for (const r of unseen) {
        out.checked++;
        if ((await sync(r.id!, "reconcile")).changed) out.synced++;
      }
    }
    // events acknowledged but never processed (a sync that kept failing): try again
    const pending = await d
      .select({ id: schema.billingEvents.subscriptionId })
      .from(schema.billingEvents)
      .where(and(isNull(schema.billingEvents.processedAt), lt(schema.billingEvents.receivedAt, new Date(Date.now() - 3_600_000))))
      .limit(500);
    const ids = [...new Set(pending.map((p) => p.id).filter((x): x is string => !!x))];
    out.pendingEvents = ids.length;
    for (const id of ids) if ((await sync(id, "reconcile")).changed) out.synced++;
    log.info(out, "billing reconcile");
    return out;
  }

  /** The queues exist in every process (the API process sends to them from the webhook); workers alone consume them. */
  async function ensureQueues() {
    const { boss } = svc.queue;
    // stately: one queued and one active job per subscription. A webhook during an active sync still queues the
    // next one (which reads Stripe afterwards); a second webhook while one is queued is covered by that one.
    const syncQueue = {
      policy: "stately" as const,
      retryLimit: 8,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 300,
      deleteAfterSeconds: 7 * 24 * 3600,
    };
    await boss.createQueue(SYNC_QUEUE, syncQueue);
    // a queue's policy is fixed at creation (an install from before this was `exclusive`): recreate it when it is idle
    const existing = await boss.getQueue(SYNC_QUEUE);
    if (existing && existing.policy !== syncQueue.policy) {
      const [stats] = await boss.getQueueStats(SYNC_QUEUE);
      const busy = (stats?.queuedCount ?? 0) + (stats?.activeCount ?? 0);
      if (busy > 0)
        log.warn({ policy: existing.policy, busy }, "billing.sync queue has the old policy and jobs in flight; it is recreated at the next idle boot");
      else {
        await boss.deleteQueue(SYNC_QUEUE);
        await boss.createQueue(SYNC_QUEUE, syncQueue);
        log.info({ from: existing.policy, to: syncQueue.policy }, "billing.sync queue recreated with the new policy");
      }
    }
    await boss.createQueue(RECONCILE_QUEUE, { policy: "exclusive", retryLimit: 2, retryDelay: 300, expireInSeconds: 3600, deleteAfterSeconds: 7 * 24 * 3600 });
  }

  /** Register the workers (worker processes) and the daily reconcile. */
  async function startWorkers() {
    const { boss } = svc.queue;
    await ensureQueues();
    await boss.work<SyncJob>(SYNC_QUEUE, { pollingIntervalSeconds: 2, localConcurrency: 2 }, async (jobs) => {
      const job = jobs[0]!;
      const jlog = log.child({ jobId: job.id, subscriptionId: job.data.subscriptionId, eventId: job.data.eventId });
      try {
        await sync(job.data.subscriptionId, job.data.reason ?? "webhook");
      } catch (err) {
        jlog.error({ err, attempt: job.retryCount + 1 }, "billing sync failed");
        await db()
          .update(schema.billingEvents)
          .set({ error: String((err as Error).message ?? err).slice(0, 500) })
          .where(and(eq(schema.billingEvents.subscriptionId, job.data.subscriptionId), isNull(schema.billingEvents.processedAt)));
        throw err;
      }
    });
    await boss.work(RECONCILE_QUEUE, { pollingIntervalSeconds: 30 }, async () => {
      await reconcile();
    });
    await boss.schedule(RECONCILE_QUEUE, "17 4 * * *", {}, { tz: "UTC" });
    log.info({ queues: [SYNC_QUEUE, RECONCILE_QUEUE] }, "billing workers listening");
  }

  /** Everything the Billing page, `get_billing` and `reelsaw billing <user>` show. */
  async function stateFor(user: { id: string; role: "user" | "admin" }) {
    const d = db();
    const row = await entitlements.rowFor(d, user.id);
    const graceDays = config.BILLING_GRACE_DAYS;
    const eff = effectivePlan(row, graceDays);
    const detail = await limitsDetail(d, svc.settings.get(), user.id, entitlements);
    const [usage, watermark, customer] = await Promise.all([
      limitUsage(d, user.id, detail.grants),
      watermarkFor(d, svc.settings.get(), user, entitlements),
      d.query.billingCustomers.findFirst({ where: eq(schema.billingCustomers.userId, user.id) }),
    ]);
    const period = detail.grants?.period ?? null;
    return {
      enabled: true as const,
      plan: publicPlan(eff.plan),
      reason: eff.reason,
      subscription: row
        ? {
            status: row.status,
            plan: row.plan,
            interval: row.interval,
            periodStart: row.periodStart?.toISOString() ?? null,
            periodEnd: row.periodEnd?.toISOString() ?? null,
            cancelAtPeriodEnd: row.cancelAtPeriodEnd,
            pastDueSince: row.pastDueSince?.toISOString() ?? null,
            graceEndsAt: row.pastDueSince ? new Date(row.pastDueSince.getTime() + graceDays * 86_400_000).toISOString() : null,
            stripe: !!row.stripeSubscriptionId,
          }
        : null,
      period: period ? { start: period.start.toISOString(), end: period.end.toISOString() } : null,
      limits: detail.limits,
      limitSource: detail.source,
      usage,
      watermark: { on: watermark.on, source: watermark.source },
      canManage: !!customer,
      plans: PLANS.map(publicPlan),
    };
  }

  /** Plan per account for the admin Users page, one query. */
  async function plansOf(userIds: string[]): Promise<Map<string, { plan: string; status: BillingStatus }>> {
    if (!userIds.length) return new Map();
    const rows = await db().select().from(schema.billingSubscriptions).where(inArray(schema.billingSubscriptions.userId, userIds));
    return new Map(rows.map((r) => [r.userId, { plan: effectivePlan(r, config.BILLING_GRACE_DAYS).plan.name, status: r.status }]));
  }

  /** Admin: grant a plan without Stripe (null = remove the grant). Refused while a live Stripe subscription exists. */
  async function setComplimentary(actorId: string, userId: string, plan: string | null) {
    if (plan && !PLANS.some((p) => p.name === plan)) throw new TRPCError({ code: "BAD_REQUEST", message: `No plan named ${plan}` });
    return svc.tx(async (u) => {
      await takeTxLock(u.db, txLock.billing(userId));
      const user = await u.db.query.user.findFirst({ where: eq(schema.user.id, userId), columns: { email: true } });
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "No such user" });
      const [cur] = await u.db.select().from(schema.billingSubscriptions).where(eq(schema.billingSubscriptions.userId, userId)).for("update");
      if (cur?.stripeSubscriptionId && isLive(cur.status))
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This account pays through Stripe; cancel that subscription in Stripe first." });
      const now = new Date();
      if (plan) {
        const values = {
          userId,
          stripeSubscriptionId: null,
          stripeCustomerId: cur?.stripeCustomerId ?? null,
          plan,
          status: "complimentary" as const,
          interval: null,
          priceId: null,
          periodStart: null,
          periodEnd: null,
          cancelAtPeriodEnd: false,
          pastDueSince: null,
          endedAt: null,
          syncedAt: now,
          updatedAt: now,
        };
        await u.db.insert(schema.billingSubscriptions).values(values).onConflictDoUpdate({ target: schema.billingSubscriptions.userId, set: values });
      } else if (cur) await u.db.delete(schema.billingSubscriptions).where(eq(schema.billingSubscriptions.userId, userId));
      await u.db
        .insert(schema.adminEvents)
        .values({ type: "billing.complimentary", actorId, userId, email: user.email, payload: { plan, from: cur?.plan ?? null } });
      u.afterCommit(() => log.info({ userId, plan, actorId }, "complimentary plan set"));
      return { ok: true, plan };
    });
  }

  /**
   * Called inside the transaction that deletes an account: remembers what to cancel at Stripe and returns the
   * after-commit task. Best effort there; a failure is logged and the daily reconcile lists the orphan.
   */
  async function detachUser(u: UnitOfWork, userId: string): Promise<() => Promise<void>> {
    const row = await u.db.query.billingSubscriptions.findFirst({ where: eq(schema.billingSubscriptions.userId, userId) });
    const customer = await u.db.query.billingCustomers.findFirst({ where: eq(schema.billingCustomers.userId, userId) });
    return async () => {
      try {
        if (row?.stripeSubscriptionId && isLive(row.status)) await stripe.subscriptions.cancel(row.stripeSubscriptionId, { prorate: false });
        if (customer) await stripe.customers.update(customer.stripeCustomerId, { metadata: { userId: "", removedAt: new Date().toISOString() } });
        log.info({ userId, subscriptionId: row?.stripeSubscriptionId ?? null }, "account removed; subscription canceled at Stripe");
      } catch (err) {
        log.error(
          { err, userId, subscriptionId: row?.stripeSubscriptionId ?? null },
          "could not cancel the removed account's subscription at Stripe; cancel it by hand",
        );
      }
    };
  }

  /** `reelsaw billing <user>`: the row, the customer, and Stripe's view side by side. */
  async function inspect(userId: string) {
    const d = db();
    const [row, customer] = await Promise.all([
      entitlements.rowFor(d, userId),
      d.query.billingCustomers.findFirst({ where: eq(schema.billingCustomers.userId, userId) }),
    ]);
    const stripeSubs = customer
      ? (await stripe.subscriptions.list({ customer: customer.stripeCustomerId, status: "all", limit: 10 })).data.map((s) => ({
          id: s.id,
          status: s.status,
          price: s.items.data[0]?.price.lookup_key ?? s.items.data[0]?.price.id ?? null,
          cancelAtPeriodEnd: s.cancel_at_period_end,
        }))
      : [];
    const events = await d
      .select({
        id: schema.billingEvents.id,
        type: schema.billingEvents.type,
        created: schema.billingEvents.created,
        processedAt: schema.billingEvents.processedAt,
        error: schema.billingEvents.error,
      })
      .from(schema.billingEvents)
      .where(row?.stripeSubscriptionId ? eq(schema.billingEvents.subscriptionId, row.stripeSubscriptionId) : sql`false`)
      .orderBy(sql`${schema.billingEvents.created} desc`)
      .limit(20);
    return { row, customer: customer?.stripeCustomerId ?? null, effective: effectivePlan(row, config.BILLING_GRACE_DAYS), stripe: stripeSubs, events };
  }

  return {
    stripe,
    entitlements,
    plans: PLANS,
    paidPlans: PAID_PLANS,
    check: async () => {
      await resolvePrices();
      await ensureQueues();
    },
    checkout,
    portal,
    recordWebhook,
    sync,
    reconcile,
    startWorkers,
    stateFor,
    plansOf,
    setComplimentary,
    detachUser,
    inspect,
  };
}

/** The webhook could not be verified: the HTTP layer answers 400 and Stripe does not retry. */
export class SignatureError extends Error {}
