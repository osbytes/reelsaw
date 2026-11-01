import { COMPETITORS, competitorBySlug } from "@/content/competitors";
import { defaultOgAlt, defaultOgDescription, defaultOgTitle, ogBlurb, ogContentType, ogSize, renderOgImage } from "@/lib/og";

export const size = ogSize;
export const contentType = ogContentType;
export const alt = defaultOgAlt;

export function generateStaticParams() {
  return COMPETITORS.map((c) => ({ slug: c.slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const c = competitorBySlug(slug);
  if (!c) {
    return renderOgImage({ title: defaultOgTitle, description: defaultOgDescription });
  }
  return renderOgImage({
    eyebrow: `Reelsaw vs ${c.name}`,
    title: c.h1,
    description: ogBlurb(c.metaDescription),
  });
}
