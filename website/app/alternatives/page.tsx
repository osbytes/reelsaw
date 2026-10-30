import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { COMPETITORS } from "@/content/competitors";
import { GUIDE_NAV } from "@/content/links";
import { CHECKED } from "@/content/reelsaw";
import { Breadcrumbs, LinkList, TryIt } from "@/components/seo";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { SITE } from "@/lib/site";
import { socialMeta } from "@/lib/social-meta";

const title = "Reelsaw vs Opus Clip, Klap, Vizard, Submagic and more";
const description =
  "Reelsaw, the open-source AI clipper, compared with Opus Clip, Klap, Vizard, Submagic, 2short.ai, quso.ai and OpenShorts: prices, free tiers and watermarks.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/alternatives" },
  ...socialMeta({ title, description, url: "/alternatives" }),
};

export default function AlternativesIndex() {
  return (
    <>
      <Header />
      <main id="main" className="container-page flex max-w-[880px] flex-col gap-12 py-12 sm:py-16">
        <header className="flex flex-col gap-5">
          <Breadcrumbs
            items={[
              { href: "/", label: SITE.name },
              { href: "/alternatives", label: "Alternatives" },
            ]}
          />
          <p className="eyebrow">Alternatives</p>
          <h1 className="text-[32px] leading-[1.1] font-extrabold tracking-tight text-balance sm:text-[44px]">How Reelsaw compares to the hosted clippers</h1>
          <p className="max-w-[70ch] text-[16px] leading-relaxed text-ink2 text-pretty">
            Every page below says what the other tool does better, what it costs on the date checked, and when Reelsaw is the wrong pick. Prices come from each
            vendor's public pricing page; Reelsaw's claims come from its README and source.
          </p>
        </header>
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {COMPETITORS.map((c) => (
            <li key={c.slug}>
              <a href={`/alternatives/${c.slug}`} className="card flex h-full flex-col gap-2 p-5 transition hover:border-line2 hover:bg-sunk/40">
                <span className="eyebrow">Reelsaw vs {c.name}</span>
                <span className="text-[17px] font-bold tracking-tight">{c.h1}</span>
                <span className="text-sm leading-relaxed text-ink2">{c.pricing.summary}</span>
                <span className="mt-auto flex items-center gap-1 pt-2 text-sm font-semibold text-acc-text">
                  Read the comparison <ArrowRight className="h-4 w-4" aria-hidden />
                </span>
              </a>
            </li>
          ))}
        </ul>
        <TryIt />
        <LinkList heading="Guides" links={GUIDE_NAV} />
        <p className="text-xs text-ink3">Pricing checked {CHECKED}. Vendors change plans without notice; verify before you buy.</p>
      </main>
      <Footer />
    </>
  );
}
