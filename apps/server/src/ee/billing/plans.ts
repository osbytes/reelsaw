/**
 * The plans, as config: a name, the Stripe price lookup keys (monthly, yearly), the limits the plan grants and
 * the marketing line. Lookup keys are stable; the Stripe prices behind them can be rotated without a deploy.
 * Free is in the same list with no price: it is what an account with no subscription (or a lapsed one) gets.
 * `website/content/pricing.ts` mirrors this list for reelsaw.com; the "pricing content" case in `test/billing.test.ts` keeps them equal.
 */
import type { Limits } from "../../quota.js";

export type Interval = "month" | "year";

export interface Plan {
  /** stable id, also the `plan` column value */
  name: string;
  label: string;
  /** USD per interval; null = free */
  price: Record<Interval, number> | null;
  /** Stripe price lookup keys; null = free */
  lookupKeys: Record<Interval, string> | null;
  /** what the plan grants; a key the plan leaves out falls through to the instance setting */
  limits: Partial<Limits>;
  /** the account's first video does not count against the monthly minutes when it is at most this long (0 = no allowance) */
  firstVideoFreeMinutes: number;
  /** added to every job's fair-share priority (pg-boss: higher first); 0 = none */
  queuePriority: number;
  /** false = the plan removes the watermark; null = follow the instance setting */
  watermark: boolean | null;
  blurb: string;
  /** the plan to suggest when this one's limit is hit */
  next: string | null;
}

export const PLANS: Plan[] = [
  {
    name: "free",
    label: "Free",
    price: null,
    lookupKeys: null,
    limits: { MAX_SOURCE_MINUTES_PER_MONTH: 20, MAX_STORAGE_MB: 2048, MAX_PROJECTS_PER_USER: 10, MAX_LIVE_JOBS_PER_USER: 2 },
    firstVideoFreeMinutes: 60,
    queuePriority: 0,
    watermark: null,
    blurb: "Your first video free up to 60 minutes, then 20 minutes a month, with a small watermark.",
    next: "starter",
  },
  {
    name: "starter",
    label: "Starter",
    price: { month: 12, year: 120 },
    lookupKeys: { month: "starter_monthly", year: "starter_yearly" },
    limits: { MAX_SOURCE_MINUTES_PER_MONTH: 100, MAX_STORAGE_MB: 10240, MAX_PROJECTS_PER_USER: 50, MAX_LIVE_JOBS_PER_USER: 4 },
    firstVideoFreeMinutes: 0,
    queuePriority: 0,
    watermark: false,
    blurb: "100 minutes a month, 10 GB of storage, no watermark.",
    next: "creator",
  },
  {
    name: "creator",
    label: "Creator",
    price: { month: 29, year: 290 },
    lookupKeys: { month: "creator_monthly", year: "creator_yearly" },
    limits: { MAX_SOURCE_MINUTES_PER_MONTH: 300, MAX_STORAGE_MB: 30720, MAX_PROJECTS_PER_USER: 200, MAX_LIVE_JOBS_PER_USER: 6 },
    firstVideoFreeMinutes: 0,
    queuePriority: 0,
    watermark: false,
    blurb: "300 minutes a month, 30 GB of storage, no watermark.",
    next: "pro",
  },
  {
    name: "pro",
    label: "Pro",
    price: { month: 59, year: 590 },
    lookupKeys: { month: "pro_monthly", year: "pro_yearly" },
    limits: { MAX_SOURCE_MINUTES_PER_MONTH: 750, MAX_STORAGE_MB: 102400, MAX_PROJECTS_PER_USER: 0, MAX_LIVE_JOBS_PER_USER: 12 },
    firstVideoFreeMinutes: 0,
    queuePriority: 5,
    watermark: false,
    blurb: "750 minutes a month, 100 GB of storage, unlimited projects, no watermark, priority queue.",
    next: null,
  },
];

export const FREE = PLANS[0]!;
export const PAID_PLANS = PLANS.filter((p) => p.lookupKeys);

export function planOf(name: string | null | undefined): Plan {
  return PLANS.find((p) => p.name === name) ?? FREE;
}

/** The plan and interval a Stripe price belongs to, by its lookup key; null for a price we do not sell. */
export function planByLookupKey(key: string | null | undefined): { plan: Plan; interval: Interval } | null {
  if (!key) return null;
  for (const plan of PAID_PLANS) for (const interval of ["month", "year"] as const) if (plan.lookupKeys![interval] === key) return { plan, interval };
  return null;
}

export const ALL_LOOKUP_KEYS = PAID_PLANS.flatMap((p) => [p.lookupKeys!.month, p.lookupKeys!.year]);

/** What the pricing page and the Billing page show (no Stripe ids). */
export const publicPlan = (p: Plan) => ({ name: p.name, label: p.label, price: p.price, limits: p.limits, watermark: p.watermark !== false, firstVideoFreeMinutes: p.firstVideoFreeMinutes, priority: p.queuePriority > 0, blurb: p.blurb });
