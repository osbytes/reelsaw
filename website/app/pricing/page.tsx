import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Check } from "lucide-react";
import { PRICING } from "@/content/pricing";
import { Breadcrumbs } from "@/components/seo";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { SITE } from "@/lib/site";

const title = "Pricing: self-host for free, or let us host it";
const description = "Reelsaw is AGPL-3.0 software you can run yourself for $0. The hosted service at app.reelsaw.com has a Free plan (first video up to 60 minutes, then 20 minutes a month), Starter at $12, Creator at $29 and Pro at $59 a month, metered in minutes of source video.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/pricing" },
  openGraph: { title, description, url: "/pricing" },
  twitter: { title, description },
};

const gb = (mb: number) => (mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`);

export default function PricingPage() {
  // the hosted service is not announced until NEXT_PUBLIC_HOSTED_URL is set (lib/site.ts)
  if (!SITE.hosted) notFound();
  return (
    <>
      <Header />
      <main id="main" className="container-page flex max-w-[980px] flex-col gap-12 py-12 sm:py-16">
        <header className="flex flex-col gap-5">
          <Breadcrumbs items={[{ href: "/", label: SITE.name }, { href: "/pricing", label: "Pricing" }]} />
          <p className="eyebrow">Pricing</p>
          <h1 className="text-[32px] leading-[1.1] font-extrabold tracking-tight text-balance sm:text-[44px]">Self-host for free, or let us host it</h1>
          <p className="max-w-[70ch] text-[16px] leading-relaxed text-ink2 text-pretty">
            The software is AGPL-3.0: install it on your own machine and there is no plan, no meter and no watermark. The hosted service runs the same code on our machines with cloud models, and is priced by minutes of source video a month. Every plan has every feature, including the MCP server for agents.
          </p>
        </header>

        <section aria-labelledby="hosted" className="flex flex-col gap-5">
          <h2 id="hosted" className="text-[22px] font-bold tracking-tight">
            Hosted at app.reelsaw.com
          </h2>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PRICING.map((p) => (
              <li key={p.name} className={`card flex flex-col gap-4 p-6 ${p.name === "creator" ? "border-acc" : ""}`}>
                {/* fixed-height header and price rows, so the four cards' prices, notes and bullet lists line up */}
                <div className="flex min-h-[4.75rem] flex-col gap-1">
                  <span className="text-[17px] font-bold tracking-tight">{p.label}</span>
                  <span className="text-sm leading-relaxed text-ink2">{p.blurb}</span>
                </div>
                <div className="flex h-11 items-baseline gap-1.5">
                  <span className="text-[34px] font-extrabold tracking-tight tabular-nums">{p.price ? `$${p.price.month}` : "$0"}</span>
                  <span className="text-sm text-ink3">{p.price ? "/ month" : "forever"}</span>
                </div>
                <p className="min-h-9 text-xs leading-relaxed text-ink3">{p.price ? `or $${p.price.year} a year (two months free)` : "No card needed"}</p>
                <ul className="flex flex-col gap-2 text-sm text-ink2">
                  {p.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-2">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-acc-text" aria-hidden />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
                <a href={`${SITE.app}/signup?plan=${p.name}`} className={`${p.name === "creator" ? "btn-primary" : "btn-ghost"} mt-auto h-[42px] justify-center`}>
                  {p.price ? `Start with ${p.label}` : "Start for free"}
                </a>
              </li>
            ))}
          </ul>
          <p className="text-sm leading-relaxed text-ink3">
            Prices in USD; tax is added at checkout where it applies. A plan's minutes count the length of the videos you add in the billing period, never per clip; on Free, your first video is free up to 60 minutes. When minutes run out, the app says so and tells you when they reset. Storage counts sources, uploads and rendered clips; delete a project to make room. Plans change on Stripe's portal and are prorated. Limits: {PRICING.map((p) => `${p.label} ${p.minutes} min, ${gb(p.storageMb)}, ${p.projects ? `${p.projects} projects` : "unlimited projects"}`).join("; ")}. Same prices as OpenShorts Cloud, so the choice is the pipeline and the licence.
          </p>
        </section>

        <section aria-labelledby="self" className="card flex flex-col gap-3 p-6">
          <h2 id="self" className="text-[22px] font-bold tracking-tight">
            Self-hosted: $0
          </h2>
          <p className="max-w-[72ch] text-sm leading-relaxed text-ink2">
            One command installs it on macOS, Linux or Windows. Fully local models cost nothing per minute; with cloud models you pay the vendor's metered price (roughly $0.02 to $0.04 per minute of video on Haiku-class models and Deepgram) and no Reelsaw margin. Multi-user installs get admin approval, per-user quotas and usage, and an optional watermark for accounts that are not admins. Everything in the hosted service except billing is in the open-source build.
          </p>
          <div className="flex flex-wrap gap-3">
            <a href="/#install" className="btn-primary h-[42px]">
              Install Reelsaw
            </a>
            <a href={SITE.deployDocs} target="_blank" rel="noreferrer" className="btn-ghost h-[42px]">
              Deploying and hosting
            </a>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
