/**
 * Events (the `events` table): the shared outbox for anything that is not a project's own history,
 * which stays in `project_events` (`u.emit`). An account signed up or was approved, a webhook was
 * turned off, a subscription was detached. Written with `u.emitEvent` in a unit of work, so the handlers
 * that follow an event (event-handler-map.ts) commit with it, exactly as for project events.
 *
 * Each type has a zod schema here. Types that handlers read are spelled out; the rest stay a loose
 * record until a handler needs them (the admin page only lists them), and are tightened then.
 */
import { z } from "zod";
import { EVENT_TYPES, type EventType } from "./db/schema.js";

export { EVENT_TYPES, type EventType };

const untyped = z.record(z.string(), z.unknown());

export const eventSchemas = {
  "user.signed_up": z.object({ role: z.string(), approved: z.boolean(), mode: z.string() }),
  "user.approved": z.object({}),
  "user.role_changed": untyped,
  "user.limits_changed": untyped,
  "user.watermark_changed": untyped,
  "user.flagged": untyped,
  "user.banned": untyped,
  "user.unbanned": untyped,
  "user.removed": untyped,
  "user.password_set": untyped,
  /** deliveries kept failing (or the receiver said 410), so the endpoint was switched off (webhooks/deliver.ts) */
  "webhook.disabled": z.object({ endpointId: z.string(), url: z.string(), reason: z.string() }),
  "models.changed": untyped,
  "provider.changed": untyped,
  "settings.changed": untyped,
  "failures.retried": untyped,
  "billing.subscribed": untyped,
  "billing.changed": untyped,
  "billing.payment_failed": untyped,
  "billing.canceled": untyped,
  "billing.complimentary": untyped,
  "billing.unknown_price": untyped,
  /** what to cancel at Stripe; null when there is nothing (ee/billing/service.ts detachUser) */
  "billing.detached": z.object({ subscriptionId: z.string().nullable(), customerId: z.string().nullable(), removedAt: z.string() }),
} satisfies Record<EventType, z.ZodType>;

export type EventPayload<T extends EventType> = z.infer<(typeof eventSchemas)[T]>;

export function isEventType(t: string): t is EventType {
  return EVENT_TYPES.some((x) => x === t);
}
