/**
 * Mail that follows an account event (account-events.ts), as event handlers listed in
 * event-handler-map.ts: each job commits with the event that asks for it and retries until the
 * provider takes the mail, so a crash or a provider outage right after the change cannot lose it
 * (an `afterCommit` send could). Nothing is queued when the instance sends no mail.
 *
 * Each handler reads the account when it runs, not when it was queued: a removed or suspended account
 * gets nothing, and a sign-up approved before its admin note went out needs no note. The idempotency
 * key is the job's (`event.<type>.<name>:<event id>`), so Resend drops the repeat of a retried send.
 */
import { eq } from "drizzle-orm";
import { schema } from "../db/index.js";
import { templates } from "../email.js";
import type { EventHandler, EventHandlerDeps } from "../event-handlers.js";
import type { Services } from "../services.js";

const whenMailOn = (deps: EventHandlerDeps, key: string) => (deps.email.enabled ? key : null);

/** The account as it is now, if it may still be mailed. */
async function mailable(svc: Services, userId: string) {
  const user = await svc.database.db.query.user.findFirst({
    where: eq(schema.user.id, userId),
    columns: { email: true, name: true, banned: true, approvedAt: true },
  });
  return user && !user.banned ? user : null;
}

/** `user.approved` → "Your Reelsaw account is ready" to the account. */
export const approvedEmail: EventHandler<"user.approved"> = {
  key: ({ event, deps }) => whenMailOn(deps, String(event.id)),
  handle: async ({ event, svc, idempotencyKey }) => {
    const user = await mailable(svc, event.userId);
    if (!user?.approvedAt) return;
    await svc.email.send({ to: user.email, ...templates.approved(svc.config.APP_URL) }, { strict: true, idempotencyKey });
  },
};

/** `user.signed_up` waiting for approval → "<name> is waiting for approval" to every admin. */
export const approvalRequestEmail: EventHandler<"user.signed_up"> = {
  key: ({ event, deps }) => (event.payload.approved ? null : whenMailOn(deps, String(event.id))),
  handle: async ({ event, svc, idempotencyKey }) => {
    const user = await svc.database.db.query.user.findFirst({
      where: eq(schema.user.id, event.userId),
      columns: { email: true, name: true, approvedAt: true },
    });
    // removed, or already approved (an admin got to it, or the first-admin race promoted it): nothing to ask
    if (!user || user.approvedAt) return;
    const admins = await svc.database.db.query.user.findMany({ where: eq(schema.user.role, "admin"), columns: { id: true, email: true } });
    // one key per admin: a retry after the second admin's send failed does not mail the first one twice
    for (const a of admins)
      await svc.email.send(
        { to: a.email, ...templates.waitingForApproval(svc.config.APP_URL, user.name, user.email) },
        { strict: true, idempotencyKey: `${idempotencyKey}:${a.id}` },
      );
  },
};

/** `webhook.disabled` → "A Reelsaw webhook was turned off" to the endpoint's owner. */
export const webhookDisabledEmail: EventHandler<"webhook.disabled"> = {
  key: ({ event, deps }) => whenMailOn(deps, String(event.id)),
  handle: async ({ event, svc, idempotencyKey }) => {
    const user = await mailable(svc, event.userId);
    if (!user) return;
    await svc.email.send(
      { to: user.email, ...templates.webhookDisabled(svc.config.APP_URL, event.payload.url, event.payload.reason) },
      { strict: true, idempotencyKey },
    );
  },
};
