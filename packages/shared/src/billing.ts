/**
 * Billing routes the server and the web app both refer to: the Billing page, where Stripe sends people back
 * (and with which outcome), and the sign-up hand-off that lands a chosen plan on that page. One definition so
 * a renamed route cannot leave the server redirecting to a page that no longer exists.
 */
export const BILLING_PATH = "/settings/billing";

/** `?checkout=` values Stripe returns with (success / cancel URLs, the portal's after-completion redirect). */
export const CHECKOUT_OUTCOMES = ["success", "canceled", "changed"] as const;
export type CheckoutOutcome = (typeof CHECKOUT_OUTCOMES)[number];
export const isCheckoutOutcome = (v: string | null | undefined): v is CheckoutOutcome => CHECKOUT_OUTCOMES.includes(v as CheckoutOutcome);

export const CHECKOUT_PARAM = "checkout";
export const PLAN_PARAM = "plan";
export const INTERVAL_PARAM = "interval";

export type BillingInterval = "month" | "year";

/** The Billing page, optionally with the outcome of a Stripe round trip. */
export function billingPath(outcome?: CheckoutOutcome): string {
  return outcome ? `${BILLING_PATH}?${CHECKOUT_PARAM}=${outcome}` : BILLING_PATH;
}

/** The Billing page with a plan to start Checkout for (the website's sign-up buttons end up here). */
export function billingPlanPath(plan: string, interval: BillingInterval): string {
  return `${BILLING_PATH}?${PLAN_PARAM}=${encodeURIComponent(plan)}&${INTERVAL_PARAM}=${interval}`;
}
