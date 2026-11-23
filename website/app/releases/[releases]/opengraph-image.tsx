import { msg } from "@lingui/core/runtime-macro";
import { t } from "@/lib/i18n";
import { githubReleases } from "@/lib/github";
import { ogBlurb, ogContentType, ogSize, renderOgImage } from "@/lib/og";
import { formatLongDay, releaseCount, releaseDay, releaseTitle, resolveReleasesParam } from "@/lib/release-pages";
import { formatUtcDate } from "@/lib/releases-data";

export const size = ogSize;
export const contentType = ogContentType;
export const alt = t(msg`Reelsaw release notes`);
export const revalidate = 3600;

/** One release: tag and day, its headline, its next notes. A set: count and days, heading, merged highlights. */
export default async function Image({ params }: { params: Promise<{ releases: string }> }) {
  const feed = await githubReleases();
  const resolved = feed && resolveReleasesParam((await params).releases, feed.releases);
  if (!resolved) {
    return renderOgImage({ eyebrow: t(msg`Releases`), title: t(msg`What has been shipping`), description: t(msg`Every published Reelsaw version.`) });
  }
  if (resolved.kind === "release") {
    const r = resolved.release;
    const rest = r.notes.slice(1, 3).map((n) => n.text);
    return renderOgImage({
      eyebrow: `${r.tag} · ${formatLongDay(releaseDay(r))}`,
      title: ogBlurb(releaseTitle(r), 110),
      description: ogBlurb(rest.length ? rest.join(" ") : t(msg`Released ${{ formatUtcDate: formatUtcDate(r.publishedAt) }}.`)),
    });
  }
  if (resolved.kind === "empty") {
    return renderOgImage({ eyebrow: t(msg`Releases`), title: resolved.heading, description: t(msg`No release went out on those days.`) });
  }
  return renderOgImage({
    eyebrow: `${releaseCount(resolved.releases.length)} · ${resolved.dayRange}`,
    title: resolved.heading,
    description: ogBlurb(resolved.highlights.join(" ")),
  });
}
