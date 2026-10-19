import { GUIDES, guideBySlug } from "@/content/guides";
import {
  defaultOgAlt,
  defaultOgDescription,
  defaultOgTitle,
  ogBlurb,
  ogContentType,
  ogSize,
  renderOgImage,
} from "@/lib/og";

export const size = ogSize;
export const contentType = ogContentType;
export const alt = defaultOgAlt;

export function generateStaticParams() {
  return GUIDES.map((g) => ({ slug: g.slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const g = guideBySlug(slug);
  if (!g) {
    return renderOgImage({ title: defaultOgTitle, description: defaultOgDescription });
  }
  return renderOgImage({
    eyebrow: "Guide",
    title: g.h1,
    description: ogBlurb(g.metaDescription),
  });
}
