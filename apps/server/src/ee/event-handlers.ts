/**
 * The enterprise edition's event handlers (see LICENSE in this folder). services.ts loads this map after the
 * open one (event-handler-map.ts) when REELSAW_EE is on, so their queues exist and their jobs commit with
 * their events exactly like the open handlers'. A self-hosted boot never imports it.
 */
import { defineEventHandlers, type EventHandler } from "../event-handlers.js";

/** `billing.detached` (a removed account had a Stripe customer or live subscription) → cancel it at Stripe. */
export const cancelAtStripe: EventHandler<"billing.detached"> = {
  handle: async ({ event, svc, idempotencyKey }) => {
    // the job outlived a boot without REELSAW_EE: fail it, so it is retried once billing is back
    if (!svc.ee) throw new Error("billing.detached needs the enterprise edition (REELSAW_EE)");
    await svc.ee.billing.cancelDetached(event.payload, idempotencyKey, event.userId);
  },
};

export const eeEventHandlerMap = defineEventHandlers({
  "billing.detached": { cancelAtStripe },
});
