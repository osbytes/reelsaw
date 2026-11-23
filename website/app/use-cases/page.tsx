import { msg } from "@lingui/core/runtime-macro";
import { t } from "@/lib/i18n";
import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { GUIDE_NAV } from "@/content/links";
import { USE_CASES } from "@/content/use-cases";
import { Breadcrumbs, LinkList, TryIt } from "@/components/seo";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { SITE } from "@/lib/site";
import { socialMeta } from "@/lib/social-meta";

const title = t(msg`AI clips by use case: GTA 6, Twitch, Kick and clipping campaigns`);
const description = t(
  msg`What Reelsaw, the open-source AI clipper, does with GTA 6 and GTA RP streams, Twitch and Kick VODs, paid clipping campaigns and podcasts, and what it does not.`,
);

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/use-cases" },
  ...socialMeta({ title, description, url: "/use-cases" }),
};

export default function UseCasesIndex() {
  return (
    <>
      <Header />
      <main id="main" className="container-page flex max-w-[880px] flex-col gap-12 py-12 sm:py-16">
        <header className="flex flex-col gap-5">
          <Breadcrumbs
            items={[
              { href: "/", label: SITE.name },
              { href: "/use-cases", label: t(msg`Use cases`) },
            ]}
          />
          <p className="eyebrow">{t(msg`Use cases`)}</p>
          <h1 className="text-[32px] leading-[1.1] font-extrabold tracking-tight text-balance sm:text-[44px]">
            {t(msg`AI clips for streams, gaming and clipping campaigns`)}
          </h1>
          <p className="max-w-[70ch] text-[16px] leading-relaxed text-ink2 text-pretty">
            {t(
              msg`The pipeline is the same for every source: transcribe, pick the moments that stand on their own, frame for a phone, caption word by word. What changes is the footage. Each page says how Reelsaw handles that kind of video, and where it is the wrong tool: it picks moments from speech, so footage with nobody talking is not a fit.`,
            )}
          </p>
        </header>
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {USE_CASES.map((u) => (
            <li key={u.slug}>
              <a href={`/${u.slug}`} className="card flex h-full flex-col gap-2 p-5 transition hover:border-line2 hover:bg-sunk/40">
                <span className="eyebrow">{u.hint}</span>
                <span className="text-[17px] font-bold tracking-tight">{u.h1}</span>
                <span className="text-sm leading-relaxed text-ink2">{u.metaDescription}</span>
                <span className="mt-auto flex items-center gap-1 pt-2 text-sm font-semibold text-acc-text">
                  {t(msg`Read more `)}
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </span>
              </a>
            </li>
          ))}
        </ul>
        <TryIt />
        <LinkList heading={t(msg`Guides`)} links={GUIDE_NAV} />
      </main>
      <Footer />
    </>
  );
}
