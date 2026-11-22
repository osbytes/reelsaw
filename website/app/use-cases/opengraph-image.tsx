import { defaultOgAlt, ogBlurb, ogContentType, ogSize, renderOgImage } from "@/lib/og";

export const alt = `${defaultOgAlt} — use cases`;
export const size = ogSize;
export const contentType = ogContentType;

export default function Image() {
  return renderOgImage({
    eyebrow: "Use cases",
    title: "AI clips for streams, gaming, podcasts and clipping campaigns",
    description: ogBlurb(
      "GTA 6 and GTA RP streams, Twitch and Kick VODs, paid clipping campaigns and podcasts: what Reelsaw does with each, and what it does not.",
    ),
  });
}
