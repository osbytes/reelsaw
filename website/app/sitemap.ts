import type { MetadataRoute } from "next";
import { COMPETITORS } from "@/content/competitors";
import { GUIDES } from "@/content/guides";
import { CHECKED } from "@/content/reelsaw";
import { SITE } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const checked = new Date(CHECKED);
  return [
    { url: `${SITE.url}/`, lastModified: checked, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE.url}/pricing`, lastModified: checked, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE.url}/terms`, lastModified: checked, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE.url}/privacy`, lastModified: checked, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE.url}/releases`, lastModified: new Date(), changeFrequency: "daily", priority: 0.7 },
    { url: `${SITE.url}/alternatives`, lastModified: checked, changeFrequency: "monthly", priority: 0.8 },
    ...COMPETITORS.map((c) => ({ url: `${SITE.url}/alternatives/${c.slug}`, lastModified: new Date(c.checked), changeFrequency: "monthly" as const, priority: 0.7 })),
    ...GUIDES.map((g) => ({ url: `${SITE.url}/${g.slug}`, lastModified: checked, changeFrequency: "monthly" as const, priority: 0.7 })),
  ];
}
