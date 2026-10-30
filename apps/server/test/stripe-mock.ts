/**
 * A stand-in for api.stripe.com that knows just what ee/billing/service.ts calls: prices by lookup key, customers,
 * Checkout and Portal sessions, subscriptions. Plus `/_mock/*` controls that move a subscription through its life
 * (complete a checkout, fail a payment, recover, change plan, cancel) and deliver the signed webhook events for it,
 * on purpose in the wrong order or twice, so the app's durability rules can be exercised end to end.
 *
 *   pnpm stripe:mock                       (STRIPE_MOCK_PORT=4242, STRIPE_WEBHOOK_SECRET=whsec_mock,
 *                                           MOCK_WEBHOOK_URL=http://localhost:3100/api/billing/webhook)
 *   app: STRIPE_API_BASE=http://host.docker.internal:4242 STRIPE_SECRET_KEY=sk_test_mock STRIPE_WEBHOOK_SECRET=whsec_mock
 *
 * State lives in memory; restart to reset. Not a Stripe emulator: unknown routes answer 404.
 */
import http from "node:http";
import Stripe from "stripe";
import { PAID_PLANS } from "../src/ee/billing/plans.js";

const PORT = Number(process.env.STRIPE_MOCK_PORT ?? 4242);
const SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_mock";
const WEBHOOK = process.env.MOCK_WEBHOOK_URL ?? "http://localhost:3100/api/billing/webhook";

type Obj = Record<string, unknown>;
// ids are unique across restarts (Stripe's are): the app keys webhook events by id, so a repeat would be a duplicate
const RUN = Math.random().toString(36).slice(2, 6);
let seq = 1;
const id = (p: string) => `${p}_${RUN}${(seq++).toString(36).padStart(5, "0")}`;
const now = () => Math.floor(Date.now() / 1000);

const prices = new Map<string, Obj>();
for (const p of PAID_PLANS)
  for (const interval of ["month", "year"] as const) {
    const key = p.lookupKeys![interval];
    prices.set(`price_${key}`, {
      id: `price_${key}`,
      object: "price",
      active: true,
      lookup_key: key,
      product: `prod_${p.name}`,
      unit_amount: p.price![interval] * 100,
      currency: "usd",
      recurring: { interval },
    });
  }
const customers = new Map<string, Obj>();
const sessions = new Map<string, Obj>();
const subscriptions = new Map<string, Obj>();
const idem = new Map<string, Obj>();
const delivered: Array<{ id: string; type: string; status: number; body: string }> = [];

/** Stripe's form encoding (`a[b][0][c]=v`) back into objects. */
function parseForm(body: string): Obj {
  const out: Obj = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const path = k.replace(/\]/g, "").split("[");
    let cur: Obj = out;
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i]!;
      const nextIsIndex = /^\d+$/.test(path[i + 1]!);
      if (!(seg in cur)) cur[seg] = nextIsIndex ? [] : {};
      cur = cur[seg] as Obj;
    }
    cur[path[path.length - 1]!] = v;
  }
  return out;
}

function subscriptionFor(session: Obj, priceId: string): Obj {
  const price = prices.get(priceId)!;
  const sid = id("sub");
  const start = now();
  const interval = (price.recurring as Obj).interval as string;
  const end = start + (interval === "year" ? 365 : 30) * 86400;
  const sub: Obj = {
    id: sid,
    object: "subscription",
    customer: session.customer,
    status: "active",
    cancel_at_period_end: false,
    ended_at: null,
    created: start,
    metadata: ((session.subscription_data as Obj | undefined)?.metadata as Obj) ?? {},
    items: { object: "list", data: [{ id: id("si"), object: "subscription_item", price, quantity: 1, current_period_start: start, current_period_end: end }] },
  };
  subscriptions.set(sid, sub);
  return sub;
}

async function deliver(type: string, object: Obj, opts: { eventId?: string } = {}) {
  const event = { id: opts.eventId ?? id("evt"), object: "event", type, created: now(), data: { object }, livemode: false, api_version: "2026-01-01" };
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  const res = await fetch(WEBHOOK, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload }).catch(
    (err: Error) => ({ status: 0, text: async () => err.message }),
  );
  const r = { id: event.id, type, status: res.status, body: await res.text() };
  delivered.push(r);
  console.log(`-> ${type} ${event.id}: ${r.status} ${r.body.slice(0, 120)}`);
  return r;
}

/** The events Stripe sends for a transition, in Stripe's order; `reverse` and `duplicate` make the app prove itself. */
async function deliverAll(events: Array<[string, Obj]>, opts: { reverse?: boolean; duplicate?: boolean }) {
  const list = opts.reverse ? [...events].reverse() : events;
  const out = [];
  for (const [type, object] of list) out.push(await deliver(type, object));
  if (opts.duplicate && out[0]) out.push(await deliver(list[0]![0], list[0]![1], { eventId: out[0].id }));
  return out;
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const notFound = (res: http.ServerResponse, what: string) =>
  json(res, 404, { error: { type: "invalid_request_error", code: "resource_missing", message: `No such ${what}` } });

const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const url = new URL(req.url!, `http://localhost:${PORT}`);
  const p = url.pathname;
  const m = req.method!;
  const form = m === "POST" && !p.startsWith("/_mock") ? parseForm(raw) : {};
  const idemKey = req.headers["idempotency-key"] as string | undefined;
  if (idemKey && idem.has(idemKey)) return json(res, 200, idem.get(idemKey));
  const reply = (body: Obj) => {
    if (idemKey) idem.set(idemKey, body);
    return json(res, 200, body);
  };

  // ---- Stripe API
  if (m === "GET" && p === "/v1/prices") {
    const keys = [...url.searchParams.entries()].filter(([k]) => k.startsWith("lookup_keys")).map(([, v]) => v);
    return json(res, 200, { object: "list", data: [...prices.values()].filter((x) => !keys.length || keys.includes(x.lookup_key as string)), has_more: false });
  }
  if (m === "GET" && p === "/v1/customers") {
    const email = url.searchParams.get("email");
    return json(res, 200, { object: "list", data: [...customers.values()].filter((c) => !email || c.email === email), has_more: false });
  }
  if (m === "POST" && p === "/v1/customers") {
    const c = { id: id("cus"), object: "customer", email: form.email, name: form.name, metadata: form.metadata ?? {} };
    customers.set(c.id, c);
    return reply(c);
  }
  let mm = /^\/v1\/customers\/([^/]+)$/.exec(p);
  if (mm) {
    const c = customers.get(mm[1]!);
    if (!c) return notFound(res, "customer");
    if (m === "POST") Object.assign(c, { metadata: { ...(c.metadata as Obj), ...((form.metadata as Obj) ?? {}) } });
    return reply(c);
  }
  if (m === "POST" && p === "/v1/checkout/sessions") {
    const s = {
      id: id("cs"),
      object: "checkout.session",
      mode: form.mode,
      customer: form.customer,
      line_items: form.line_items,
      subscription_data: form.subscription_data,
      metadata: form.metadata,
      managed_payments: form.managed_payments ?? null,
      success_url: form.success_url,
      cancel_url: form.cancel_url,
      subscription: null as string | null,
    };
    (s as Obj).url = `http://localhost:${PORT}/_mock/checkout/${s.id}`;
    sessions.set(s.id, s);
    return reply(s);
  }
  if (m === "POST" && p === "/v1/billing_portal/sessions")
    return reply({
      id: id("bps"),
      object: "billing_portal.session",
      customer: form.customer,
      url: `http://localhost:${PORT}/_mock/portal/${form.customer}${form.flow_data ? "?flow=" + ((form.flow_data as Obj).type as string) : ""}`,
    });
  if (m === "GET" && p === "/v1/subscriptions") {
    const cust = url.searchParams.get("customer");
    return json(res, 200, { object: "list", data: [...subscriptions.values()].filter((s) => !cust || s.customer === cust), has_more: false });
  }
  mm = /^\/v1\/subscriptions\/([^/]+)$/.exec(p);
  if (mm) {
    const s = subscriptions.get(mm[1]!);
    if (!s) return notFound(res, "subscription");
    if (m === "DELETE") Object.assign(s, { status: "canceled", ended_at: now() });
    return json(res, 200, s);
  }

  // ---- controls
  const body = raw ? (JSON.parse(raw) as Obj) : {};
  const opts = { reverse: !!body.reverse, duplicate: !!body.duplicate };
  if (p === "/_mock/state")
    return json(res, 200, { customers: [...customers.values()], subscriptions: [...subscriptions.values()], sessions: [...sessions.keys()], delivered });
  mm = /^\/_mock\/checkout\/([^/]+)$/.exec(p);
  if (mm && m === "GET") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<h1>mock Stripe Checkout</h1><p>session ${mm[1]}</p><p>POST /_mock/complete/${mm[1]} to pay.</p>`);
  }
  mm = /^\/_mock\/complete\/([^/]+)$/.exec(p);
  if (mm) {
    const s = sessions.get(mm[1]!);
    if (!s) return notFound(res, "session");
    const priceId = ((s.line_items as Obj[])[0] as Obj).price as string;
    const sub = subscriptionFor(s, priceId);
    s.subscription = sub.id;
    s.status = "complete";
    const out = await deliverAll(
      [
        ["customer.subscription.created", sub],
        ["checkout.session.completed", s],
        ["invoice.paid", { id: id("in"), object: "invoice", parent: { type: "subscription_details", subscription_details: { subscription: sub.id } } }],
      ],
      opts,
    );
    return json(res, 200, { subscription: sub.id, delivered: out });
  }
  mm = /^\/_mock\/(fail|recover|cancel|change|redeliver)\/([^/]+)$/.exec(p);
  if (mm) {
    const s = subscriptions.get(mm[2]!);
    if (!s) return notFound(res, "subscription");
    const item = (s.items as { data: Obj[] }).data[0]!;
    switch (mm[1]) {
      case "fail": {
        s.status = "past_due";
        return json(res, 200, {
          delivered: await deliverAll(
            [
              [
                "invoice.payment_failed",
                { id: id("in"), object: "invoice", parent: { type: "subscription_details", subscription_details: { subscription: s.id } } },
              ],
              ["customer.subscription.updated", s],
            ],
            opts,
          ),
        });
      }
      case "recover":
        s.status = "active";
        return json(res, 200, {
          delivered: await deliverAll(
            [
              ["invoice.paid", { id: id("in"), object: "invoice", parent: { type: "subscription_details", subscription_details: { subscription: s.id } } }],
              ["customer.subscription.updated", s],
            ],
            opts,
          ),
        });
      case "cancel":
        if (body.atPeriodEnd) s.cancel_at_period_end = true;
        else Object.assign(s, { status: "canceled", ended_at: now() });
        return json(res, 200, {
          delivered: await deliverAll([[body.atPeriodEnd ? "customer.subscription.updated" : "customer.subscription.deleted", s]], opts),
        });
      case "change": {
        const price = [...prices.values()].find((x) => x.lookup_key === body.lookupKey);
        if (!price) return notFound(res, "price");
        item.price = price;
        return json(res, 200, { delivered: await deliverAll([["customer.subscription.updated", s]], opts) });
      }
      case "redeliver": {
        const last = [...delivered].reverse().find((d) => d.type === "customer.subscription.updated" || d.type === "customer.subscription.created");
        return json(res, 200, { delivered: last ? [await deliver(last.type, s, { eventId: last.id })] : [] });
      }
    }
  }
  if (p === "/_mock/unsigned") {
    const r = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=bad" },
      body: JSON.stringify({ id: "evt_bad", type: "customer.subscription.updated", data: { object: {} } }),
    });
    return json(res, 200, { status: r.status, body: await r.text() });
  }
  return notFound(res, `route ${m} ${p}`);
});

server.listen(PORT, () => console.log(`stripe-mock listening on :${PORT}; webhooks -> ${WEBHOOK}; prices: ${[...prices.keys()].join(", ")}`));
