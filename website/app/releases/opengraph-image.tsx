import { msg } from "@lingui/core/runtime-macro";
import { t } from "@/lib/i18n";
import { githubReleases } from "@/lib/github";
import { defaultOgAlt, ogContentType, ogSize, renderOgImage } from "@/lib/og";

export const size = ogSize;
export const contentType = ogContentType;
export const alt = defaultOgAlt;

export const revalidate = 3600;

export default async function Image() {
  const latest = (await githubReleases())?.releases[0];
  return renderOgImage({
    eyebrow: latest ? t(msg`Changelog · latest ${{ tag: latest.tag }}`) : t(msg`Changelog`),
    title: t(msg`What has been shipping`),
    description: t(msg`Every published Reelsaw version, with a 90-day map of commits.`),
  });
}
