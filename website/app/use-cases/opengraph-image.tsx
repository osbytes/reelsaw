import { msg } from "@lingui/core/runtime-macro";
import { t } from "@/lib/i18n";
import { defaultOgAlt, ogBlurb, ogContentType, ogSize, renderOgImage } from "@/lib/og";

export const alt = t(msg`${{ defaultOgAlt: defaultOgAlt }} — use cases`);
export const size = ogSize;
export const contentType = ogContentType;

export default function Image() {
  return renderOgImage({
    eyebrow: t(msg`Use cases`),
    title: t(msg`AI clips for streams, gaming, podcasts and clipping campaigns`),
    description: ogBlurb(
      t(msg`GTA 6 and GTA RP streams, Twitch and Kick VODs, paid clipping campaigns and podcasts: what Reelsaw does with each, and what it does not.`),
    ),
  });
}
