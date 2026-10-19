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
import type { BillingInterval, BillingStatus, BillingSubscriptionRow } from "../../db/schema.js";
import type { Services } from "../../services.js";
import type { UnitOfWork } from "../../uow.js";
import type { Logger } from "../../log.js";
import { limitsDetail, limitUsage, watermarkFor } from "../../quota.js";
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
export const TRACKED_EVENTS = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused", "customer.subscription.resumed", "customer.subscription.trial_will_end", "invoice.paid", "invoice.payment_failed", "invoice.payment_action_required"] as const;
const TRACKED = new Set<string>(TRACKED_EVENTS);

const idOf = (v: string | { id: string } | null | undefined): string | null => (typeof v === "string" ? v : (v?.id ?? null));

/** The subscription id an event is about, for the kinds we track. */
export function subscriptionIdOf(event: Stripe.Event): string | null {
  if (!TRACKED.has(event.type)) return null;
  const o = event.data.object as unknown as Record<string, unknown>;
  if (event.type.startsWith("customer.subscription.")) return typeof o.id === "string" ? o.id : null;
  if (event.type === "checkout.session.completed") return idOf(o.subscription as string | { id: string } | null);
  // invoices: the parent subscription (2025+ API shape), or the legacy field
  const parent = o.parent as { subscription_details?: { subscription?: string | { id: string } | null } | null } | null | undefined;
  return idOf(parent?.subscription_details?.subscription) ?? idOf(o.subscription as string | { id: string } | null | undefined);
}

type Mapped = Pick<BillingSubscriptionRow, "stripeSubscriptionId" | "stripeCustomerId" | "plan" | "status" | "interval" | "priceId" | "periodStart" | "periodEnd" | "cancelAtPeriodEnd" | "endedAt">;

/** Our row shape for a Stripe subscription. The price's lookup key names the plan; an unknown price is kept as `unknown:<id>` and logged. */
export function mapSubscription(sub: Stripe.Subscription): Mapped & { unknownPrice: boolean } {
  const item = sub.items.data[0];
  const price = item?.price;
  const found = planByLookupKey(price?.lookup_key);
  const sec = (n: number | null | undefined) => (n ? new Date(n * 1000) : null);
  // 2025+ API versions keep the period on the item; older objects carried it on the subscription
  const legacy = sub as unknown as { current_period_start?: number; current_period_end?: number };
  return {
    stripeSubscriptionId: sub.id,
    stripeCustomerId: idOf(sub.customer as string | { id: string }),
    plan: found?.plan.name ?? `unknown:${price?.id ?? "none"}`,
    status: sub.status as BillingStatus,
    interval: (found?.interval ?? (price?.recurring?.interval === "year" ? "year" : price?.recurring?.interval === "month" ? "month" : null)) as BillingInterval | null,
    priceId: price?.id ?? null,
    periodStart: sec(item?.current_period_start ?? legacy.current_period_start),
    periodEnd: sec(item?.current_period_end ?? legacy.current_period_end),
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
    appInfo: { name: "Reelsaw", version: config.REELSAW_VERSION, url: "https://reelsaw.com" },
    maxNetworkRetries: 2,
    // development only: a stripe-mock or test/stripe-mock.ts instead of api.stripe.com
    ...(base ? { host: base.hostname, port: Number(base.port || (base.protocol === "https:" ? 443 : 80)), protocol: base.protocol === "https:" ? "https" : "http" } : {}),
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
    if (missing.length) throw new Error(`Stripe has no active price for lookup key(s) ${missing.join(", ")}: create them in the Dashboard (ee/billing/plans.ts lists the keys)`);
    prices = found;
  }

  /** The Stripe customer for an account, created on first use. Idempotent at Stripe (one key per user) and here (insert on conflict). */
  async function ensureCustomer(user: { id: string; email: string; name: string }): Promise<string> {
    const have = await db().query.billingCustomers.findFirst({ where: eq(schema.billingCustomers.userId, user.id) });
    if (have) return have.stripeCustomerId;
    const customer = await stripe.customers.create({ email: user.email, name: user.name, metadata: { userId: user.id } }, { idempotencyKey: `customer:${user.id}` });
    await db().insert(schema.billingCustomers).values({ userId: user.id, stripeCustomerId: customer.id }).onConflictDoNothing();
    const row = await db().query.billingCustomers.findFirst({ where: eq(schema.billingCustomers.userId, user.id) });
    if (row && row.stripeCustomerId !== customer.id) log.warn({ userId: user.id, kept: row.stripeCustomerId, duplicate: customer.id }, "two Stripe customers for one account; keeping the first");
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
  async function checkout(user: { id: string; email: string; name: string }, plan: string, interval: Interval): Promise<{ url: string; kind: "checkout" | "change" }> {
    const price = await priceFor(plan, interval);
    const row = await entitlements.rowFor(db(), user.id);
    const customer = await ensureCustomer(user);
    if (row?.stripeSubscriptionId && isLive(row.status) && row.status !== "complimentary") {
      if (row.priceId === price) throw new TRPCError({ code: "BAD_REQUEST", message: `You are already on ${planOf(plan).label} (${interval === "year" ? "yearly" : "monthly"}).` });
      const sub = await stripe.subscriptions.retrieve(row.stripeSubscriptionId);
      const item = sub.items.data[0];
      if (!item) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The subscription has no item to change; contact support." });
      const session = await stripe.billingPortal.sessions.create({
        customer,
        return_url: url("/settings/billing"),
        flow_data: { type: "subscription_update_confirm", subscription_update_confirm: { subscription: sub.id, items: [{ id: item.id, price, quantity: 1 }] }, after_completion: { type: "redirect", redirect: { return_url: url("/settings/billing?checkout=changed") } } },
      });
      log.info({ userId: user.id, plan, interval, subscriptionId: sub.id }, "plan change started");
      return { url: session.url, kind: "change" };
    }
    if (row?.status === "complimentary") throw new TRPCError({ code: "PRECONDITION_FAILED", message: `This account has ${planOf(row.plan).label} as a courtesy; ask an admin before paying for a plan.` });
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      client_reference_id: user.id,
      line_items: [{ price, quantity: 1 }],
      success_url: url("/settings/billing?checkout=success"),
      cancel_url: url("/settings/billing?checkout=canceled"),
      allow_promotion_codes: true,
      subscription_data: { metadata: { userId: user.id, plan } },
      metadata: { userId: user.id, plan, interval },
      ...(config.STRIPE_MANAGED_PAYMENTS ? { managed_payments: { enabled: true } } : {}),
    });
    if (!session.url) throw new Error("Stripe returned a Checkout Session without a URL");
    log.info({ userId: user.id, plan, interval, sessionId: session.id, managedPayments: config.STRIPE_MANAGED_PAYMENTS }, "checkout started");
    return { url: session.url, kind: "checkout" };
  }

  async function portal(user: { id: string; email: string; name: string }): Promise<{ url: string }> {
    const have = await db().query.billingCustomers.findFirst({ where: eq(schema.billingCustomers.userId, user.id) });
    if (!have) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No billing account yet: pick a plan first." });
    const session = await stripe.billingPortal.sessions.create({ customer: have.stripeCustomerId, return_url: url("/settings/billing") });
    return { url: session.url };
  }

  /**
   * The webhook endpoint's work: verify, record, queue. Returns what happened; the HTTP layer maps a
   * `SignatureError` to 400 and anything else thrown to 500 (Stripe retries).
   */
  async function recordWebhook(raw: string, signature: string | null): Promise<{ eventId: string; type: string; duplicate: boolean; queued: boolean }> {
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
        .values({ id: event.id, type: event.type, subscriptionId, created: new Date(event.created * 1000), payload: event.data.object as unknown as Record<string, unknown>, processedAt: subscriptionId ? null : new Date() })
        .onConflictDoNothing()
        .returning({ id: schema.billingEvents.id });
      if (!inserted.length) return { duplicate: true, queued: false };
      if (!subscriptionId) return { duplicate: false, queued: false };
      // same transaction as the event row: an acknowledged event always has its job
      const jobId = await u.send(SYNC_QUEUE, { subscriptionId, eventId: event.id, reason: event.type } satisfies SyncJob, { singletonKey: subscriptionId });
      // null = a sync for this subscription is already queued (exclusive policy); it will read Stripe after this event
      return { duplicate: false, queued: jobId !== null };
    });
    log[r.duplicate ? "debug" : "info"]({ eventId: event.id, type: event.type, subscriptionId, ...r }, "stripe webhook");
    return { eventId: event.id, type: event.type, ...r };
  }

  /** Which account a Stripe subscription belongs to: its metadata, else its customer, else the row that already points at it. */
  async function userIdFor(d: Db, sub: Stripe.Subscription | null, subscriptionId: string): Promise<string | null> {
    const meta = sub?.metadata?.userId;
    if (meta) return meta;
    const customerId = sub ? idOf(sub.customer as string | { id: string }) : null;
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
  async function sync(subscriptionId: string, reason = "manual"): Promise<{ userId: string | null; changed: boolean; plan: string | null; status: string | null }> {
    const slog = log.child({ subscriptionId, reason });
    let sub: Stripe.Subscription | null;
    try {
      sub = await stripe.subscriptions.retrieve(subscriptionId);
    } catch (err) {
      const e = err as Stripe.errors.StripeError;
      if (e.code === "resource_missing" || e.statusCode === 404) sub = null;
      else throw err;
    }
    const userId = await userIdFor(db(), sub, subscriptionId);
    if (!userId) {
      // nobody we know: record it so the reconcile can list orphans, then stop
      slog.warn({ customerId: sub ? idOf(sub.customer as string | { id: string }) : null }, "subscription without a Reelsaw account");
      await db()
        .update(schema.billingEvents)
        .set({ processedAt: new Date(), error: "no account for this subscription" })
        .where(and(eq(schema.billingEvents.subscriptionId, subscriptionId), isNull(schema.billingEvents.processedAt)));
      return { userId: null, changed: false, plan: null, status: null };
    }
    const mapped = sub ? mapSubscription(sub) : null;
    if (mapped?.unknownPrice) slog.error({ priceId: mapped.priceId }, "subscription price has no plan (lookup key unknown); the account gets Free until it is fixed");
    const graceDays = config.BILLING_GRACE_DAYS;
    return svc.tx(async (u) => {
      await u.db.execute(sql`select pg_advisory_xact_lock(hashtext(${`billing:${userId}`}))`);
      const [cur] = await u.db.select().from(schema.billingSubscriptions).where(eq(schema.billingSubscriptions.userId, userId)).for("update");
      const user = await u.db.query.user.findFirst({ where: eq(schema.user.id, userId), columns: { email: true } });
      const now = new Date();
      let next: Mapped | null = mapped;
      if (!next) {
        // gone at Stripe: our row for it (if that is the one) becomes canceled; another subscription's row is left alone
        if (cur?.stripeSubscriptionId !== subscriptionId) {
          await markProcessed(u, subscriptionId);
          return { userId, changed: false, plan: cur?.plan ?? null, status: cur?.status ?? null };
        }
        next = { ...cur, status: "canceled", endedAt: cur.endedAt ?? now };
      } else if (cur?.stripeSubscriptionId && cur.stripeSubscriptionId !== subscriptionId && isLive(cur.status) && cur.status !== "complimentary" && isLive(next.status)) {
        // two live Stripe subscriptions for one account (a race between two checkouts): the newer sync wins the
        // row and the operator cancels the other in Stripe; `reelsaw billing` shows both ids
        slog.error({ userId, keeping: subscriptionId, other: cur.stripeSubscriptionId }, "account has two live subscriptions");
      } else if (cur?.stripeSubscriptionId && cur.stripeSubscriptionId !== subscriptionId && !isLive(next.status) && isLive(cur.status)) {
        // an old subscription's late event must not overwrite the live one
        await markProcessed(u, subscriptionId);
        return { userId, changed: false, plan: cur.plan, status: cur.status };
      }
      const pastDueSince = next.status === "past_due" ? (cur?.status === "past_due" ? (cur.pastDueSince ?? now) : now) : null;
      const values = { ...next, userId, pastDueSince, syncedAt: now, updatedAt: now };
      await u.db
        .insert(schema.billingSubscriptions)
        .values(values)
        .onConflictDoUpdate({ target: schema.billingSubscriptions.userId, set: values });
      const before = effectivePlan(cur, graceDays, now);
      const after = effectivePlan({ ...(cur ?? ({} as BillingSubscriptionRow)), ...values, createdAt: cur?.createdAt ?? now } as BillingSubscriptionRow, graceDays, now);
      const changed = !cur || cur.status !== next.status || cur.plan !== next.plan || cur.interval !== next.interval || cur.cancelAtPeriodEnd !== next.cancelAtPeriodEnd || cur.periodEnd?.getTime() !== next.periodEnd?.getTime() || cur.stripeSubscriptionId !== next.stripeSubscriptionId;
      const email = user?.email ?? "";
      const base = { actorId: null, userId, email };
      const ids = { subscriptionId, plan: next.plan, interval: next.interval, status: next.status };
      const audit = async (type: "billing.subscribed" | "billing.changed" | "billing.payment_failed" | "billing.canceled", payload: Record<string, unknown>) => {
        await u.db.insert(schema.adminEvents).values({ ...base, type, payload });
        u.afterCommit(() => svc.telemetry.capture(type, userId, { plan: next!.plan, interval: next!.interval, status: next!.status }));
      };
      if ((!cur || !isLive(cur.status)) && isLive(next.status)) await audit("billing.subscribed", ids);
      else if (cur && isLive(cur.status) && isLive(next.status) && (cur.plan !== next.plan || cur.interval !== next.interval)) await audit("billing.changed", { ...ids, from: { plan: cur.plan, interval: cur.interval } });
      if (cur?.status !== "past_due" && next.status === "past_due") await audit("billing.payment_failed", { ...ids, graceEndsAt: new Date(now.getTime() + graceDays * 86_400_000).toISOString() });
      if ((cur && isLive(cur.status) && !isLive(next.status)) || (!cur?.cancelAtPeriodEnd && next.cancelAtPeriodEnd)) await audit("billing.canceled", { ...ids, endsAt: (next.cancelAtPeriodEnd ? next.periodEnd : (next.endedAt ?? now))?.toISOString() ?? null });
      await markProcessed(u, subscriptionId);
      u.afterCommit(() => slog[changed ? "info" : "debug"]({ userId, plan: next!.plan, status: next!.status, effective: after.plan.name, was: before.plan.name, cancelAtPeriodEnd: next!.cancelAtPeriodEnd }, changed ? "subscription synced" : "subscription unchanged"));
      return { userId, changed, plan: next.plan, status: next.status };
    });
  }

  const markProcessed = (u: UnitOfWork, subscriptionId: string) =>
    u.db
      .update(schema.billingEvents)
      .set({ processedAt: new Date(), error: null })
      .where(and(eq(schema.billingEvents.subscriptionId, subscriptionId), isNull(schema.billingEvents.processedAt)));

  /**
   * Walk Stripe and our rows and sync whatever disagrees. Bounded pages; one subscription at a time. Returns
   * what it looked at, so the CLI and the log say more than "done".
   */
  async function reconcile(opts: { userId?: string } = {}): Promise<{ checked: number; synced: number; orphans: string[]; pendingEvents: number }> {
    const d = db();
    const out = { checked: 0, synced: 0, orphans: [] as string[], pendingEvents: 0 };
    const seen = new Set<string>();
    const wanted = opts.userId ? await entitlements.rowFor(d, opts.userId) : null;
    if (opts.userId && !wanted?.stripeSubscriptionId) {
      // no Stripe subscription recorded: maybe a checkout whose webhook was lost; look the customer up
      const c = await d.query.billingCustomers.findFirst({ where: eq(schema.billingCustomers.userId, opts.userId) });
      if (c) for await (const s of stripe.subscriptions.list({ customer: c.stripeCustomerId, status: "all", limit: 20 })) {
        out.checked++;
        const r = await sync(s.id, "reconcile");
        if (r.changed) out.synced++;
      }
      return out;
    }
    const list = opts.userId ? stripe.subscriptions.list({ customer: wanted!.stripeCustomerId!, status: "all", limit: 20 }) : stripe.subscriptions.list({ status: "all", limit: 100 });
    for await (const s of list) {
      out.checked++;
      seen.add(s.id);
      const row = await d.query.billingSubscriptions.findFirst({ where: eq(schema.billingSubscriptions.stripeSubscriptionId, s.id) });
      const m = mapSubscription(s);
      const differs = !row || row.status !== m.status || row.plan !== m.plan || row.cancelAtPeriodEnd !== m.cancelAtPeriodEnd || row.periodEnd?.getTime() !== m.periodEnd?.getTime();
      if (!differs) continue;
      if (!row && !isLive(m.status)) continue; // an old, ended subscription we never recorded: nothing to grant
      const r = await sync(s.id, "reconcile");
      if (!r.userId) out.orphans.push(s.id);
      else if (r.changed) out.synced++;
    }
    if (!opts.userId) {
      // rows that point at a subscription Stripe no longer lists (deleted test data, a different account's key)
      const rows = await d.select({ id: schema.billingSubscriptions.stripeSubscriptionId }).from(schema.billingSubscriptions).where(sql`${schema.billingSubscriptions.stripeSubscriptionId} is not null`);
      for (const r of rows) if (r.id && !seen.has(r.id)) {
        out.checked++;
        if ((await sync(r.id, "reconcile")).changed) out.synced++;
      }
      // events acknowledged but never processed (a sync that kept failing): try again
      const pending = await d.select({ id: schema.billingEvents.subscriptionId }).from(schema.billingEvents).where(and(isNull(schema.billingEvents.processedAt), lt(schema.billingEvents.receivedAt, new Date(Date.now() - 3_600_000)))).limit(500);
      const ids = [...new Set(pending.map((p) => p.id).filter((x): x is string => !!x))];
      out.pendingEvents = ids.length;
      for (const id of ids) if ((await sync(id, "reconcile")).changed) out.synced++;
    }
    log.info(out, "billing reconcile");
    return out;
  }

  /** The queues exist in every process (the API process sends to them from the webhook); workers alone consume them. */
  async function ensureQueues() {
    const { boss } = svc.queue;
    await boss.createQueue(SYNC_QUEUE, { policy: "exclusive", retryLimit: 8, retryDelay: 30, retryBackoff: true, expireInSeconds: 300, deleteAfterSeconds: 7 * 24 * 3600 });
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
    const [usage, watermark, customer] = await Promise.all([limitUsage(d, user.id, detail.grants), watermarkFor(d, svc.settings.get(), user, entitlements), d.query.billingCustomers.findFirst({ where: eq(schema.billingCustomers.userId, user.id) })]);
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
      await u.db.execute(sql`select pg_advisory_xact_lock(hashtext(${`billing:${userId}`}))`);
      const user = await u.db.query.user.findFirst({ where: eq(schema.user.id, userId), columns: { email: true } });
      if (!user) throw new TRPCError({ code: "NOT_FOUND", message: "No such user" });
      const [cur] = await u.db.select().from(schema.billingSubscriptions).where(eq(schema.billingSubscriptions.userId, userId)).for("update");
      if (cur?.stripeSubscriptionId && isLive(cur.status)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This account pays through Stripe; cancel that subscription in Stripe first." });
      const now = new Date();
      if (plan) {
        const values = { userId, stripeSubscriptionId: null, stripeCustomerId: cur?.stripeCustomerId ?? null, plan, status: "complimentary" as const, interval: null, priceId: null, periodStart: null, periodEnd: null, cancelAtPeriodEnd: false, pastDueSince: null, endedAt: null, syncedAt: now, updatedAt: now };
        await u.db.insert(schema.billingSubscriptions).values(values).onConflictDoUpdate({ target: schema.billingSubscriptions.userId, set: values });
      } else if (cur) await u.db.delete(schema.billingSubscriptions).where(eq(schema.billingSubscriptions.userId, userId));
      await u.db.insert(schema.adminEvents).values({ type: "billing.complimentary", actorId, userId, email: user.email, payload: { plan, from: cur?.plan ?? null } });
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
        log.error({ err, userId, subscriptionId: row?.stripeSubscriptionId ?? null }, "could not cancel the removed account's subscription at Stripe; cancel it by hand");
      }
    };
  }

  /** `reelsaw billing <user>`: the row, the customer, and Stripe's view side by side. */
  async function inspect(userId: string) {
    const d = db();
    const [row, customer] = await Promise.all([entitlements.rowFor(d, userId), d.query.billingCustomers.findFirst({ where: eq(schema.billingCustomers.userId, userId) })]);
    const stripeSubs = customer ? (await stripe.subscriptions.list({ customer: customer.stripeCustomerId, status: "all", limit: 10 })).data.map((s) => ({ id: s.id, status: s.status, price: s.items.data[0]?.price.lookup_key ?? s.items.data[0]?.price.id ?? null, cancelAtPeriodEnd: s.cancel_at_period_end })) : [];
    const events = await d.select({ id: schema.billingEvents.id, type: schema.billingEvents.type, created: schema.billingEvents.created, processedAt: schema.billingEvents.processedAt, error: schema.billingEvents.error }).from(schema.billingEvents).where(row?.stripeSubscriptionId ? eq(schema.billingEvents.subscriptionId, row.stripeSubscriptionId) : sql`false`).orderBy(sql`${schema.billingEvents.created} desc`).limit(20);
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
