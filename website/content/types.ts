export type Faq = { q: string; a: string };
export type Link = { href: string; label: string };
export type Table = { columns: string[]; rows: string[][] };
export type Section = { heading: string; paragraphs?: string[]; bullets?: string[]; table?: Table };

/** One row of the feature-by-feature table: Reelsaw's cell is fixed, each competitor fills `them`. */
export type FeatureKey =
  | "entry"
  | "free"
  | "watermark"
  | "openSource"
  | "selfHost"
  | "local"
  | "providers"
  | "moments"
  | "reframe"
  | "captions"
  | "fillers"
  | "dubbing"
  | "publishing"
  | "agents"
  | "cap"
  | "accounts";

export type Competitor = {
  slug: string;
  name: string;
  site: string;
  pricingUrl: string;
  /** ISO date the vendor's public pricing page was read */
  checked: string;
  metaTitle: string;
  metaDescription: string;
  h1: string;
  intro: string[];
  pricing: { summary: string; plans: { name: string; price: string; includes: string }[]; note?: string };
  them: Record<FeatureKey, string>;
  betterAt: string[];
  pickThem: string[];
  pickReelsaw: string[];
  faqs: Faq[];
  sources: Link[];
};

export type Guide = {
  slug: string;
  metaTitle: string;
  metaDescription: string;
  h1: string;
  intro: string[];
  sections: Section[];
  faqs: Faq[];
  sources: Link[];
};
