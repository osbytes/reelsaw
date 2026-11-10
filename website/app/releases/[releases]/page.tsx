import { ArrowLeft, ArrowRight } from "lucide-react";
import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import type { ReactNode } from "react";
import { Footer } from "@/components/footer";
import { Header } from "@/components/header";
import { ReleaseCard, ReleaseDayList, ReleaseNotes, ReleasesNotFoundView, VersionBadge } from "@/components/release-list";
import { Breadcrumbs, JsonLd } from "@/components/seo";
import { githubReleases } from "@/lib/github";
import { formatUtcDate, type Release } from "@/lib/releases-data";
import { formatLongDay, groupReleasesByDay, releaseCount, releaseDay, releasePath, releaseTitle, resolveReleasesParam } from "@/lib/release-pages";
import { SITE } from "@/lib/site";
import { socialMeta } from "@/lib/social-meta";

export const revalidate = 3600;

type Props = { params: Promise<{ releases: string }> };

// One release per page is built ahead of time. A set (`v0.17.0..v0.19.1`, `v0.15.0,v0.18.2`,
// `2026-11-05..2026-11-10`) has too many spellings to list, so it renders on its first request.
export async function generateStaticParams() {
  const feed = await githubReleases();
  return (feed?.releases ?? []).map((r) => ({ releases: r.tag }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const feed = await githubReleases();
  const resolved = feed && resolveReleasesParam((await params).releases, feed.releases);
  if (!resolved) return { title: "Release not found", robots: { index: false, follow: true } };
  if (resolved.kind === "empty") return { title: resolved.heading, robots: { index: false, follow: true } };
  if (resolved.kind === "release") {
    const r = resolved.release;
    const url = releasePath(r.tag);
    const description = `Reelsaw ${r.tag}, released ${formatUtcDate(r.publishedAt)}: ${releaseTitle(r)}`;
    return {
      title: `${r.tag}: ${releaseTitle(r)}`,
      description,
      alternates: { canonical: url },
      ...socialMeta({ title: `Reelsaw ${r.tag}`, description, url }),
    };
  }
  const url = `/releases/${resolved.selection}`;
  const description = resolved.highlights.length ? resolved.highlights.join(" ") : `What shipped in Reelsaw ${resolved.label}.`;
  return {
    title: resolved.heading,
    description,
    alternates: { canonical: url },
    ...socialMeta({ title: resolved.heading.replace(/^What shipped( in)?/, "What shipped in Reelsaw"), description, url }),
    // Any mix of releases has a page, so only single releases are indexed; sets stay shareable.
    robots: { index: false, follow: true },
  };
}

export default async function ReleasesParamPage({ params }: Props) {
  const param = (await params).releases;
  const feed = await githubReleases();
  if (!feed) {
    return (
      <Shell crumb={{ href: `/releases/${param}`, label: decodeSafe(param) }}>
        <div className="card p-5 text-sm text-ink2">
          Could not load releases from GitHub just now.{" "}
          <a href={SITE.releases} target="_blank" rel="noreferrer" className="prose-link">
            Read them on GitHub
          </a>
          .
        </div>
      </Shell>
    );
  }
  const resolved = resolveReleasesParam(param, feed.releases);
  if (!resolved) notFound();

  if (resolved.kind === "release") return <ReleasePage {...resolved} />;

  // One spelling per set, so shared links and their previews agree. A set of one tag is that
  // release's page; a day with one release keeps its day link: it still means "what shipped then".
  if (resolved.kind === "set" && resolved.by === "tags" && resolved.releases.length === 1) {
    permanentRedirect(releasePath(resolved.releases[0]!.tag));
  }
  if (decodeSafe(param) !== resolved.selection) permanentRedirect(`/releases/${resolved.selection}`);

  if (resolved.kind === "empty") {
    return (
      <ReleasesNotFoundView
        title={resolved.heading}
        description="No release went out on those days. Here are the closest ones."
        suggestions={[
          ...(resolved.older ? [{ caption: "Before", release: resolved.older }] : []),
          ...(resolved.newer ? [{ caption: "After", release: resolved.newer }] : []),
        ]}
      />
    );
  }

  return (
    <Shell crumb={{ href: `/releases/${resolved.selection}`, label: resolved.selection }} wide>
      <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between md:gap-8">
        <header className="flex min-w-0 flex-col gap-1.5">
          <p className="text-sm text-ink3">
            <span className="tabular-nums">{releaseCount(resolved.releases.length)}</span> · {resolved.dayRange}
          </p>
          <h1 className="text-[26px] leading-tight font-extrabold tracking-tight text-balance sm:text-[32px]">{resolved.heading}</h1>
        </header>
        {resolved.highlights.length > 0 && (
          <div className="card w-full shrink-0 p-4 md:w-80">
            <p className="text-xs text-ink3">Highlights</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {resolved.highlights.map((h) => (
                <li key={h} className="flex gap-2 text-sm text-ink">
                  <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-ink" />
                  {h}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <section aria-label="Release notes" className="mt-4">
        <ReleaseDayList groups={groupReleasesByDay(resolved.releases)} />
      </section>
      <p className="text-sm">
        <a href="/releases" className="prose-link font-semibold">
          See every release
        </a>
      </p>
    </Shell>
  );
}

function ReleasePage({ release: r, newer, older, sameDay }: { release: Release; newer: Release | null; older: Release | null; sameDay: Release[] }) {
  return (
    <Shell crumb={{ href: releasePath(r.tag), label: r.tag }}>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "Article",
          headline: `Reelsaw ${r.tag}: ${releaseTitle(r)}`,
          datePublished: r.publishedAt,
          url: `${SITE.url}${releasePath(r.tag)}`,
          author: { "@type": "Organization", name: "osbytes", url: SITE.osbytes },
        }}
      />
      <article>
        <header className="mb-6 flex flex-col gap-3 border-b border-line pb-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink3">
            <VersionBadge tag={r.tag} />
            <span>
              Released <time dateTime={r.publishedAt}>{formatLongDay(releaseDay(r))}</time>
            </span>
            {r.prerelease && <span className="chip bg-warn-soft text-warn">Pre-release</span>}
            <a href={r.url} target="_blank" rel="noreferrer" className="ml-auto text-xs text-ink3 hover:text-acc-text">
              GitHub ↗
            </a>
          </div>
          <h1 className="text-[26px] leading-tight font-extrabold tracking-tight text-balance sm:text-[32px]">{releaseTitle(r)}</h1>
          {sameDay.length > 0 && (
            <p className="text-sm text-ink3">
              Also released that day:{" "}
              {sameDay.map((o, i) => (
                <span key={o.tag}>
                  {i > 0 ? ", " : null}
                  <a href={releasePath(o.tag)} className="font-mono font-medium text-ink hover:text-acc-text">
                    {o.tag}
                  </a>
                </span>
              ))}
            </p>
          )}
        </header>
        <ReleaseNotes release={r} />
      </article>

      <nav aria-label="Other releases" className="mt-6 grid gap-3 border-t border-line pt-6 sm:grid-cols-2">
        {older ? (
          <ReleaseCard
            release={older}
            caption={
              <span className="flex items-center gap-1">
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Older
              </span>
            }
          />
        ) : (
          <span aria-hidden className="hidden sm:block" />
        )}
        {newer ? (
          <ReleaseCard
            release={newer}
            align="end"
            caption={
              <span className="flex items-center gap-1">
                Newer <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </span>
            }
          />
        ) : null}
      </nav>
      <p className="text-sm">
        <a href={`/releases#${r.tag}`} className="prose-link font-semibold">
          See every release
        </a>
      </p>
    </Shell>
  );
}

function Shell({ crumb, wide = false, children }: { crumb: { href: string; label: string }; wide?: boolean; children: ReactNode }) {
  return (
    <>
      <Header />
      <main id="main" className={`container-page flex flex-col gap-5 py-6 sm:py-8 ${wide ? "max-w-[880px]" : "max-w-[720px]"}`}>
        <Breadcrumbs items={[{ href: "/", label: SITE.name }, { href: "/releases", label: "Releases" }, crumb]} />
        {children}
      </main>
      <Footer />
    </>
  );
}

function decodeSafe(param: string): string {
  try {
    return decodeURIComponent(param);
  } catch {
    return param;
  }
}
