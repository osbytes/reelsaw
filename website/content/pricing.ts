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
    label: "Free",
    price: null,
    minutes: 20,
    storageMb: 2048,
    projects: 10,
    watermark: true,
    firstVideoFreeMinutes: 60,
    blurb: "Try the whole pipeline on your own video.",
    bullets: [
      "Your first video free, up to 60 minutes",
      "Then 20 minutes of source video a month",
      "2 GB of storage, 10 projects",
      "Every layout, caption style and the MCP server",
      "A small watermark on the clips",
      "Clips render in HD from a 240p editing preview",
      "One clip of your own, on top of the ones Reelsaw finds",
    ],
  },
  {
    name: "starter",
    label: "Starter",
    price: { month: 12, year: 120 },
    minutes: 100,
    storageMb: 10240,
    projects: 50,
    watermark: false,
    firstVideoFreeMinutes: 0,
    blurb: "For getting started, without a watermark.",
    bullets: [
      "100 minutes of source video a month",
      "10 GB of storage, 50 projects",
      "No watermark",
      "Full-quality source in the editor",
      "Unlimited clips of your own",
      "MCP and API access for agents",
      "Jobs start ahead of Free",
      "4 jobs at once",
    ],
  },
  {
    name: "creator",
    label: "Creator",
    price: { month: 29, year: 290 },
    minutes: 300,
    storageMb: 30720,
    projects: 200,
    watermark: false,
    firstVideoFreeMinutes: 0,
    blurb: "A show a week, clipped and posted.",
    bullets: [
      "300 minutes of source video a month",
      "30 GB of storage, 200 projects",
      "No watermark",
      "Full-quality source in the editor",
      "Unlimited clips of your own",
      "MCP and API access for agents",
      "Jobs start ahead of Starter and Free",
      "6 jobs at once",
    ],
  },
  {
    name: "pro",
    label: "Pro",
    price: { month: 59, year: 590 },
    minutes: 750,
    storageMb: 102400,
    projects: 0,
    watermark: false,
    firstVideoFreeMinutes: 0,
    blurb: "Daily publishing and a back catalogue.",
    bullets: ["750 minutes of source video a month", "100 GB of storage, unlimited projects", "No watermark", "Top of the processing queue", "12 jobs at once"],
  },
];
