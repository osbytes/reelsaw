import type { Metadata } from "next";
import { Breadcrumbs } from "@/components/seo";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { ReleasesView } from "@/components/releases-view";
import { githubReleases } from "@/lib/github";
import { formatUtcDate } from "@/lib/releases-data";
import { SITE } from "@/lib/site";
import { socialMeta } from "@/lib/social-meta";

export const revalidate = 3600;

const title = "Releases";
const description = "Every published Reelsaw version with its change notes, newest first, and a 90-day map of commits to the open-source repo. Days we tagged a release light up.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/releases" },
  ...socialMeta({ title: `${title}: what has been shipping`, description, url: "/releases" }),
};

export default async function ReleasesPage() {
  const feed = await githubReleases();
  const latest = feed?.releases[0];
  const heading = (
    <header className="flex min-w-0 flex-1 flex-col gap-1.5">
      <h1 className="text-[22px] leading-tight font-extrabold tracking-tight sm:text-[28px]">What has been shipping</h1>
      <p className="text-sm leading-snug text-ink2 text-pretty">
        Newest first.
        {latest ? ` Latest is ${latest.version}, ${formatUtcDate(latest.publishedAt)}.` : ""} A ring is a ship day.{" "}
        <a href={SITE.releases} target="_blank" rel="noreferrer" className="text-ink2 hover:text-ink">
          GitHub ↗
        </a>
        <span className="text-ink3"> · </span>
        <a href="/releases/feed.xml" className="text-ink2 hover:text-ink">
          RSS
        </a>
      </p>
      {feed && (
        <p className="text-xs leading-snug text-ink3">
          {feed.commits} commit{feed.commits === 1 ? "" : "s"} over {feed.windowDays} days, {feed.releaseDays} day
          {feed.releaseDays === 1 ? "" : "s"} with a release.
        </p>
      )}
    </header>
  );
  return (
    <>
      <Header />
      <main id="main" className="container-page flex max-w-[880px] flex-col gap-5 py-6 sm:py-8">
        <Breadcrumbs items={[{ href: "/", label: SITE.name }, { href: "/releases", label: "Releases" }]} />
        {feed ? (
          <ReleasesView feed={feed} heading={heading} />
        ) : (
          <>
            {heading}
            <div className="card p-5 text-sm text-ink2">
              Could not load releases from GitHub just now.{" "}
              <a href={SITE.releases} target="_blank" rel="noreferrer" className="prose-link">
                Read them on GitHub
              </a>
              .
            </div>
          </>
        )}
      </main>
      <Footer />
    </>
  );
}
