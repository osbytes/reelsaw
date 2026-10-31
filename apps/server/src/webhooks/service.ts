/**
 * Webhooks (docs/specs/webhooks.md): an account's endpoints, their secrets and the delivery log. Deliveries are
 * written by the outbox (outbox.ts) and sent by the `webhooks.deliver` job (deliver.ts). Settings → Webhooks, the
 * *_webhook(s) MCP tools (create/delete are also how a Zapier or Make app subscribes) and `reelsaw webhooks` call this.
 */
import { randomBytes } from "node:crypto";
import { and, count, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createSecretBox } from "../ai/crypto.js";
import { schema } from "../db/index.js";
import {
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_EVENT_TYPES,
  type WebhookDeliveryRow,
  type WebhookDeliveryStatus,
  type WebhookEndpointRow,
  type WebhookEventType,
} from "../db/schema.js";
import { assertPublicHttpUrl, UnsafeUrlError } from "../lib/safe-url.js";
import { takeTxLock, txLock } from "../locks.js";
import { limitsFor } from "../quota.js";
import { WEBHOOK_QUEUE } from "../queue/boss.js";
import type { Services } from "../services.js";

export { WEBHOOK_EVENT_TYPES, WEBHOOK_DELIVERY_STATUSES };
export type { WebhookEventType };

export const DELIVERY_LIST_MAX = 100;
/** a rotation keeps the previous secret signing this long, so receivers can switch without dropping deliveries */
export const ROTATION_OVERLAP_MS = 24 * 3600_000;

const box = (svc: Pick<Services, "config">) => createSecretBox(svc.config.BETTER_AUTH_SECRET, "webhooks");
const newSecret = () => `whsec_${randomBytes(32).toString("base64")}`;
const newId = () => `whk_${randomBytes(9).toString("base64url")}`;

/** The secret of an endpoint and, while a rotation is open, the previous one (both sign). */
export function signingSecrets(
  svc: Pick<Services, "config">,
  e: Pick<WebhookEndpointRow, "secretSealed" | "prevSecretSealed" | "prevSecretUntil">,
  now = Date.now(),
) {
  const b = box(svc);
  const out = [b.decrypt(e.secretSealed)];
  if (e.prevSecretSealed && e.prevSecretUntil && e.prevSecretUntil.getTime() > now) out.push(b.decrypt(e.prevSecretSealed));
  return out;
}

/**
 * Hook URLs carry secrets in their path (Zapier's are hooks.zapier.com/hooks/catch/<account>/<secret>/), so lists and
 * logs show the origin and the last 4 characters: `https://hooks.zapier.com/…/3f2a`.
 */
export function maskWebhookUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const rest = `${u.pathname}${u.search}`.replace(/\/+$/, "");
    return rest && rest !== "/" ? `${u.origin}/…${rest.slice(-4)}` : u.origin;
  } catch {
    return "(invalid URL)";
  }
}

/** A URL an endpoint may use: public https, or anything http(s) where ALLOW_PRIVATE_WEBHOOK_URLS is on. A sentence when not. */
export async function checkWebhookUrl(svc: Pick<Services, "settings">, raw: string): Promise<URL> {
  const allowPrivate = svc.settings.get().ALLOW_PRIVATE_WEBHOOK_URLS;
  let url: URL;
  try {
    url = await assertPublicHttpUrl(raw, { allowPrivate });
  } catch (err) {
    if (!(err instanceof UnsafeUrlError)) throw err;
    // the shared sentence names the source-URL setting; webhooks have their own
    const message = err.message.includes("ALLOW_PRIVATE_SOURCE_URLS")
      ? "That address points inside this server's network. Use a public https URL, or ask the admin to allow webhooks to private networks (ALLOW_PRIVATE_WEBHOOK_URLS)."
      : err.message.replace("as a source", "for a webhook");
    throw new TRPCError({ code: "BAD_REQUEST", message });
  }
  if (!allowPrivate && url.protocol !== "https:") throw new TRPCError({ code: "BAD_REQUEST", message: "Webhook URLs must use https." });
  return url;
}

export interface EndpointView {
  id: string;
  url: string;
  urlMasked: string;
  description: string | null;
  events: WebhookEventType[];
  enabled: boolean;
  /** active | failing | off */
  status: "active" | "failing" | "off";
  disabledReason: string | null;
  failingSince: Date | null;
  /** the first characters of the secret, to tell secrets apart */
  secretStart: string;
  rotationEndsAt: Date | null;
  lastDelivery: { status: WebhookDeliveryStatus; code: number | null; at: Date; type: string } | null;
  createdAt: Date;
}

function endpointView(svc: Pick<Services, "config">, e: WebhookEndpointRow, last: EndpointView["lastDelivery"] = null): EndpointView {
  const secret = box(svc).decrypt(e.secretSealed);
  return {
    id: e.id,
    url: e.url,
    urlMasked: maskWebhookUrl(e.url),
    description: e.description,
    events: e.events,
    enabled: e.enabled,
    status: !e.enabled ? "off" : e.failingSince ? "failing" : "active",
    disabledReason: e.disabledReason,
    failingSince: e.failingSince,
    secretStart: `${secret.slice(0, 10)}…`,
    rotationEndsAt: e.prevSecretSealed && e.prevSecretUntil && e.prevSecretUntil.getTime() > Date.now() ? e.prevSecretUntil : null,
    lastDelivery: last,
    createdAt: e.createdAt,
  };
}

async function ownEndpoint(svc: Services, userId: string, id: string): Promise<WebhookEndpointRow> {
  const e = await svc.database.db.query.webhookEndpoints.findFirst({
    where: and(eq(schema.webhookEndpoints.id, id), eq(schema.webhookEndpoints.userId, userId)),
  });
  if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "No such webhook" });
  return e;
}

/** The account's endpoints (at most MAX_WEBHOOKS_PER_USER, so not paginated beyond a bound), each with its last delivery. */
export async function listEndpoints(svc: Services, userId: string): Promise<EndpointView[]> {
  const db = svc.database.db;
  const rows = await db.query.webhookEndpoints.findMany({
    where: eq(schema.webhookEndpoints.userId, userId),
    orderBy: desc(schema.webhookEndpoints.createdAt),
    limit: 200,
  });
  if (!rows.length) return [];
  const last = await db.execute<{ endpoint_id: string; status: WebhookDeliveryStatus; last_status_code: number | null; created_at: Date; type: string }>(sql`
    select distinct on (endpoint_id) endpoint_id, status, last_status_code, created_at, type
    from webhook_deliveries where endpoint_id in (${sql.join(
      rows.map((r) => sql`${r.id}`),
      sql`, `,
    )})
    order by endpoint_id, id desc`);
  const byId = new Map(last.rows.map((r) => [r.endpoint_id, { status: r.status, code: r.last_status_code, at: new Date(r.created_at), type: r.type }]));
  return rows.map((r) => endpointView(svc, r, byId.get(r.id) ?? null));
}

export interface EndpointInput {
  url: string;
  events: WebhookEventType[];
  description?: string | undefined;
}

/** Add an endpoint; returns it with its secret, shown only this once. Counted against MAX_WEBHOOKS_PER_USER under the account's lock. */
export async function createEndpoint(svc: Services, userId: string, input: EndpointInput): Promise<{ endpoint: EndpointView; secret: string }> {
  const url = await checkWebhookUrl(svc, input.url);
  const events = [...new Set(input.events)];
  if (!events.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick at least one event." });
  const secret = newSecret();
  const row = await svc.tx(async (u) => {
    await takeTxLock(u.db, txLock.webhooks(userId));
    const max = (await limitsFor(u.db, svc.settings.get(), userId, svc.entitlements)).MAX_WEBHOOKS_PER_USER;
    if (max > 0) {
      const n = await u.db.$count(schema.webhookEndpoints, eq(schema.webhookEndpoints.userId, userId));
      if (n >= max) throw new TRPCError({ code: "FORBIDDEN", message: `You have ${n} webhooks, the most this account may have. Delete one to add another.` });
    }
    const [r] = await u.db
      .insert(schema.webhookEndpoints)
      .values({ id: newId(), userId, url: url.toString(), description: input.description?.trim() || null, events, secretSealed: box(svc).encrypt(secret) })
      .returning();
    return r!;
  });
  svc.log.child({ module: "webhooks" }).info({ userId, endpointId: row.id, url: maskWebhookUrl(row.url), events }, "webhook created");
  return { endpoint: endpointView(svc, row), secret };
}

export interface EndpointPatch {
  url?: string | undefined;
  events?: WebhookEventType[] | undefined;
  description?: string | null | undefined;
  enabled?: boolean | undefined;
}

/** Change an endpoint. Turning it on clears a failure streak; turning it off cancels what was waiting to be sent. */
export async function updateEndpoint(svc: Services, userId: string, id: string, patch: EndpointPatch) {
  const url = patch.url !== undefined ? (await checkWebhookUrl(svc, patch.url)).toString() : undefined;
  if (patch.events && !patch.events.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick at least one event." });
  const changed: string[] = [];
  const row = await svc.tx(async (u) => {
    const [e] = await u.db
      .select()
      .from(schema.webhookEndpoints)
      .where(and(eq(schema.webhookEndpoints.id, id), eq(schema.webhookEndpoints.userId, userId)))
      .for("update");
    if (!e) throw new TRPCError({ code: "NOT_FOUND", message: "No such webhook" });
    const set: Partial<WebhookEndpointRow> = {};
    if (url !== undefined && url !== e.url) {
      set.url = url;
      changed.push("url");
    }
    if (patch.events && patch.events.join() !== e.events.join()) {
      set.events = [...new Set(patch.events)];
      changed.push("events");
    }
    const description = patch.description === undefined ? undefined : patch.description?.trim() || null;
    if (description !== undefined && description !== e.description) {
      set.description = description;
      changed.push("description");
    }
    if (patch.enabled !== undefined && patch.enabled !== e.enabled) {
      set.enabled = patch.enabled;
      changed.push(patch.enabled ? "turned on" : "turned off");
      if (patch.enabled) Object.assign(set, { disabledReason: null, failingSince: null });
    }
    if (!changed.length) return e;
    const [r] = await u.db
      .update(schema.webhookEndpoints)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(schema.webhookEndpoints.id, id))
      .returning();
    if (patch.enabled === false) await cancelPending(u.db, id);
    return r!;
  });
  if (changed.length) svc.log.child({ module: "webhooks" }).info({ userId, endpointId: id, changed }, "webhook updated");
  return { endpoint: endpointView(svc, row), changed, message: changed.length ? `Changed: ${changed.join(", ")}.` : "Nothing changed." };
}

/** Pending deliveries of a turned-off endpoint will not be sent; the log keeps them, resendable. */
export async function cancelPending(db: Services["database"]["db"], endpointId: string) {
  await db
    .update(schema.webhookDeliveries)
    .set({ status: "cancelled", nextAttemptAt: null })
    .where(and(eq(schema.webhookDeliveries.endpointId, endpointId), eq(schema.webhookDeliveries.status, "pending")));
}

export async function deleteEndpoint(svc: Services, userId: string, id: string) {
  const r = await svc.database.db
    .delete(schema.webhookEndpoints)
    .where(and(eq(schema.webhookEndpoints.id, id), eq(schema.webhookEndpoints.userId, userId)))
    .returning({ id: schema.webhookEndpoints.id, url: schema.webhookEndpoints.url });
  if (!r.length) throw new TRPCError({ code: "NOT_FOUND", message: "No such webhook" });
  svc.log.child({ module: "webhooks" }).info({ userId, endpointId: id, url: maskWebhookUrl(r[0]!.url) }, "webhook deleted");
  return { ok: true as const, message: "Webhook deleted; nothing more is sent to it." };
}

/** A new secret; the previous one keeps signing for 24 h so the receiver can switch. */
export async function rotateSecret(svc: Services, userId: string, id: string) {
  const e = await ownEndpoint(svc, userId, id);
  const secret = newSecret();
  const until = new Date(Date.now() + ROTATION_OVERLAP_MS);
  await svc.database.db
    .update(schema.webhookEndpoints)
    .set({ secretSealed: box(svc).encrypt(secret), prevSecretSealed: e.secretSealed, prevSecretUntil: until, updatedAt: new Date() })
    .where(eq(schema.webhookEndpoints.id, id));
  svc.log.child({ module: "webhooks" }).info({ userId, endpointId: id }, "webhook secret rotated");
  return {
    secret,
    previousStopsAt: until,
    message: `New secret made. Deliveries are signed with both secrets until ${until.toISOString()}; switch your receiver before then.`,
  };
}

export interface DeliveryView {
  id: number;
  endpointId: string;
  eventId: string;
  type: string;
  projectId: string | null;
  status: WebhookDeliveryStatus;
  attempt: number;
  lastStatusCode: number | null;
  lastError: string | null;
  lastResponse: string | null;
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  /** the request body as sent (null until the first attempt) */
  body: string | null;
}

export const webhookEventId = (d: Pick<WebhookDeliveryRow, "id" | "eventId">) => (d.eventId === null ? `evt_test_${d.id}` : `evt_${d.eventId}`);

function deliveryView(d: WebhookDeliveryRow): DeliveryView {
  return {
    id: d.id,
    endpointId: d.endpointId,
    eventId: webhookEventId(d),
    type: d.type,
    projectId: d.projectId,
    status: d.status,
    attempt: d.attempt,
    lastStatusCode: d.lastStatusCode,
    lastError: d.lastError,
    lastResponse: d.lastResponse,
    nextAttemptAt: d.nextAttemptAt,
    deliveredAt: d.deliveredAt,
    createdAt: d.createdAt,
    body: d.body,
  };
}

export interface ListDeliveriesInput {
  endpointId?: string | undefined;
  status?: WebhookDeliveryStatus | undefined;
  projectId?: string | undefined;
  cursor?: number | undefined;
  limit?: number | undefined;
}

/** A page of the account's delivery log, newest first. */
export async function listDeliveries(svc: Services, userId: string, input: ListDeliveriesInput = {}) {
  const db = svc.database.db;
  const d = schema.webhookDeliveries;
  const limit = Math.min(input.limit ?? 50, DELIVERY_LIST_MAX);
  const filters: SQL[] = [eq(d.userId, userId)];
  if (input.endpointId) filters.push(eq(d.endpointId, input.endpointId));
  if (input.status) filters.push(eq(d.status, input.status));
  if (input.projectId) filters.push(eq(d.projectId, input.projectId));
  const where = and(...filters);
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select()
      .from(d)
      .where(input.cursor ? and(where, lt(d.id, input.cursor)) : where)
      .orderBy(desc(d.id))
      .limit(limit + 1),
    db.select({ total: count() }).from(d).where(where),
  ]);
  const page = rows.slice(0, limit);
  return { items: page.map(deliveryView), nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null, total: Number(total) };
}

/** Queue a delivery again: a new attempt series with the same webhook-id and body, signed afresh. */
export async function resendDelivery(svc: Services, userId: string, deliveryId: number) {
  const id = await svc.tx(async (u) => {
    const [row] = await u.db
      .update(schema.webhookDeliveries)
      .set({ status: "pending", attempt: 0, nextAttemptAt: new Date(), lastError: null })
      .where(
        and(
          eq(schema.webhookDeliveries.id, deliveryId),
          eq(schema.webhookDeliveries.userId, userId),
          inArray(schema.webhookDeliveries.status, ["failed", "delivered", "cancelled"]),
        ),
      )
      .returning({ id: schema.webhookDeliveries.id, endpointId: schema.webhookDeliveries.endpointId });
    if (!row) {
      const exists = await u.db.query.webhookDeliveries.findFirst({
        where: and(eq(schema.webhookDeliveries.id, deliveryId), eq(schema.webhookDeliveries.userId, userId)),
        columns: { status: true },
      });
      if (!exists) throw new TRPCError({ code: "NOT_FOUND", message: "No such delivery" });
      throw new TRPCError({ code: "CONFLICT", message: "This delivery is still being sent; wait for it to finish." });
    }
    const e = await u.db.query.webhookEndpoints.findFirst({ where: eq(schema.webhookEndpoints.id, row.endpointId), columns: { enabled: true } });
    if (!e?.enabled) throw new TRPCError({ code: "CONFLICT", message: "This webhook is turned off. Turn it on, then resend." });
    await u.send(WEBHOOK_QUEUE, { deliveryId: row.id }, { singletonKey: `delivery:${row.id}:resend:${Date.now()}` });
    return row.id;
  });
  return { ok: true as const, deliveryId: id, message: "Queued to send again." };
}
