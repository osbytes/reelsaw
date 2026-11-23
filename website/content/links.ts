import { msg } from "@lingui/core/runtime-macro";
import { t } from "@/lib/i18n";
import { COMPETITORS } from "./competitors";
import { GUIDES } from "./guides";
import { USE_CASES } from "./use-cases";
import type { Link } from "./types";

export const ALTERNATIVE_LINKS: Link[] = COMPETITORS.map((c) => ({ href: `/alternatives/${c.slug}`, label: t(msg`Reelsaw vs ${{ name: c.name }}`) }));
/** One per use-case page, with its short label */
export const USE_CASE_NAV: Link[] = USE_CASES.map((u) => ({ href: `/${u.slug}`, label: u.nav }));
export const GUIDE_LINKS: Link[] = GUIDES.map((g) => ({ href: `/${g.slug}`, label: g.h1 }));
/** Short labels for navigation surfaces */
export const GUIDE_NAV: Link[] = [
  { href: "/free-ai-clip-generator-no-watermark", label: t(msg`Free clip generator, no watermark`) },
  { href: "/open-source-video-clipper", label: t(msg`Open-source video clippers`) },
  { href: "/youtube-to-shorts-converter", label: t(msg`YouTube to Shorts converter`) },
  { href: "/podcast-to-shorts", label: t(msg`Podcast to shorts`) },
  { href: "/automate-youtube-shorts-n8n", label: t(msg`Automate Shorts with n8n`) },
];
