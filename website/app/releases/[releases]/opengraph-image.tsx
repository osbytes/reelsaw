import { githubReleases } from "@/lib/github";
import { ogBlurb, ogContentType, ogSize, renderOgImage } from "@/lib/og";
import { formatLongDay, releaseCount, releaseDay, releaseTitle, resolveReleasesParam } from "@/lib/release-pages";
import { formatUtcDate } from "@/lib/releases-data";

export const size = ogSize;
export const contentType = ogContentType;
export const alt = "Reelsaw release notes";
export const revalidate = 3600;

/** One release: tag and day, its headline, its next notes. A set: count and days, heading, merged highlights. */
export default async function Image({ params }: { params: Promise<{ releases: string }> }) {
  const feed = await githubReleases();
  const resolved = feed && resolveReleasesParam((await params).releases, feed.releases);
  if (!resolved) {
    return renderOgImage({ eyebrow: "Releases", title: "What has been shipping", description: "Every published Reelsaw version." });
  }
  if (resolved.kind === "release") {
    const r = resolved.release;
    const rest = r.notes.slice(1, 3).map((n) => n.text);
    return renderOgImage({
      eyebrow: `${r.tag} · ${formatLongDay(releaseDay(r))}`,
      title: ogBlurb(releaseTitle(r), 110),
      description: ogBlurb(rest.length ? rest.join(" ") : `Released ${formatUtcDate(r.publishedAt)}.`),
    });
  }
  if (resolved.kind === "empty") {
    return renderOgImage({ eyebrow: "Releases", title: resolved.heading, description: "No release went out on those days." });
  }
  return renderOgImage({
    eyebrow: `${releaseCount(resolved.releases.length)} · ${resolved.dayRange}`,
    title: resolved.heading,
    description: ogBlurb(resolved.highlights.join(" ")),
  });
}
