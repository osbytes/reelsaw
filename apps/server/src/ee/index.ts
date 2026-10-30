/**
 * Enterprise edition entry point (REELSAW_EE=true; see LICENSE in this folder and docs/specs/ee.md). Imported
 * dynamically by services.ts, so a self-hosted boot never loads this folder. Today: billing through Stripe
 * and the entitlements it grants. Later: organisations, SSO.
 */
import type { Context as HonoContext } from "hono";
import type { Services } from "../services.js";
import type { Entitlements } from "../quota.js";
import { createBilling, SignatureError, type BillingService } from "./billing/service.js";

export interface EE {
  entitlements: Entitlements;
  billing: BillingService;
  /** `POST /api/billing/webhook` */
  webhook(c: HonoContext): Promise<Response>;
  /** queues, workers and the daily reconcile; worker processes only */
  startWorkers(): Promise<void>;
}

export async function createEE(svc: Pick<Services, "config" | "database" | "tx" | "settings" | "queue" | "log" | "telemetry">): Promise<EE> {
  const log = svc.log.child({ module: "billing" });
  const billing = createBilling(svc, log);
  await billing.check();
  log.info(
    { plans: billing.paidPlans.map((p) => p.name), managedPayments: svc.config.STRIPE_MANAGED_PAYMENTS, graceDays: svc.config.BILLING_GRACE_DAYS },
    "billing enabled",
  );
  return {
    entitlements: billing.entitlements,
    billing,
    async webhook(c) {
      const raw = await c.req.text();
      try {
        const r = await billing.recordWebhook(raw, c.req.header("stripe-signature") ?? null, c.get("log"));
        return c.json({ received: true, ...r });
      } catch (err) {
        if (err instanceof SignatureError) {
          c.get("log")?.warn({ reason: err.message }, "stripe webhook rejected");
          return c.json({ error: "invalid signature" }, 400);
        }
        throw err; // 500: Stripe retries
      }
    },
    startWorkers: billing.startWorkers,
  };
}
