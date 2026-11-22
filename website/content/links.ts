import { COMPETITORS } from "./competitors";
import { GUIDES } from "./guides";
import { USE_CASES } from "./use-cases";
import type { Link } from "./types";

export const ALTERNATIVE_LINKS: Link[] = COMPETITORS.map((c) => ({ href: `/alternatives/${c.slug}`, label: `Reelsaw vs ${c.name}` }));
/** One per use-case page, with its short label */
export const USE_CASE_NAV: Link[] = USE_CASES.map((u) => ({ href: `/${u.slug}`, label: u.nav }));
export const GUIDE_LINKS: Link[] = GUIDES.map((g) => ({ href: `/${g.slug}`, label: g.h1 }));
/** Short labels for navigation surfaces */
export const GUIDE_NAV: Link[] = [
  { href: "/free-ai-clip-generator-no-watermark", label: "Free clip generator, no watermark" },
  { href: "/open-source-video-clipper", label: "Open-source video clippers" },
  { href: "/youtube-to-shorts-converter", label: "YouTube to Shorts converter" },
  { href: "/podcast-to-shorts", label: "Podcast to shorts" },
  { href: "/automate-youtube-shorts-n8n", label: "Automate Shorts with n8n" },
];
