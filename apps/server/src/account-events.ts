/**
 * Account events: the `admin_events` rows (sign-ups, approvals, bans, billing, a webhook turned off),
 * the account-level counterpart of a project's `project_events`. Written with `u.emitAccount` in a unit
 * of work, so the handlers that follow an event (event-handler-map.ts) commit with it, exactly as
 * `u.emit` does for project events.
 *
 * Each type has a zod schema here. Types that handlers read are spelled out; the rest stay a loose
 * record until a handler needs them (the admin page only lists them), and are tightened then.
 */
import { z } from "zod";
import { ADMIN_EVENT_TYPES, type AdminEventType } from "./db/schema.js";

export const ACCOUNT_EVENT_TYPES = ADMIN_EVENT_TYPES;
export type AccountEventType = AdminEventType;

const untyped = z.record(z.string(), z.unknown());

export const accountEventSchemas = {
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
} satisfies Record<AccountEventType, z.ZodType>;

export type AccountEventPayload<T extends AccountEventType> = z.infer<(typeof accountEventSchemas)[T]>;

export function isAccountEventType(t: string): t is AccountEventType {
  return ACCOUNT_EVENT_TYPES.some((x) => x === t);
}
