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
/** The project an upgrade offer was shown on: Billing passes it to checkout, and only that project is finished and re-rendered by itself after the plan change. */
export const FROM_PROJECT_PARAM = "from";

export type BillingInterval = "month" | "year";

/** The plan an account is on without a subscription. Nothing to check out, so a sign-up for it skips the Billing page. */
export const FREE_PLAN = "free";

/** The Billing page, optionally with the outcome of a Stripe round trip. */
export function billingPath(outcome?: CheckoutOutcome): string {
  return outcome ? `${BILLING_PATH}?${CHECKOUT_PARAM}=${outcome}` : BILLING_PATH;
}

/** The Billing page with a plan to start Checkout for (the website's sign-up buttons end up here). */
export function billingPlanPath(plan: string, interval: BillingInterval): string {
  return `${BILLING_PATH}?${PLAN_PARAM}=${encodeURIComponent(plan)}&${INTERVAL_PARAM}=${interval}`;
}

/** An upgrade offer's link (the Billing page, absolute or not) carrying the project it was shown on. */
export function upgradeFromProject(href: string, projectId: string): string {
  const [path, query = ""] = href.split("?", 2) as [string, string?];
  const q = new URLSearchParams(query);
  q.set(FROM_PROJECT_PARAM, projectId);
  return `${path}?${q.toString()}`;
}
