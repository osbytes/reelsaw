/**
 * Sending a webhook delivery (docs/specs/webhooks.md, "Delivery job"): claim the row, build the body once, sign it
 * (Standard Webhooks), POST it through the SSRF guard with no redirects and a 10 s limit, record the outcome, and
 * schedule the next attempt (30 s, 2 min, 10 min, 1 h, 3 h, 6 h, 12 h). A 410 turns the endpoint off at once; 3 days
 * of failures (5 or more) turn it off and email the owner. Each attempt is its own `webhooks.deliver` job.
 */
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { Webhook } from "standardwebhooks";
import { schema } from "../db/index.js";
import type { WebhookDeliveryRow } from "../db/schema.js";
import { templates } from "../email.js";
import { bodyChunks, fetchPublic, TooManyRedirectsError, UnsafeUrlError, type FetchPublicOptions } from "../lib/safe-url.js";
import { WEBHOOK_QUEUE } from "../queue/boss.js";
import type { Services } from "../services.js";
import { buildBody } from "./payload.js";
import { cancelPending, maskWebhookUrl, signingSecrets, webhookEventId } from "./service.js";

/** Seconds before attempt 2, 3, …; 8 attempts over about 22 h. */
export const RETRY_DELAYS_SEC = [30, 120, 600, 3600, 3 * 3600, 6 * 3600, 12 * 3600] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_SEC.length + 1;
export const SEND_TIMEOUT_MS = 10_000;
const RESPONSE_EXCERPT = 2048;
/** an endpoint failing this long, with at least this many failed deliveries, is turned off */
export const DISABLE_AFTER_MS = 3 * 86_400_000;
export const DISABLE_MIN_FAILURES = 5;
/** a delivery stuck in `sending` this long belonged to a process that died mid-send */
const STUCK_MS = 5 * 60_000;

/** Seconds to wait before the next attempt after `attempt` attempts failed; null = that was the last. */
export function nextDelaySec(attempt: number): number | null {
  return RETRY_DELAYS_SEC[attempt - 1] ?? null;
}

export interface SendResult {
  ok: boolean;
  code: number | null;
  /** a sentence for the delivery log */
  error: string | null;
  response: string | null;
}

/** The three Standard Webhooks headers; during a rotation the signature header carries both signatures. */
export function signedHeaders(secrets: string[], msgId: string, at: Date, body: string, version: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": `Reelsaw-Webhooks/${version}`,
    "webhook-id": msgId,
    "webhook-timestamp": String(Math.floor(at.getTime() / 1000)),
    "webhook-signature": secrets.map((s) => new Webhook(s).sign(msgId, at, body)).join(" "),
  };
}

/** POST once. Never throws for the receiver's sake: every outcome is a SendResult. */
export async function postOnce(
  url: string,
  body: string,
  headers: Record<string, string>,
  opts: { allowPrivate: boolean; fetch?: FetchPublicOptions["fetch"] },
): Promise<SendResult> {
  try {
    const { res } = await fetchPublic(url, {
      method: "POST",
      body,
      headers,
      maxRedirects: 0,
      allowPrivate: opts.allowPrivate,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    let excerpt = "";
    for await (const chunk of bodyChunks(res)) {
      excerpt += Buffer.from(chunk).toString("utf8");
      if (excerpt.length >= RESPONSE_EXCERPT) break;
    }
    const response = excerpt.slice(0, RESPONSE_EXCERPT) || null;
    if (res.ok) return { ok: true, code: res.status, error: null, response };
    const redirect = res.status >= 300 && res.status < 400;
    return {
      ok: false,
      code: res.status,
      error: redirect ? `Answered ${res.status} without a Location; webhooks do not follow redirects.` : `Answered ${res.status}.`,
      response,
    };
  } catch (err) {
    if (err instanceof TooManyRedirectsError)
      return { ok: false, code: null, error: "Answered with a redirect; webhooks do not follow redirects. Use the final URL.", response: null };
    if (err instanceof UnsafeUrlError) return { ok: false, code: null, error: err.message.replace("as a source", "for a webhook"), response: null };
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError")
      return { ok: false, code: null, error: `Timed out after ${SEND_TIMEOUT_MS / 1000} s.`, response: null };
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : err instanceof Error ? err.message : String(err);
    return { ok: false, code: null, error: `Could not connect: ${cause.slice(0, 200)}`, response: null };
  }
}

export interface DeliverOptions {
  /** tests: instead of the network */
  fetch?: FetchPublicOptions["fetch"];
  now?: () => Date;
}

/**
 * One attempt at a delivery. The claim is a conditional update, so a job that runs twice (or early) sends once per
 * attempt; a job for a delivery that is not due yet, already sent, or cancelled exits.
 */
export async function deliverOnce(svc: Services, deliveryId: number, opts: DeliverOptions = {}): Promise<WebhookDeliveryRow | null> {
  const db = svc.database.db;
  const now = opts.now?.() ?? new Date();
  const log = svc.log.child({ module: "webhooks", deliveryId });
  const [d] = await db
    .update(schema.webhookDeliveries)
    .set({ status: "sending", attempt: sql`${schema.webhookDeliveries.attempt} + 1`, nextAttemptAt: now })
    .where(
      and(
        eq(schema.webhookDeliveries.id, deliveryId),
        eq(schema.webhookDeliveries.status, "pending"),
        sql`coalesce(${schema.webhookDeliveries.nextAttemptAt}, now()) <= ${new Date(now.getTime() + 5000)}`,
      ),
    )
    .returning();
  if (!d) return null;
  // attempts that threw (see recordSendError) or were requeued by the sweep still count: give up like any other
  if (d.attempt > MAX_ATTEMPTS) {
    const [row] = await db
      .update(schema.webhookDeliveries)
      .set({ status: "failed", nextAttemptAt: null, lastError: d.lastError ?? `Gave up after ${MAX_ATTEMPTS} attempts.` })
      .where(eq(schema.webhookDeliveries.id, d.id))
      .returning();
    log.warn({ endpointId: d.endpointId, userId: d.userId, attempt: d.attempt }, "webhook delivery given up");
    return row ?? null;
  }
  const e = await db.query.webhookEndpoints.findFirst({ where: eq(schema.webhookEndpoints.id, d.endpointId) });
  if (!e?.enabled) {
    await db.update(schema.webhookDeliveries).set({ status: "cancelled", nextAttemptAt: null }).where(eq(schema.webhookDeliveries.id, d.id));
    return null;
  }
  const ids = { endpointId: e.id, userId: d.userId, projectId: d.projectId, eventId: d.eventId, type: d.type, attempt: d.attempt };
  let body = d.body;
  if (body === null) {
    body = await buildBody(svc, d);
    await db.update(schema.webhookDeliveries).set({ body }).where(eq(schema.webhookDeliveries.id, d.id));
  }
  log.debug({ ...ids, url: maskWebhookUrl(e.url) }, "webhook sending");
  const headers = signedHeaders(signingSecrets(svc, e, now.getTime()), webhookEventId(d), now, body, svc.config.REELSAW_VERSION);
  const r = await postOnce(e.url, body, headers, { allowPrivate: svc.settings.get().ALLOW_PRIVATE_WEBHOOK_URLS, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const test = d.type === "webhook.test";

  if (r.ok) {
    const [row] = await svc.tx(async (u) => {
      const out = await u.db
        .update(schema.webhookDeliveries)
        .set({ status: "delivered", deliveredAt: now, lastStatusCode: r.code, lastError: null, lastResponse: r.response, nextAttemptAt: null })
        .where(eq(schema.webhookDeliveries.id, d.id))
        .returning();
      await u.db.update(schema.webhookEndpoints).set({ failingSince: null }).where(eq(schema.webhookEndpoints.id, e.id));
      return out;
    });
    log.info({ ...ids, code: r.code }, "webhook delivered");
    return row ?? null;
  }

  const gone = r.code === 410;
  const delay = gone || test ? null : nextDelaySec(d.attempt);
  let disabled: string | null = null;
  const [row] = await svc.tx(async (u) => {
    const [ep] = await u.db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, e.id)).for("update");
    const failingSince = ep?.failingSince ?? (test ? null : now);
    if (gone) disabled = "The receiver said this URL is gone (410).";
    // a test never turns an endpoint off (nor counts toward it); only real deliveries do
    else if (!test && ep?.enabled && failingSince && now.getTime() - failingSince.getTime() >= DISABLE_AFTER_MS) {
      const [{ n } = { n: 0 }] = await u.db
        .select({ n: count() })
        .from(schema.webhookDeliveries)
        .where(
          and(
            eq(schema.webhookDeliveries.endpointId, e.id),
            gte(schema.webhookDeliveries.createdAt, failingSince),
            inArray(schema.webhookDeliveries.status, ["failed", "pending", "sending"]),
            sql`${schema.webhookDeliveries.lastError} is not null or ${schema.webhookDeliveries.id} = ${d.id}`,
          ),
        );
      if (Number(n) >= DISABLE_MIN_FAILURES) disabled = "Turned off after 3 days of failed deliveries.";
    }
    const out = await u.db
      .update(schema.webhookDeliveries)
      .set({
        status: delay !== null && !disabled ? "pending" : "failed",
        lastStatusCode: r.code,
        lastError: r.error,
        lastResponse: r.response,
        nextAttemptAt: delay !== null && !disabled ? new Date(now.getTime() + delay * 1000) : null,
      })
      .where(eq(schema.webhookDeliveries.id, d.id))
      .returning();
    if (ep && !test) {
      await u.db
        .update(schema.webhookEndpoints)
        .set({ failingSince, ...(disabled ? { enabled: false, disabledReason: disabled, updatedAt: now } : {}) })
        .where(eq(schema.webhookEndpoints.id, e.id));
      if (disabled) {
        await cancelPending(u.db, e.id);
        const owner = await u.db.query.user.findFirst({ where: eq(schema.user.id, d.userId), columns: { email: true } });
        const reason = disabled;
        if (owner) u.afterCommit(() => svc.email.send({ to: owner.email, ...templates.webhookDisabled(svc.config.APP_URL, maskWebhookUrl(e.url), reason) }));
      }
    }
    if (delay !== null && !disabled)
      await u.send(WEBHOOK_QUEUE, { deliveryId: d.id }, { singletonKey: `delivery:${d.id}:a${d.attempt + 1}`, startAfterSeconds: delay });
    return out;
  });
  // the receiver is the user's, not the operator's: a warning, never an error report
  log.warn({ ...ids, code: r.code, reason: r.error, nextAttemptInSec: disabled ? null : delay }, "webhook attempt failed");
  if (disabled) log.warn({ ...ids, reason: disabled }, "webhook disabled");
  return row ?? null;
}

/**
 * An attempt that threw (a bug, the database, a secret that no longer decrypts) rather than reaching the receiver:
 * the claimed row goes back to pending with the same backoff, or fails once the attempts are used up, so it neither
 * sits in `sending` nor loops through the sweep forever. A test is never retried.
 */
export async function recordSendError(svc: Services, deliveryId: number, err: unknown): Promise<void> {
  const message = `Reelsaw could not send this delivery: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
  await svc.tx(async (u) => {
    const [d] = await u.db
      .select()
      .from(schema.webhookDeliveries)
      .where(and(eq(schema.webhookDeliveries.id, deliveryId), eq(schema.webhookDeliveries.status, "sending")))
      .for("update");
    if (!d) return;
    const delay = d.type === "webhook.test" ? null : nextDelaySec(d.attempt);
    await u.db
      .update(schema.webhookDeliveries)
      .set({
        status: delay === null ? "failed" : "pending",
        lastError: message,
        lastStatusCode: null,
        nextAttemptAt: delay === null ? null : new Date(Date.now() + delay * 1000),
      })
      .where(eq(schema.webhookDeliveries.id, d.id));
    if (delay !== null) await u.send(WEBHOOK_QUEUE, { deliveryId: d.id }, { singletonKey: `delivery:${d.id}:a${d.attempt + 1}`, startAfterSeconds: delay });
  });
}

/**
 * Deliveries whose job was lost (a process died mid-send, a job expired) go back to pending and get a job, in one
 * transaction, so a row is never reset without its job. A test that was lost fails instead: it was answered (or not)
 * in its request, and is not sent again later. Run by the worker every few minutes; the claim keeps it from
 * double-sending anything a live job will pick up; `skip locked` keeps two processes' sweeps off the same rows.
 */
export async function requeueStuckDeliveries(svc: Services): Promise<number> {
  const rows = await svc.tx(async (u) => {
    const { rows } = await u.db.execute<{ id: string; test: boolean }>(sql`
      with stuck as (
        select id, type = 'webhook.test' as test from webhook_deliveries
        where status in ('pending', 'sending') and next_attempt_at < now() - ${`${STUCK_MS / 1000} seconds`}::interval
        order by id limit 500
        for update skip locked)
      update webhook_deliveries d
      set status = case when stuck.test then 'failed' else 'pending' end,
          next_attempt_at = case when stuck.test then null else now() end,
          last_error = case when stuck.test then coalesce(d.last_error, 'The test was interrupted before it was sent.') else d.last_error end
      from stuck where d.id = stuck.id
      returning d.id, stuck.test`);
    for (const r of rows) if (!r.test) await u.send(WEBHOOK_QUEUE, { deliveryId: Number(r.id) }, { singletonKey: `delivery:${r.id}:requeue:${Date.now()}` });
    return rows;
  });
  const requeued = rows.filter((r) => !r.test).length;
  if (requeued) svc.log.child({ module: "webhooks" }).warn({ deliveries: requeued }, "requeued webhook deliveries whose job was lost");
  return requeued;
}

/** The worker side: deliver jobs, plus the sweep for lost ones. Returns a stop function. */
export async function startWebhookWorker(svc: Services): Promise<() => void> {
  const { boss } = svc.queue;
  const log = svc.log.child({ module: "webhooks" });
  await boss.work<{ deliveryId: number }>(WEBHOOK_QUEUE, { pollingIntervalSeconds: 1, localConcurrency: svc.config.WEBHOOK_CONCURRENCY }, async ([job]) => {
    if (!job) return;
    try {
      await deliverOnce(svc, job.data.deliveryId);
    } catch (err) {
      // a bug or the database, not the receiver: retried on the same schedule (or by the sweep, if this fails too)
      log.error({ err, deliveryId: job.data.deliveryId, jobId: job.id }, "webhook delivery failed");
      await recordSendError(svc, job.data.deliveryId, err).catch((e) => log.warn({ err: e, deliveryId: job.data.deliveryId }, "webhook failure not recorded"));
    }
  });
  const timer = setInterval(() => void requeueStuckDeliveries(svc).catch((err) => log.warn({ err }, "webhook sweep failed")), STUCK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Send test: a `webhook.test` delivery sent now, in the request, so the answer says what the receiver said. */
export async function testEndpoint(svc: Services, userId: string, endpointId: string, opts: DeliverOptions = {}) {
  const e = await svc.database.db.query.webhookEndpoints.findFirst({
    where: and(eq(schema.webhookEndpoints.id, endpointId), eq(schema.webhookEndpoints.userId, userId)),
  });
  if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "No such webhook" });
  if (!e.enabled) throw new TRPCError({ code: "CONFLICT", message: "This webhook is turned off. Turn it on to send a test." });
  const [d] = await svc.database.db
    .insert(schema.webhookDeliveries)
    .values({ endpointId, userId, type: "webhook.test", status: "pending", nextAttemptAt: new Date() })
    .returning({ id: schema.webhookDeliveries.id });
  let row: WebhookDeliveryRow | null;
  try {
    row = await deliverOnce(svc, d!.id, opts);
  } catch (err) {
    // marked failed, so the sweep does not send the test again later
    await recordSendError(svc, d!.id, err);
    throw err;
  }
  const ok = row?.status === "delivered";
  return {
    ok,
    deliveryId: d!.id,
    code: row?.lastStatusCode ?? null,
    message: ok ? `Delivered: the receiver answered ${row?.lastStatusCode}.` : `Not delivered. ${row?.lastError ?? "The test could not be sent."}`,
    response: row?.lastResponse ?? null,
  };
}
