/**
 * The enterprise edition's event handlers (see LICENSE in this folder). services.ts loads this map after the
 * open one (event-handler-map.ts) when REELSAW_EE is on, so their queues exist and their jobs commit with
 * their events exactly like the open handlers'. A self-hosted boot never imports it.
 */
import { defineEventHandlers, type EventHandler } from "../event-handlers.js";

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
});
