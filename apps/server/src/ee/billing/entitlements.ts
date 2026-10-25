/**
 * What an account's subscription grants, from the cached `billing_subscriptions` row (rewritten from Stripe by
 * the sync job). One indexed read per call; quota.ts calls it inside the transaction that enforces the number,
 * so a plan change that committed a moment ago is what the next check sees.
 */
import { eq } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";
import type { BillingInterval, BillingSubscriptionRow } from "../../db/schema.js";
import type { Entitlements, Grants } from "../../quota.js";
import { FREE, planOf, type Plan } from "./plans.js";
import { billingPath } from "@reelsaw/shared";

/** Statuses under which the plan is in force (past_due only inside the grace period). */
export const LIVE_STATUSES = new Set(["trialing", "active", "past_due", "complimentary"]);

/**
 * The plan in force for a row: active and trialing grant it; past_due keeps it for `graceDays` after the first
 * failed payment; complimentary always; everything else (canceled, unpaid, incomplete, paused, no row) is Free.
 */
/** What the plan decision reads: a full row, or the values a sync is about to write. */
export type PlanInput = Pick<BillingSubscriptionRow, "status" | "plan" | "pastDueSince" | "updatedAt">;

export function effectivePlan(row: PlanInput | null | undefined, graceDays: number, now = new Date()): { plan: Plan; reason: "none" | "active" | "trialing" | "complimentary" | "grace" | "lapsed" | "ended" } {
  if (!row) return { plan: FREE, reason: "none" };
  switch (row.status) {
    case "active":
      return { plan: planOf(row.plan), reason: "active" };
    case "trialing":
      return { plan: planOf(row.plan), reason: "trialing" };
    case "complimentary":
      return { plan: planOf(row.plan), reason: "complimentary" };
    case "past_due": {
      const since = row.pastDueSince ?? row.updatedAt;
      return now.getTime() < since.getTime() + graceDays * 86_400_000 ? { plan: planOf(row.plan), reason: "grace" } : { plan: FREE, reason: "lapsed" };
    }
    default:
      return { plan: FREE, reason: "ended" };
  }
}

/** `k` calendar months after `anchor`, the day clamped to the target month's length (31 Jan + 1 → 28/29 Feb, + 2 → 31 Mar). */
function monthsAfter(anchor: Date, k: number): Date {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + k;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(anchor.getUTCDate(), last), anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds()));
}

/**
 * The window a plan's monthly minutes count in. Monthly subscriptions: the billing period. Yearly ones: the
 * current month of the year, each anchored on the period start's day (the allowance is per month, not 12× at
 * once); the last one ends with the period.
 */
export function allowanceWindow(periodStart: Date, periodEnd: Date, interval: BillingInterval | null, now: Date): { start: Date; end: Date } {
  if (interval !== "year") return { start: periodStart, end: periodEnd };
  let k = 0;
  while (monthsAfter(periodStart, k + 1) <= now && monthsAfter(periodStart, k + 1) < periodEnd) k++;
  const end = monthsAfter(periodStart, k + 1);
  return { start: monthsAfter(periodStart, k), end: end < periodEnd ? end : periodEnd };
}

export function grantsOf(row: BillingSubscriptionRow | null | undefined, graceDays: number, appUrl: string, now = new Date()): Grants {
  const { plan, reason } = effectivePlan(row, graceDays, now);
  const next = plan.next ? planOf(plan.next) : null;
  const period = row && plan !== FREE && row.periodStart && row.periodEnd && reason !== "complimentary" ? allowanceWindow(row.periodStart, row.periodEnd, row.interval, now) : null;
  const nextMinutes = next?.limits.MAX_SOURCE_MINUTES_PER_MONTH;
  return {
    plan: plan.name,
    planLabel: plan.label,
    limits: plan.limits,
    watermark: plan.watermark,
    firstVideoFreeMinutes: plan.firstVideoFreeMinutes,
    queuePriority: plan.queuePriority,
    period,
    ...(next
      ? {
          upgrade: {
            text: `${next.label} gives ${nextMinutes ? `${nextMinutes.toLocaleString("en-US")} minutes a month` : "more"}`,
            url: new URL(billingPath(), appUrl).toString(),
            plan: next.name,
            planLabel: next.label,
            limits: next.limits,
          },
        }
      : {}),
  };
}

export function createEntitlements(deps: { graceDays: () => number; appUrl: string }): Entitlements & { rowFor(db: Db, userId: string): Promise<BillingSubscriptionRow | null> } {
  const rowFor = async (db: Db, userId: string) => (await db.query.billingSubscriptions.findFirst({ where: eq(schema.billingSubscriptions.userId, userId) })) ?? null;
  return {
    rowFor,
    async grantsFor(db, userId) {
      return grantsOf(await rowFor(db, userId), deps.graceDays(), deps.appUrl);
    },
  };
}
