import { msg } from "@lingui/core/runtime-macro";
import { t } from "@/lib/i18n";
import { ARTICLES, articleBySlug } from "@/content/articles";
import { defaultOgAlt, defaultOgDescription, defaultOgTitle, ogBlurb, ogContentType, ogSize, renderOgImage } from "@/lib/og";

export const size = ogSize;
export const contentType = ogContentType;
export const alt = defaultOgAlt;

export function generateStaticParams() {
  return ARTICLES.map((a) => ({ slug: a.page.slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const a = articleBySlug(slug);
  if (!a) {
    return renderOgImage({ title: defaultOgTitle, description: defaultOgDescription });
  }
  return renderOgImage({
    eyebrow: a.kind === "useCase" ? t(msg`Use case`) : t(msg`Guide`),
    title: a.page.h1,
    description: ogBlurb(a.page.metaDescription),
  });
}
