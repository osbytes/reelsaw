import { msg } from "@lingui/core/runtime-macro";
import { t } from "@/lib/i18n";
import { GitHubMark, Logo } from "./logo";
import { ALTERNATIVE_LINKS, GUIDE_NAV, USE_CASE_NAV } from "@/content/links";
import { SITE } from "@/lib/site";

const COLUMNS: { title: string; links: { href: string; label: string }[] }[] = [
  {
    title: t(msg`Project`),
    links: [
      { href: "/pricing", label: t(msg`Pricing`) },
      { href: SITE.github, label: t(msg`Source on GitHub`) },
      { href: SITE.changelog, label: t(msg`Releases`) },
      { href: SITE.docker, label: t(msg`Docker image (GHCR)`) },
      { href: SITE.license, label: t(msg`License (AGPL-3.0)`) },
    ],
  },
  {
    title: t(msg`Docs`),
    links: [
      { href: `${SITE.github}#readme`, label: "README" },
      { href: SITE.deployDocs, label: t(msg`Deploying and hosting`) },
      { href: SITE.layoutsDocs, label: t(msg`Framing layouts`) },
      { href: SITE.mcpDocs, label: t(msg`MCP server`) },
      { href: SITE.cliDocs, label: t(msg`Operator CLI`) },
    ],
  },
  {
    title: t(msg`Use cases`),
    links: [{ href: "/use-cases", label: t(msg`All use cases`) }, ...USE_CASE_NAV],
  },
  {
    title: t(msg`Compare`),
    links: [{ href: "/alternatives", label: t(msg`All comparisons`) }, ...ALTERNATIVE_LINKS.slice(0, 4), ...GUIDE_NAV],
  },
  {
    title: t(msg`Community`),
    links: [
      { href: SITE.issues, label: t(msg`Issues and feature requests`) },
      { href: SITE.contributing, label: t(msg`Contributing`) },
      { href: SITE.glama, label: t(msg`Glama MCP listing`) },
      { href: "/terms", label: t(msg`Terms of service`) },
      { href: "/privacy", label: t(msg`Privacy policy`) },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-line bg-panel/40">
      <div className="container-page grid grid-cols-1 gap-10 py-14 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.4fr)_repeat(5,minmax(0,1fr))]">
        <div className="flex flex-col gap-3">
          <Logo />
          <p className="max-w-[34ch] text-sm leading-relaxed text-ink2">
            {t(
              msg`AI-powered long-form to short-form video clipper. Self-host, or use app.reelsaw.com. Pure TypeScript, any AI vendor, one-step Docker deploy.`,
            )}
          </p>
          <a href={SITE.github} target="_blank" rel="noreferrer" className="btn-ghost w-fit">
            <GitHubMark />
            {t(msg` osbytes/reelsaw`)}
          </a>
        </div>
        {COLUMNS.map((c) => (
          <nav key={c.title} aria-label={c.title} className="flex flex-col gap-2.5">
            <h2 className="text-xs font-semibold tracking-[0.08em] text-ink3 uppercase">{c.title}</h2>
            {c.links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                {...(l.href.startsWith("/") ? {} : { target: "_blank", rel: "noreferrer" })}
                className="text-sm text-ink2 hover:text-ink"
              >
                {l.label}
              </a>
            ))}
          </nav>
        ))}
      </div>
      <div className="border-t border-line">
        <div className="container-page flex flex-col gap-3 py-5 text-xs text-ink3 sm:flex-row sm:items-center sm:justify-between">
          <p>{t(msg`Reelsaw is free software released under the GNU AGPL-3.0. Run it anywhere; share your changes.`)}</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <a
              href={SITE.osbytes}
              target="_blank"
              rel="noreferrer"
              title={t(msg`osbytes — open source bytes`)}
              className="inline-flex items-center gap-2 text-ink2 hover:text-ink"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`${SITE.osbytes}/badge.svg`} alt={t(msg`osbytes — open source bytes`)} width={24} height={24} className="size-6" />
              <span>{"osbytes"}</span>
            </a>
            <p>{t(msg`Not affiliated with YouTube, TikTok or Meta.`)}</p>
          </div>
        </div>
      </div>
    </footer>
  );
}
