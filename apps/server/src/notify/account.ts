/**
 * Mail that follows an account event (event-types.ts), as event handlers listed in
 * event-handler-map.ts: each job commits with the event that asks for it and retries until the
 * provider takes the mail, so a crash or a provider outage right after the change cannot lose it
 * (an `afterCommit` send could). Nothing is queued when the instance sends no mail.
 *
 * Each handler reads the account when it runs, not when it was queued: a removed or suspended account
 * gets nothing, and a sign-up approved before its admin note went out needs no note.
 *
 * Each key (the job's, and the idempotency key Resend gets) names what the mail is about, not the
 * event or the job: an account is approved once, so `approved:<account>`; a webhook is turned off once
 * per time it failed, so `webhook-disabled:<endpoint>:<when>`. A second event about the same thing (a
 * retried transition, a replayed job) is then the same mail, and Resend drops it.
 */
import { eq } from "drizzle-orm";
import { schema } from "../db/index.js";
import { templates } from "../email.js";
import type { EventHandler } from "../event-handlers.js";

/** `user.approved` → "Your Reelsaw account is ready" to the account; once per account. */
export const approvedEmail: EventHandler<"user.approved"> = {
  key: ({ event, deps }) => (deps.email.enabled ? `approved:${event.payload.userId}` : null),
  handle: async ({ event, key, svc }) => {
    const user = await svc.database.db.query.user.findFirst({
      where: eq(schema.user.id, event.payload.userId),
      columns: { email: true, banned: true, approvedAt: true },
    });
    // removed, suspended, or no longer approved: nothing to say
    if (!user || user.banned || !user.approvedAt) return;
    await svc.email.send({ to: user.email, ...templates.approved(svc.config.APP_URL) }, { strict: true, idempotencyKey: key });
  },
};

/** `user.signed_up` waiting for approval → "<name> is waiting for approval" to every admin; once per sign-up and admin. */
export const approvalRequestEmail: EventHandler<"user.signed_up"> = {
  key: ({ event, deps }) => (deps.email.enabled && !event.payload.approved ? `approval-request:${event.payload.userId}` : null),
  handle: async ({ event, key, svc }) => {
    const user = await svc.database.db.query.user.findFirst({
      where: eq(schema.user.id, event.payload.userId),
      columns: { email: true, name: true, approvedAt: true },
    });
    // removed, or already approved (an admin got to it, or the first-admin race promoted it): nothing to ask
    if (!user || user.approvedAt) return;
    const admins = await svc.database.db.query.user.findMany({ where: eq(schema.user.role, "admin"), columns: { id: true, email: true } });
    // one key per admin: a retry after the second admin's send failed does not mail the first one twice
    for (const a of admins)
      await svc.email.send(
        { to: a.email, ...templates.waitingForApproval(svc.config.APP_URL, user.name, user.email) },
        { strict: true, idempotencyKey: `${key}:${a.id}` },
      );
  },
};

/** `webhook.disabled` → "A Reelsaw webhook was turned off" to the endpoint's owner; once per endpoint and turn-off. */
export const webhookDisabledEmail: EventHandler<"webhook.disabled"> = {
  key: ({ event, deps }) => (deps.email.enabled ? `webhook-disabled:${event.payload.endpointId}:${event.payload.disabledAt}` : null),
  handle: async ({ event, key, svc }) => {
    const user = await svc.database.db.query.user.findFirst({ where: eq(schema.user.id, event.payload.userId), columns: { email: true, banned: true } });
    // removed or suspended: nothing to say
    if (!user || user.banned) return;
    await svc.email.send(
      { to: user.email, ...templates.webhookDisabled(svc.config.APP_URL, event.payload.url, event.payload.reason) },
      { strict: true, idempotencyKey: key },
    );
  },
};
