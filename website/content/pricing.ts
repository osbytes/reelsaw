import { msg } from "@lingui/core/runtime-macro";
import { t } from "@/lib/i18n";
/**
 * The hosted plans as reelsaw.com shows them. Mirrors apps/server/src/ee/billing/plans.ts (the server's list is
 * what is enforced); the server test `billing.test.ts` fails when the two drift. Prices in USD.
 */
export type PricingPlan = {
  name: string;
  label: string;
  /** null = free */
  price: { month: number; year: number } | null;
  /** 0 = unlimited */
  minutes: number;
  storageMb: number;
  projects: number;
  watermark: boolean;
  /** the first video is free up to this many minutes (0 = no allowance) */
  firstVideoFreeMinutes: number;
  blurb: string;
  bullets: string[];
};

export const PRICING: PricingPlan[] = [
  {
    name: "free",
    label: t(msg`Free`),
    price: null,
    minutes: 20,
    storageMb: 2048,
    projects: 10,
    watermark: true,
    firstVideoFreeMinutes: 60,
    blurb: t(msg`Try the whole pipeline on your own video.`),
    bullets: [
      t(msg`Your first video free, up to 60 minutes; a longer one gets its first 60 clipped, and the rest when you upgrade`),
      t(msg`Then 20 minutes of source video a month`),
      t(msg`2 GB of storage, 10 projects`),
      t(msg`Every layout, caption style and the MCP server`),
      t(msg`A small watermark on the clips`),
      t(msg`Clips render in HD from a 240p editing preview`),
      t(msg`One clip of your own, on top of the ones Reelsaw finds`),
    ],
  },
  {
    name: "starter",
    label: t(msg`Starter`),
    price: { month: 12, year: 120 },
    minutes: 100,
    storageMb: 10240,
    projects: 50,
    watermark: false,
    firstVideoFreeMinutes: 0,
    blurb: t(msg`For getting started, without a watermark.`),
    bullets: [
      t(msg`100 minutes of source video a month`),
      t(msg`10 GB of storage, 50 projects`),
      t(msg`No watermark`),
      t(msg`Full-quality source in the editor`),
      t(msg`Unlimited clips of your own`),
      t(msg`MCP and API access for agents`),
      t(msg`Jobs start ahead of Free`),
      t(msg`4 jobs at once`),
    ],
  },
  {
    name: "creator",
    label: t(msg`Creator`),
    price: { month: 29, year: 290 },
    minutes: 300,
    storageMb: 30720,
    projects: 200,
    watermark: false,
    firstVideoFreeMinutes: 0,
    blurb: t(msg`A show a week, clipped and posted.`),
    bullets: [
      t(msg`300 minutes of source video a month`),
      t(msg`30 GB of storage, 200 projects`),
      t(msg`No watermark`),
      t(msg`Full-quality source in the editor`),
      t(msg`Unlimited clips of your own`),
      t(msg`MCP and API access for agents`),
      t(msg`Jobs start ahead of Starter and Free`),
      t(msg`6 jobs at once`),
    ],
  },
  {
    name: "pro",
    label: t(msg`Pro`),
    price: { month: 59, year: 590 },
    minutes: 750,
    storageMb: 102400,
    projects: 0,
    watermark: false,
    firstVideoFreeMinutes: 0,
    blurb: t(msg`Daily publishing and a back catalogue.`),
    bullets: [
      t(msg`750 minutes of source video a month`),
      t(msg`100 GB of storage, unlimited projects`),
      t(msg`No watermark`),
      t(msg`Top of the processing queue`),
      t(msg`12 jobs at once`),
    ],
  },
];
