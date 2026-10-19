import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { COMPETITORS, competitorBySlug } from "@/content/competitors";
import { ALTERNATIVE_LINKS, GUIDE_NAV } from "@/content/links";
import { FEATURES, REELSAW_COST } from "@/content/reelsaw";
import { ArticleHeader, DataTable, FaqSection, LinkList, TryIt } from "@/components/seo";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { SITE } from "@/lib/site";
import { socialMeta } from "@/lib/social-meta";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;
export function generateStaticParams() {
  return COMPETITORS.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const c = competitorBySlug(slug);
  if (!c) return {};
  const path = `/alternatives/${c.slug}`;
  return {
    title: c.metaTitle,
    description: c.metaDescription,
    alternates: { canonical: path },
    ...socialMeta({ title: c.metaTitle, description: c.metaDescription, url: path, type: "article" }),
  };
}

export default async function AlternativePage({ params }: Props) {
  const { slug } = await params;
  const c = competitorBySlug(slug);
  if (!c) notFound();
  const related = ALTERNATIVE_LINKS.filter((l) => l.href !== `/alternatives/${c.slug}`);
  return (
    <>
      <Header />
      <main id="main" className="container-page flex max-w-[880px] flex-col gap-14 py-12 sm:py-16">
        <ArticleHeader
          crumbs={[
            { href: "/", label: SITE.name },
            { href: "/alternatives", label: "Alternatives" },
            { href: `/alternatives/${c.slug}`, label: c.name },
          ]}
          eyebrow={`Reelsaw vs ${c.name}`}
          h1={c.h1}
          intro={c.intro}
          checked={c.checked}
        />

        <section className="flex flex-col gap-4" aria-labelledby="them-cost">
          <h2 id="them-cost" className="text-[24px] font-bold tracking-tight">
            What {c.name} costs
          </h2>
          <p className="text-[15px] leading-relaxed text-ink2">{c.pricing.summary}</p>
          <DataTable caption={`${c.name} plans`} table={{ columns: ["Plan", "Price", "What it includes"], rows: c.pricing.plans.map((p) => [p.name, p.price, p.includes]) }} />
          {c.pricing.note && <p className="text-xs leading-relaxed text-ink3">{c.pricing.note}</p>}
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="us-cost">
          <h2 id="us-cost" className="text-[24px] font-bold tracking-tight">
            {REELSAW_COST.heading}
          </h2>
          {REELSAW_COST.paragraphs.map((p, i) => (
            <p key={i} className="text-[15px] leading-relaxed text-ink2">
              {p}
            </p>
          ))}
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="features">
          <h2 id="features" className="text-[24px] font-bold tracking-tight">
            {c.name} vs Reelsaw, feature by feature
          </h2>
          <DataTable caption={`${c.name} and Reelsaw compared`} table={{ columns: ["", "Reelsaw", c.name], rows: FEATURES.map((f) => [f.label, f.reelsaw, c.them[f.key]]) }} />
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="better">
          <h2 id="better" className="text-[24px] font-bold tracking-tight">
            What {c.name} does better
          </h2>
          <ul className="grid gap-2 text-[15px] leading-relaxed text-ink2">
            {c.betterAt.map((b) => (
              <li key={b} className="flex gap-2">
                <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-acc" aria-hidden />
                {b}
              </li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-5" aria-labelledby="pick">
          <h2 id="pick" className="text-[24px] font-bold tracking-tight">
            Which one should you pick?
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="card flex flex-col gap-3 p-5">
              <h3 className="text-[16px] font-bold">Pick {c.name} if</h3>
              <ul className="grid gap-2 text-sm leading-relaxed text-ink2">
                {c.pickThem.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
            <div className="card flex flex-col gap-3 border-acc/40 p-5">
              <h3 className="text-[16px] font-bold">Pick Reelsaw if</h3>
              <ul className="grid gap-2 text-sm leading-relaxed text-ink2">
                {c.pickReelsaw.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <TryIt />
        <FaqSection faqs={c.faqs} />
        <LinkList heading="Related comparisons" links={[...related, ...GUIDE_NAV]} />
        <LinkList heading="Sources" links={c.sources} external />
        <p className="text-xs text-ink3">Last updated {c.checked}.</p>
      </main>
      <Footer />
    </>
  );
}
