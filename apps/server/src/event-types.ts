/**
 * Every event type and its payload schema: one registry for the one `events` table (`u.emit`).
 *
 * A project event (`PROJECT_EVENT_TYPES`, schemas in @reelsaw/shared, which the web reads too) names
 * its project in the payload; it is the project's history (activity feed, live stream, webhooks). An
 * account event names its account and the address it had then: something that happened to an account
 * (a sign-up, an approval, a webhook turned off, a subscription detached) or to the instance, recorded
 * against the account that did it (settings, models). The row's subject columns, `project_id` and
 * `user_id`, are read from the payload (`eventSubject`), so no emit site passes them twice.
 *
 * Types that handlers read are spelled out; the rest stay a loose object until a handler needs them
 * (the admin page only lists them), and are tightened then.
 */
import { PROJECT_EVENT_TYPES, projectEventSchemas, type ProjectEventType } from "@reelsaw/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

/** Events with no project: about an account, or the instance (recorded against the account that acted). */
export const ACCOUNT_EVENT_TYPES = [
  "user.signed_up",
  "user.approved",
  /** an admin sent an active account back to waiting for approval (accounts.ts holdUser) */
  "user.held",
  "user.role_changed",
  "user.limits_changed",
  "user.watermark_changed",
  "user.flagged",
  "user.banned",
  "user.unbanned",
  "user.removed",
  "user.password_set",
  "webhook.disabled",
  "models.changed",
  "provider.changed",
  "settings.changed",
  /** sign-up rules added or removed (signup-rules.ts), recorded against the admin who did it */
  "signup_rules.changed",
  "failures.retried",
  // billing (ee/): written by the subscription sync, never by a webhook handler directly
  "billing.subscribed",
  "billing.changed",
  "billing.payment_failed",
  "billing.canceled",
  "billing.complimentary",
  "billing.unknown_price",
  /** an account with a Stripe customer or live subscription was removed; ee/ cancels it at Stripe */
  "billing.detached",
] as const;
export type AccountEventType = (typeof ACCOUNT_EVENT_TYPES)[number];

/** The account an account event is about, and its address then (kept after the account is gone). */
const account = z.object({ userId: z.string(), email: z.string() });
const loose = account.catchall(z.unknown());

const accountEventSchemas = {
  "user.signed_up": account.extend({
    role: z.string(),
    approved: z.boolean(),
    mode: z.string(),
    /** the sign-up rule that decided it ("ip 203.0.113.0/24"), and what it did; absent when none matched */
    rule: z.string().optional(),
    ruleAction: z.enum(["hold", "allow"]).optional(),
  }),
  /** approvedAt names the approval (absent on events from before holdUser existed) */
  "user.approved": account.extend({ approvedAt: z.string().optional() }),
  "user.held": loose,
  "user.role_changed": loose,
  "user.limits_changed": loose,
  "user.watermark_changed": loose,
  "user.flagged": loose,
  "user.banned": loose,
  "user.unbanned": loose,
  "user.removed": loose,
  "user.password_set": loose,
  /** deliveries kept failing (or the receiver said 410), so the endpoint was switched off (webhooks/deliver.ts) */
  "webhook.disabled": account.extend({ endpointId: z.string(), url: z.string(), reason: z.string(), disabledAt: z.string() }),
  "models.changed": loose,
  "provider.changed": loose,
  "settings.changed": loose,
  "signup_rules.changed": loose,
  "failures.retried": loose,
  "billing.subscribed": loose,
  "billing.changed": loose,
  "billing.payment_failed": loose,
  "billing.canceled": loose,
  "billing.complimentary": loose,
  "billing.unknown_price": loose,
  /** what to cancel at Stripe; null when there is nothing (ee/billing/service.ts detachUser) */
  "billing.detached": account.extend({ subscriptionId: z.string().nullable(), customerId: z.string().nullable(), removedAt: z.string() }),
} satisfies Record<AccountEventType, z.ZodType>;

export const EVENT_TYPES = [...PROJECT_EVENT_TYPES, ...ACCOUNT_EVENT_TYPES] as const;
export type EventType = ProjectEventType | AccountEventType;
export const eventSchemas = { ...projectEventSchemas, ...accountEventSchemas } satisfies Record<EventType, z.ZodType>;
export type EventPayload<T extends EventType> = z.infer<(typeof eventSchemas)[T]>;

export function isProjectEventType(t: string): t is ProjectEventType {
  return PROJECT_EVENT_TYPES.some((x) => x === t);
}

export function isEventType(t: string): t is EventType {
  return EVENT_TYPES.some((x) => x === t);
}

/** The row's subject columns, from the payload: `projectId` on a project event, `userId` on an account event. */
export function eventSubject(payload: object): { projectId: string | null; userId: string | null } {
  const str = (k: string) => {
    const v = Object.entries(payload).find(([key]) => key === k)?.[1];
    return typeof v === "string" ? v : null;
  };
  return { projectId: str("projectId"), userId: str("userId") };
}

/**
 * The `events` row for an event: its subject columns from the payload, and a project event's account
 * as the project's owner. `u.emit` writes it with the event's handlers; code with no unit of work
 * (instance settings, model changes) writes it directly, and then no handler runs.
 */
export function eventRow<T extends EventType>(type: T, payload: EventPayload<T>, actorId: string | null) {
  const { projectId, userId } = eventSubject(payload);
  return {
    type,
    projectId,
    userId: userId ?? (projectId ? sql<string>`(select user_id from projects where id = ${projectId})` : null),
    actorId,
    payload,
  };
}
