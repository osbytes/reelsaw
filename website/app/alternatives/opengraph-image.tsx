import { CHECKED } from "@/content/reelsaw";
import { defaultOgAlt, ogBlurb, ogContentType, ogSize, renderOgImage } from "@/lib/og";

export const alt = `${defaultOgAlt} — alternatives`;
export const size = ogSize;
export const contentType = ogContentType;

export default function Image() {
  return renderOgImage({
    eyebrow: "Alternatives",
    title: "How Reelsaw compares to the hosted clippers",
    description: ogBlurb(
      `Honest comparisons with Opus Clip, Klap, Vizard, Submagic and more: prices, free tiers, watermarks and features, checked ${CHECKED}.`,
    ),
  });
}
