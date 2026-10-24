import { defaultOgAlt, ogContentType, ogSize, renderOgImage } from "@/lib/og";

export const size = ogSize;
export const contentType = ogContentType;
export const alt = defaultOgAlt;

export default async function Image() {
  return renderOgImage({
    eyebrow: "Changelog",
    title: "What has been shipping",
    description: "Every published Reelsaw version, with a 90-day map of commits.",
  });
}
