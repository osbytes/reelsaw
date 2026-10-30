import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GUIDES, guideBySlug } from "@/content/guides";
import { ALTERNATIVE_LINKS, GUIDE_NAV } from "@/content/links";
import { CHECKED } from "@/content/reelsaw";
import { ArticleHeader, DataTable, FaqSection, LinkList, TryIt } from "@/components/seo";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { SITE } from "@/lib/site";
import { socialMeta } from "@/lib/social-meta";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;
export function generateStaticParams() {
  return GUIDES.map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const g = guideBySlug(slug);
  if (!g) return {};
  const path = `/${g.slug}`;
  return {
    title: g.metaTitle,
    description: g.metaDescription,
    alternates: { canonical: path },
    ...socialMeta({ title: g.metaTitle, description: g.metaDescription, url: path, type: "article" }),
  };
}

export default async function GuidePage({ params }: Props) {
  const { slug } = await params;
  const g = guideBySlug(slug);
  if (!g) notFound();
  const navLabel = GUIDE_NAV.find((l) => l.href === `/${g.slug}`)?.label ?? g.h1;
  return (
    <>
      <Header />
      <main id="main" className="container-page flex max-w-[880px] flex-col gap-14 py-12 sm:py-16">
        <ArticleHeader
          crumbs={[
            { href: "/", label: SITE.name },
            { href: `/${g.slug}`, label: navLabel },
          ]}
          eyebrow="Guide"
          h1={g.h1}
          intro={g.intro}
        />
        {g.sections.map((s) => (
          <section key={s.heading} className="flex flex-col gap-4" aria-label={s.heading}>
            <h2 className="text-[24px] font-bold tracking-tight">{s.heading}</h2>
            {s.paragraphs &&
              !s.table &&
              s.paragraphs.map((p, i) => (
                <p key={i} className="text-[15px] leading-relaxed text-ink2">
                  {p}
                </p>
              ))}
            {s.bullets && (
              <ul className="grid gap-2 text-[15px] leading-relaxed text-ink2">
                {s.bullets.map((b) => (
                  <li key={b} className="flex gap-2">
                    <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-acc" aria-hidden />
                    {b}
                  </li>
                ))}
              </ul>
            )}
            {s.table && <DataTable caption={s.heading} table={s.table} />}
            {s.paragraphs &&
              s.table &&
              s.paragraphs.map((p, i) => (
                <p key={i} className="text-xs leading-relaxed text-ink3">
                  {p}
                </p>
              ))}
          </section>
        ))}
        <TryIt />
        <FaqSection faqs={g.faqs} />
        <LinkList heading="Related" links={[...GUIDE_NAV.filter((l) => l.href !== `/${g.slug}`), ...ALTERNATIVE_LINKS]} />
        <LinkList heading="Sources" links={g.sources} external />
        <p className="text-xs text-ink3">Last updated {CHECKED}.</p>
      </main>
      <Footer />
    </>
  );
}
