import { msg } from "@lingui/core/runtime-macro";
import { t } from "@/lib/i18n";
import { CHECKED } from "@/content/reelsaw";
import { defaultOgAlt, ogBlurb, ogContentType, ogSize, renderOgImage } from "@/lib/og";

export const alt = t(msg`${{ defaultOgAlt: defaultOgAlt }} — alternatives`);
export const size = ogSize;
export const contentType = ogContentType;

export default function Image() {
  return renderOgImage({
    eyebrow: t(msg`Alternatives`),
    title: t(msg`How Reelsaw compares to the hosted clippers`),
    description: ogBlurb(
      t(msg`Honest comparisons with Opus Clip, Klap, Vizard, Submagic and more: prices, free tiers, watermarks and features, checked ${{ checked: CHECKED }}.`),
    ),
  });
}
