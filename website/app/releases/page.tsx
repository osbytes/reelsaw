import { msg } from "@lingui/core/runtime-macro";
import { t, rich } from "@/lib/i18n";
import type { Metadata } from "next";
import { Breadcrumbs } from "@/components/seo";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { ReleaseCard, ReleaseDayList } from "@/components/release-list";
import { ReleasesView } from "@/components/releases-view";
import { githubReleases } from "@/lib/github";
import { groupReleasesByDay } from "@/lib/release-pages";
import { SITE } from "@/lib/site";
import { socialMeta } from "@/lib/social-meta";

export const revalidate = 3600;

const title = t(msg`Releases`);
const description = t(
  msg`Every published Reelsaw version with its change notes, newest first, and a 90-day map of commits to the open-source repo. Days we tagged a release light up.`,
);

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/releases" },
  ...socialMeta({ title: t(msg`${{ title: title }}: what has been shipping`), description, url: "/releases" }),
};

export default async function ReleasesPage() {
  const feed = await githubReleases();
  const latest = feed?.releases[0];
  const heading = (
    <header className="flex min-w-0 flex-1 flex-col gap-1.5">
      <h1 className="text-[22px] leading-tight font-extrabold tracking-tight sm:text-[28px]">{t(msg`What has been shipping`)}</h1>
      <p className="text-sm leading-snug text-ink2 text-pretty">
        {rich(msg`Every published version, newest first. A ring is a ship day. <0>GitHub ↗</0><1> · </1><2>RSS</2>`, {
          0: (c) => (
            <a href={SITE.releases} target="_blank" rel="noreferrer" className="text-ink2 hover:text-ink">
              {c}
            </a>
          ),
          1: (c) => <span className="text-ink3">{c}</span>,
          2: (c) => (
            <a href="/releases/feed.xml" className="text-ink2 hover:text-ink">
              {c}
            </a>
          ),
        })}
      </p>
      {feed && (
        <p className="text-xs leading-snug text-ink3">
          {rich(msg`<0/> commit<1/> over <2/> days, <3/> day<4/> with a release.`, {
            0: feed.commits,
            1: feed.commits === 1 ? "" : "s",
            2: feed.windowDays,
            3: feed.releaseDays,
            4: feed.releaseDays === 1 ? "" : "s",
          })}
        </p>
      )}
      {latest && (
        <div className="mt-2 w-full sm:w-80">
          <ReleaseCard release={latest} caption={t(msg`Latest release`)} />
        </div>
      )}
    </header>
  );
  return (
    <>
      <Header />
      <main id="main" className="container-page flex max-w-[880px] flex-col gap-5 py-6 sm:py-8">
        <Breadcrumbs
          items={[
            { href: "/", label: SITE.name },
            { href: "/releases", label: t(msg`Releases`) },
          ]}
        />
        {feed ? (
          <ReleasesView feed={feed} heading={heading}>
            <ReleaseDayList groups={groupReleasesByDay(feed.releases)} />
          </ReleasesView>
        ) : (
          <>
            {heading}
            <div className="card p-5 text-sm text-ink2">
              {rich(msg`Could not load releases from GitHub just now. <0>Read them on GitHub</0>.`, {
                0: (c) => (
                  <a href={SITE.releases} target="_blank" rel="noreferrer" className="prose-link">
                    {c}
                  </a>
                ),
              })}
            </div>
          </>
        )}
      </main>
      <Footer />
    </>
  );
}
