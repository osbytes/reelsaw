import type { MetadataRoute } from "next";
import { COMPETITORS } from "@/content/competitors";
import { GUIDES } from "@/content/guides";
import { CHECKED } from "@/content/reelsaw";
import { githubReleases } from "@/lib/github";
import { releasePath } from "@/lib/release-pages";
import { SITE } from "@/lib/site";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const checked = new Date(CHECKED);
  // Each release has its own page; sets of releases (`v0.17.0..v0.19.1`, days) are noindex.
  const releases = (await githubReleases())?.releases ?? [];
  return [
    { url: `${SITE.url}/`, lastModified: checked, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE.url}/pricing`, lastModified: checked, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE.url}/terms`, lastModified: checked, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE.url}/privacy`, lastModified: checked, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE.url}/releases`, lastModified: new Date(), changeFrequency: "daily", priority: 0.7 },
    { url: `${SITE.url}/alternatives`, lastModified: checked, changeFrequency: "monthly", priority: 0.8 },
    ...COMPETITORS.map((c) => ({
      url: `${SITE.url}/alternatives/${c.slug}`,
      lastModified: new Date(c.checked),
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
    ...releases.map((r) => ({
      url: `${SITE.url}${releasePath(r.tag)}`,
      lastModified: new Date(r.publishedAt),
      changeFrequency: "yearly" as const,
      priority: 0.4,
    })),
    ...GUIDES.map((g) => ({ url: `${SITE.url}/${g.slug}`, lastModified: checked, changeFrequency: "monthly" as const, priority: 0.7 })),
  ];
}
