import { githubReleases } from "@/lib/github";
import { defaultOgAlt, ogContentType, ogSize, renderOgImage } from "@/lib/og";

export const size = ogSize;
export const contentType = ogContentType;
export const alt = defaultOgAlt;

export const revalidate = 3600;

export default async function Image() {
  const latest = (await githubReleases())?.releases[0];
  return renderOgImage({
    eyebrow: latest ? `Changelog · latest ${latest.tag}` : "Changelog",
    title: "What has been shipping",
    description: "Every published Reelsaw version, with a 90-day map of commits.",
  });
}
