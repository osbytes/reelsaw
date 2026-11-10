import type { ReactNode } from "react";
import { Footer } from "./footer";
import { Header } from "./header";
import { formatUtcDate, type Release, type ReleaseNote } from "@/lib/releases-data";
import { type ReleaseDayGroup, releasePath, releaseTitle } from "@/lib/release-pages";
import { SITE } from "@/lib/site";

export function utcDate(iso: string) {
  return formatUtcDate(iso);
}

/** The release's tag, e.g. `v0.19.1`: what names a changelog entry. */
export function VersionBadge({ tag, className = "" }: { tag: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border border-line bg-sunk px-2 py-0.5 font-mono text-xs font-medium text-ink tabular-nums ${className}`}
    >
      {tag}
    </span>
  );
}

/** A release as a link card: the latest release, older / newer, or the ones around an empty day. */
export function ReleaseCard({ release: r, caption, align = "start" }: { release: Release; caption: ReactNode; align?: "start" | "end" }) {
  return (
    <a
      href={releasePath(r.tag)}
      className={`card group flex flex-col gap-2 p-4 no-underline hover:border-line2 ${align === "end" ? "items-end text-right" : ""}`}
    >
      <span className={`flex w-full items-center gap-3 text-xs text-ink3 ${align === "end" ? "justify-end" : "justify-between"}`}>
        <span>{caption}</span>
        <time dateTime={r.publishedAt}>{utcDate(r.publishedAt)}</time>
      </span>
      <span className={`flex items-start gap-2 ${align === "end" ? "flex-row-reverse" : ""}`}>
        <VersionBadge tag={r.tag} className="mt-px shrink-0" />
        <span className="line-clamp-2 text-sm font-medium text-ink group-hover:text-acc-text">{releaseTitle(r)}</span>
      </span>
    </a>
  );
}

export function ReleaseNotes({ release: r }: { release: Release }) {
  return r.notes.length ? (
    <ul className="flex flex-col gap-2.5">
      {r.notes.map((n, i) => (
        <li key={`${n.sha ?? n.pr ?? i}-${n.text.slice(0, 24)}`} className="text-sm leading-relaxed text-ink2">
          <NoteText note={n} />
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-sm text-ink2">{r.summary || r.name}</p>
  );
}

/**
 * Releases under the day they shipped, each with its notes. The changelog and the set pages
 * (`/releases/v0.17.0..v0.19.1`) share it. A sticky rail shows the month, the day and each tag
 * that shipped that day; each release's tag stays pinned under the site header while its notes
 * scroll past. The day keeps a `#YYYY-MM-DD` anchor, each release its `#vX.Y.Z` one.
 */
export function ReleaseDayList({ groups, current }: { groups: ReleaseDayGroup[]; current?: string | null }) {
  return (
    <div className="flex flex-col gap-12 md:gap-16">
      {groups.map((g) => (
        <section key={g.date} id={g.date} aria-label={g.dayLabel} className="scroll-mt-24 md:grid md:grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] md:gap-8">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 md:sticky md:top-[84px] md:mb-0 md:block md:self-start">
            <p className="hidden text-xs font-semibold tracking-wide text-ink3 uppercase md:block">{g.monthLabel}</p>
            <a
              href={releasePath(g.date)}
              className="block text-sm font-semibold text-ink3 no-underline hover:text-ink md:mt-1 md:text-[28px] md:leading-none md:font-bold md:tracking-tight md:text-ink md:tabular-nums"
            >
              <time dateTime={g.date}>
                <span className="md:hidden">{g.dayLabel}</span>
                <span className="hidden md:inline">{g.dayOfMonth}</span>
              </time>
            </a>
            <ul className="flex flex-wrap gap-x-2 gap-y-1 md:mt-2">
              {g.releases.map((r) => (
                <li key={r.tag}>
                  <a href={`#${r.tag}`} className="font-mono text-xs text-ink3 hover:text-ink">
                    {r.tag}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col md:border-l md:border-line">
            {g.releases.map((r, i) => (
              <ReleaseArticle key={r.tag} release={r} current={current} first={i === 0} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ReleaseArticle({ release: r, current, first }: { release: Release; current?: string | null; first: boolean }) {
  const you = current && (current === r.version || current === r.tag);
  return (
    <article id={r.tag} className={`relative scroll-mt-24 md:pl-7 ${first ? "" : "mt-8 border-t border-dashed border-line2 pt-8"}`}>
      <span
        aria-hidden
        className={`absolute left-0 hidden h-2.5 w-2.5 -translate-x-[calc(50%+0.5px)] rounded-full border-2 border-line2 bg-panel md:block ${first ? "top-[18px]" : "top-[50px]"}`}
      />
      <header className="sticky top-[60px] z-10 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-bg/95 py-2.5 backdrop-blur">
        <h2 className="font-mono text-[20px] font-bold tracking-tight">
          <a href={releasePath(r.tag)} className="text-ink no-underline hover:text-acc-text">
            {r.version}
          </a>
        </h2>
        <time dateTime={r.publishedAt} className="text-sm text-ink3 md:hidden">
          {utcDate(r.publishedAt)}
        </time>
        {r.prerelease && <span className="chip bg-warn-soft text-warn">Pre-release</span>}
        {you && <span className="chip bg-acc-soft text-acc-text">This install</span>}
        <a href={r.url} target="_blank" rel="noreferrer" className="ml-auto text-xs text-ink3 hover:text-acc-text">
          GitHub ↗
        </a>
      </header>
      <ReleaseNotes release={r} />
    </article>
  );
}

function NoteText({ note }: { note: ReleaseNote }) {
  return (
    <>
      {note.pr ? (
        <>
          <a href={`${SITE.github}/pull/${note.pr}`} target="_blank" rel="noreferrer" className="prose-link font-mono text-[12px]">
            #{note.pr}
          </a>{" "}
        </>
      ) : null}
      {note.sha ? (
        <>
          <a href={`${SITE.github}/commit/${note.sha}`} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-ink3 hover:text-acc-text">
            {note.sha.slice(0, 7)}
          </a>{" "}
        </>
      ) : null}
      {note.text}
    </>
  );
}

/**
 * A changelog link that shows nothing: an unknown tag, a link that isn't a selection, or days
 * nothing shipped on. It keeps the reader in the changelog instead of the site's generic 404.
 */
export function ReleasesNotFoundView({
  title,
  description,
  suggestions,
}: {
  title: string;
  description: string;
  suggestions: { caption: ReactNode; release: Release }[];
}) {
  return (
    <>
      <Header />
      <main id="main" className="container-page flex max-w-[560px] flex-col items-center gap-4 py-20 text-center">
        <p className="eyebrow">Releases</p>
        <h1 className="text-[28px] leading-tight font-extrabold tracking-tight text-balance">{title}</h1>
        <p className="max-w-[44ch] text-ink2">{description}</p>
        {suggestions.length > 0 && (
          <ul className="mt-2 flex w-full flex-col gap-3 text-left">
            {suggestions.map(({ caption, release }) => (
              <li key={release.tag}>
                <ReleaseCard release={release} caption={caption} />
              </li>
            ))}
          </ul>
        )}
        <a href="/releases" className="prose-link mt-2 font-semibold">
          See every release
        </a>
      </main>
      <Footer />
    </>
  );
}

/** The home page's "Recently shipped" list: the newest releases, each linking to its page. */
export function RecentReleases({ releases }: { releases: Release[] }) {
  return (
    <div className="card mx-auto w-full max-w-[720px] p-5 sm:p-6">
      <ol className="border-b border-line">
        {releases.map((r) => (
          <li key={r.tag} className="flex gap-4 border-t border-line py-3 text-sm first:border-t-0 first:pt-0">
            <span className="flex w-24 flex-none flex-col gap-0.5">
              <span className="font-mono text-xs text-ink">{r.tag}</span>
              <time dateTime={r.publishedAt} className="text-xs text-ink3">
                {utcDate(r.publishedAt)}
              </time>
            </span>
            <a href={releasePath(r.tag)} className="line-clamp-2 text-ink2 no-underline hover:text-acc-text">
              {releaseTitle(r)}
            </a>
          </li>
        ))}
      </ol>
      <a href="/releases" className="prose-link mt-4 inline-block text-sm font-semibold">
        Read the changelog
      </a>
    </div>
  );
}
