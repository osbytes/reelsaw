/**
 * One-time Stripe setup for a hosted instance, from the plan list the server enforces (src/ee/billing/plans.ts).
 * Idempotent: re-running finds what exists by lookup key / metadata and changes only what differs.
 *
 *   STRIPE_SECRET_KEY=sk_test_… APP_URL=https://app.example.com pnpm stripe:setup [--tax-code txcd_10103000] [--webhook] [--portal] [--live]
 *
 * Prefer `pnpm stripe:setup` (rebuilds @reelsaw/shared first). Running tsx on this file directly
 * needs a fresh `pnpm --filter @reelsaw/shared build` after shared changes.
 *
 *   - products: one per paid plan (metadata.plan = name) with the tax code (SaaS, personal use by default;
 *     Managed Payments needs an eligible code)
 *   - prices: monthly and yearly under the plan's lookup keys (an existing price with the same amount is kept;
 *     a different amount gets a new price and the lookup key moves to it)
 *   - --webhook: the endpoint APP_URL/api/billing/webhook with the events ee/billing/service.ts tracks; the
 *     signing secret is printed once (put it in STRIPE_WEBHOOK_SECRET)
 *   - --portal: a Customer Portal configuration (switch among the four prices, cancel at period end, invoices)
 *     set as the default
 *   - --live: required to touch a live key (sk_live_…); otherwise the script refuses
 */
import Stripe from "stripe";
import { PAID_PLANS } from "../src/ee/billing/plans.js";
import { TRACKED_EVENTS } from "../src/ee/billing/service.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1]?.startsWith("--") ? "true" : (args[i + 1] ?? "true")) : undefined;
};
const key = process.env.STRIPE_SECRET_KEY;
const appUrl = process.env.APP_URL;
if (!key) throw new Error("STRIPE_SECRET_KEY is required");
if (key.startsWith("sk_live") && !args.includes("--live")) throw new Error("that is a live key; pass --live to confirm");
const taxCode = flag("tax-code") ?? "txcd_10103000";
const stripe = new Stripe(key, { appInfo: { name: "Reelsaw setup" } });

async function main() {
  const priceIds = new Map<string, string>();
  for (const plan of PAID_PLANS) {
    const existing = (await stripe.products.search({ query: `metadata["plan"]:"${plan.name}" AND active:"true"` })).data[0];
    const product =
      existing ?? (await stripe.products.create({ name: `Reelsaw ${plan.label}`, description: plan.blurb, tax_code: taxCode, metadata: { plan: plan.name } }));
    if (existing && (existing.tax_code !== taxCode || existing.description !== plan.blurb))
      await stripe.products.update(product.id, { tax_code: taxCode, description: plan.blurb });
    console.log(`${plan.label}: product ${product.id}${existing ? "" : " (created)"}`);
    for (const interval of ["month", "year"] as const) {
      const lookupKey = plan.lookupKeys![interval];
      const amount = plan.price![interval] * 100;
      const have = (await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })).data[0];
      if (have && have.unit_amount === amount && have.recurring?.interval === interval && have.product === product.id) {
        priceIds.set(lookupKey, have.id);
        console.log(`  ${lookupKey}: ${have.id} ($${plan.price![interval]}/${interval})`);
        continue;
      }
      const price = await stripe.prices.create({
        product: product.id,
        currency: "usd",
        unit_amount: amount,
        recurring: { interval },
        lookup_key: lookupKey,
        transfer_lookup_key: true,
        tax_behavior: "exclusive",
        metadata: { plan: plan.name },
      });
      if (have) await stripe.prices.update(have.id, { active: false });
      priceIds.set(lookupKey, price.id);
      console.log(`  ${lookupKey}: ${price.id} ($${plan.price![interval]}/${interval}, created${have ? `, replaced ${have.id}` : ""})`);
    }
  }

  if (args.includes("--webhook")) {
    if (!appUrl) throw new Error("APP_URL is required for --webhook");
    const url = new URL("/api/billing/webhook", appUrl).toString();
    const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find((w) => w.url === url);
    if (existing) {
      await stripe.webhookEndpoints.update(existing.id, { enabled_events: [...TRACKED_EVENTS] });
      const note =
        existing.api_version && existing.api_version !== Stripe.API_VERSION
          ? `; its API version is ${existing.api_version}, the SDK's is ${Stripe.API_VERSION}: recreate it so event payloads match`
          : "";
      console.log(
        `webhook ${existing.id} already points at ${url}; events updated (the secret is only shown at creation; roll it in the Dashboard if lost)${note}`,
      );
    } else {
      // events are shaped by the endpoint's API version, not the SDK's: pin it so invoice events carry `parent`
      const w = await stripe.webhookEndpoints.create({
        url,
        enabled_events: [...TRACKED_EVENTS],
        description: "Reelsaw billing",
        api_version: Stripe.API_VERSION,
      });
      console.log(`webhook ${w.id} -> ${url} (API version ${Stripe.API_VERSION})\nSTRIPE_WEBHOOK_SECRET=${w.secret}`);
    }
  }

  if (args.includes("--portal")) {
    const products = PAID_PLANS.map((p) => ({ product: "", prices: [priceIds.get(p.lookupKeys!.month)!, priceIds.get(p.lookupKeys!.year)!] }));
    for (const [i, p] of PAID_PLANS.entries()) {
      const { product } = await stripe.prices.retrieve(priceIds.get(p.lookupKeys!.month)!);
      products[i]!.product = typeof product === "string" ? product : product.id;
    }
    const conf = await stripe.billingPortal.configurations.create({
      business_profile: {
        headline: "Reelsaw",
        ...(appUrl ? { privacy_policy_url: "https://reelsaw.com/privacy", terms_of_service_url: "https://reelsaw.com/terms" } : {}),
      },
      features: {
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        customer_update: { enabled: true, allowed_updates: ["email", "name", "address"] },
        subscription_cancel: { enabled: true, mode: "at_period_end", proration_behavior: "none" },
        subscription_update: { enabled: true, default_allowed_updates: ["price"], proration_behavior: "create_prorations", products },
      },
      ...(appUrl ? { default_return_url: new URL("/settings/billing", appUrl).toString() } : {}),
    });
    console.log(`portal configuration ${conf.id} (set as default for new sessions when it is the only one; otherwise pass it in the Dashboard)`);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
