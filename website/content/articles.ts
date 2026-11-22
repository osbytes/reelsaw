import { GUIDES } from "./guides";
import type { Guide } from "./types";
import { USE_CASES } from "./use-cases";

/** Every page served at /<slug>: guides and use cases share one route, so their slugs must not collide. */
export const ARTICLES: { kind: "guide" | "useCase"; page: Guide }[] = [
  ...GUIDES.map((page) => ({ kind: "guide" as const, page })),
  ...USE_CASES.map((page) => ({ kind: "useCase" as const, page })),
];

const slugs = ARTICLES.map((a) => a.page.slug);
const dupe = slugs.find((s, i) => slugs.indexOf(s) !== i);
if (dupe) throw new Error(`Two pages share the slug /${dupe}`);

export const articleBySlug = (slug: string) => ARTICLES.find((a) => a.page.slug === slug);
