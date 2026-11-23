import { msg } from "@lingui/core/runtime-macro";
import { t } from "@/lib/i18n";
import type { Metadata } from "next";
import { ReleasesNotFoundView } from "@/components/release-list";
import { githubReleases } from "@/lib/github";

export const metadata: Metadata = { title: t(msg`Release not found`), robots: { index: false, follow: true } };

/** An unknown tag (`/releases/v9.0.0`) or a link that names no release. */
export default async function ReleaseNotFound() {
  const latest = (await githubReleases())?.releases[0];
  return (
    <ReleasesNotFoundView
      title={t(msg`Release not found`)}
      description={t(msg`That link doesn't match any release. It may have a typo, or the version hasn't shipped yet.`)}
      suggestions={latest ? [{ caption: t(msg`Latest`), release: latest }] : []}
    />
  );
}
