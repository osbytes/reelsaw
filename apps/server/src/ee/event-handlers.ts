/**
 * The enterprise edition's event handlers (see LICENSE in this folder). services.ts loads this map after the
 * open one (event-handler-map.ts) when REELSAW_EE is on, so their queues exist and their jobs commit with
 * their events exactly like the open handlers'. A self-hosted boot never imports it.
 */
import { eq } from "drizzle-orm";
import { billingPath, formatDay } from "@reelsaw/shared";
import { schema } from "../db/index.js";
import { templates } from "../email.js";
import { defineEventHandlers, type EventHandler } from "../event-handlers.js";
import { retryRefusedWork } from "../ops/failures.js";
import { LIVE_STATUSES, pendingCancelAt } from "./billing/entitlements.js";
import { planOf } from "./billing/plans.js";

/**
 * `billing.cancel_scheduled` → "Your <plan> plan ends on <day>" with what Free will refuse then; once per
 * event, so cancelling again after taking it back mails again. Read when it runs: a cancellation taken back or
 * moved since has its own event.
 */
export const cancelScheduledEmail: EventHandler<"billing.cancel_scheduled"> = {
  key: ({ event, deps }) => (deps.email.enabled ? `cancel-scheduled:${event.id}` : null),
  handle: async ({ event, key, svc }) => {
    if (!svc.ee) throw new Error("billing.cancel_scheduled needs the enterprise edition (REELSAW_EE)");
    const { userId, subscriptionId, endsAt } = event.payload;
    const user = await svc.database.db.query.user.findFirst({ where: eq(schema.user.id, userId), columns: { email: true, banned: true, role: true } });
    if (!user || user.banned) return;
    const row = await svc.ee.billing.entitlements.rowFor(svc.database.db, userId);
    if (!row || row.stripeSubscriptionId !== subscriptionId || pendingCancelAt(row, svc.config.BILLING_GRACE_DAYS)?.toISOString() !== endsAt) return;
    const preview = await svc.ee.billing.freePreview({ id: userId, role: user.role }, new Date(endsAt));
    const mail = templates.planEnding(
      new URL(billingPath(), svc.config.APP_URL).toString(),
      planOf(row.plan).label,
      formatDay(endsAt, { utc: true }),
      preview.over.map((o) => o.sentence),
      preview.expect,
    );
    await svc.email.send({ to: user.email, ...mail }, { strict: true, idempotencyKey: key });
  },
};

/** `billing.canceled` (the subscription ended) → "You're on Free now" with where the account is over Free's limits and what else changed; once per subscription. */
export const planEndedEmail: EventHandler<"billing.canceled"> = {
  key: ({ event, deps }) => (deps.email.enabled ? `plan-ended:${event.payload.subscriptionId}` : null),
  handle: async ({ event, key, svc }) => {
    if (!svc.ee) throw new Error("billing.canceled needs the enterprise edition (REELSAW_EE)");
    const { userId, plan } = event.payload;
    const user = await svc.database.db.query.user.findFirst({ where: eq(schema.user.id, userId), columns: { email: true, banned: true, role: true } });
    if (!user || user.banned) return;
    // subscribed again (or granted a plan) since: nothing ended for them
    const row = await svc.ee.billing.entitlements.rowFor(svc.database.db, userId);
    if (row && LIVE_STATUSES.has(row.status)) return;
    const preview = await svc.ee.billing.freePreview({ id: userId, role: user.role }, new Date());
    const mail = templates.planEnded(
      new URL(billingPath(), svc.config.APP_URL).toString(),
      planOf(plan).label,
      preview.over.map((o) => o.sentence),
      preview.expect,
    );
    await svc.email.send({ to: user.email, ...mail }, { strict: true, idempotencyKey: key });
  },
};

/**
 * `billing.detached` (a removed account had a Stripe customer or live subscription) → cancel it at Stripe.
 * Keyed by the account, which is detached once; its Stripe calls carry keys naming the subscription and the
 * customer (billing/service.ts cancelDetached), so a second event about the same removal is the same cancel.
 */
export const cancelAtStripe: EventHandler<"billing.detached"> = {
  key: ({ event }) => `detached:${event.payload.userId}`,
  handle: async ({ event, svc }) => {
    // the job outlived a boot without REELSAW_EE: fail it, so it is retried once billing is back
    if (!svc.ee) throw new Error("billing.detached needs the enterprise edition (REELSAW_EE)");
    await svc.ee.billing.cancelDetached(event.payload);
  },
};

export const eeEventHandlerMap = defineEventHandlers({
  "billing.detached": { cancelAtStripe },
  // a new or changed plan (or an admin's grant): resume the videos the old plan refused
  "billing.subscribed": { retryRefusedWork: retryRefusedWork<"billing.subscribed">() },
  "billing.changed": { retryRefusedWork: retryRefusedWork<"billing.changed">() },
  "billing.complimentary": { retryRefusedWork: retryRefusedWork<"billing.complimentary">() },
  // a cancellation scheduled, and the plan actually ending: tell the account what Free will refuse
  "billing.cancel_scheduled": { cancelScheduledEmail },
  "billing.canceled": { planEndedEmail },
});
