import type { LegalSection } from "@/content/legal";
import { LEGAL_UPDATED } from "@/content/legal";
import { Breadcrumbs } from "@/components/seo";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { SITE } from "@/lib/site";

/** One layout for the terms and the privacy policy: a dated heading and plain sections. */
export function LegalPage({ slug, title, intro, sections }: { slug: string; title: string; intro: string; sections: LegalSection[] }) {
  return (
    <>
      <Header />
      <main id="main" className="container-page flex max-w-[760px] flex-col gap-10 py-12 sm:py-16">
        <header className="flex flex-col gap-4">
          <Breadcrumbs items={[{ href: "/", label: SITE.name }, { href: `/${slug}`, label: title }]} />
          <h1 className="text-[32px] leading-[1.1] font-extrabold tracking-tight text-balance sm:text-[40px]">{title}</h1>
          <p className="text-sm text-ink3">Last updated {LEGAL_UPDATED}</p>
          <p className="max-w-[70ch] text-[16px] leading-relaxed text-ink2 text-pretty">{intro}</p>
        </header>
        {sections.map((s) => (
          <section key={s.heading} className="flex flex-col gap-3">
            <h2 className="text-[20px] font-bold tracking-tight">{s.heading}</h2>
            {s.paragraphs.map((p) => (
              <p key={p} className="text-[15px] leading-relaxed text-ink2">
                {p}
              </p>
            ))}
            {s.bullets && (
              <ul className="flex list-disc flex-col gap-1.5 pl-5 text-[15px] leading-relaxed text-ink2">
                {s.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </main>
      <Footer />
    </>
  );
}
