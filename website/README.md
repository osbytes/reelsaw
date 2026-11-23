# reelsaw.com

The website for the Reelsaw open-source project: Next.js (App Router, Tailwind v4) that reuses
the app's design tokens (`apps/web/src/index.css`), fonts and logo. Home, alternatives, guides, use cases
(`content/use-cases.ts`, served at `/<slug>` beside the guides), pricing, legal, releases and the pipeline film.

It is a standalone package with its own lockfile, outside the pnpm workspace, so the app's Docker
image, CI and `pnpm dev` are unaffected.

```bash
cd website
pnpm install
pnpm dev          # http://localhost:3200
pnpm typecheck
pnpm build && pnpm start
```

## Languages

The copy is in a Lingui catalogue, the same `.po` format as the app (`docs/I18N.md`): `locales/en.po` is generated
from the code and committed. Copy is written with Lingui's runtime macro, so Next needs no compiler plugin:
`t(msg`Clips from ${{ name }}`)` for a string, `rich(msg`Read <0>the docs</0>`, { 0: (c) => <a href="…">{c}</a> })`
for a sentence with a link or a styled word in it (one message, never pieces). Content modules (`content/*.ts`) hold
rendered strings, so each build is one language: `SITE_LOCALE` at build time (default `en`) picks the catalogue for
the server and client bundles alike. `SITE_LOCALE=en-XA pnpm dev` shows the pseudo-locale, where copy that is still
plain English was not wrapped. Product names, URLs, commands, code and the demo run's own output (hooks, the model's
and the detector's reasons) stay as they are.

```bash
pnpm i18n:extract   # after changing copy; CI runs pnpm i18n:check
```

`pnpm dev`, `build` and `typecheck` compile the catalogues to `locales/<locale>.ts` first (generated, not committed).

## The demo clips

The home page shows real runs of hosted Reelsaw on Creative Commons BY videos with default settings, picked to
show the range of framing: a let's play with a facecam, a podcast shot both wide and close, and a keynote with
slides beside the speaker. The hero (`components/hero-reel.tsx`) plays one pick from each next to the same seconds
of its source, with where it came from on the source's timeline; "One real run" lays the podcast next to its
clips (`components/clip-strip.tsx`); "Most replayed" (`components/replay-ranges.tsx`) draws a long stream's replay
heatmap with the peaks Reelsaw took from it and the minutes that cost; "See it" is a set of deep-linkable tabs
(`#see-reframe`, `components/feature-tabs.tsx`) whose Reframe tab overlays what the detector found (the speaker it
follows, the webcam tile and the content region) on the source. All of them read `content/demo.ts` (sources,
ranks, reasons, start and end times, tracks and regions from `get_clip`'s layout segments, the heatmap and peaks)
and play `public/clips/*.mp4` through `components/loop-video.tsx`: muted, fetched when near, paused off screen,
posters only under `prefers-reduced-motion`.

Swapping in a newer run: update `content/demo.ts` from `get_project` and `get_clip` (MCP) and cut the files from the
rendered clip and the downloaded source (`yt-dlp -f "137+140"`), 8 s each (longer where the framing changes later,
like the 16 s speaker switch in `podcast-6`):

```bash
ffmpeg -i clip.mp4 -t 8 -vf scale=540:960 -c:v libx264 -crf 24 -preset slow -an -movflags +faststart game.mp4
ffmpeg -ss <clip start> -i source.mp4 -t 8 -vf scale=720:-2 -c:v libx264 -crf 25 -preset slow -an -movflags +faststart game-before.mp4
ffmpeg -ss 2.3 -i game.mp4 -frames:v 1 -q:v 4 game.jpg      # and the same for game-before
```

The Most replayed numbers come from `check_source` with any `ranges` (it lists the peaks) and the `billedSec` of a
`create_project` with `rangesFrom: { mostReplayed: 5 }`; the heatmap bins are yt-dlp's `heatmap` for the video.

The app screenshots in the Moments, Fixes and Editor tabs (`public/workspace.png`, `transcript-fixes.png`,
`editor.png`, copied to `docs/assets/` for the README) are an earlier podcast and webinar (credited with the others in
`content/demo.ts`) run through a local build: 1459×729,
dark theme, device scale 1. Workspace is the podcast seeked into its talk (`/p/<id>#t=44`), fixes is the webinar
with the fixes list open and its name fix selected (`#fix=<id>`), editor is the podcast's clip #2 with the playhead
mid-clip. Retake them whenever those screens change.

## The pipeline film

`components/pipeline-film.tsx` is the animation under "How it works": one video going through the five
queues, with a worker restart that resumes from its checkpoint. It is a single element tree rendered
as a pure function of authored time, so the home page plays it with `requestAnimationFrame` (looping,
paused while off screen, with a pause button, and opening on a still frame under
`prefers-reduced-motion`), and the same component makes the README video:

```bash
pnpm build && pnpm start          # or pnpm dev; the dev overlay is hidden in the frames
pnpm render:film                  # ../docs/assets/pipeline.{mp4,gif} + pipeline-poster.jpg
```

`scripts/render-pipeline-film.mjs` opens `/pipeline-film` (the film at 1920×1080 with its clock off,
`noindex`), steps time one frame at a time through `window.__pipelineFilm.seek`, and pipes the
screenshots into ffmpeg (H.264, 30 fps), then makes the GIF the README shows from the MP4
(GitHub's video player never autoplays, a GIF does; a per-film palette keeps the dark UI to a few
MB). It drives the installed Google Chrome through `playwright-core`, so there is no browser
download; ffmpeg must be on `PATH`. Re-run it after changing the film so the README and the site
stay the same animation.

## SEO

- `/releases` is the changelog: GitHub releases plus a 90-day commit heatmap (ISR hourly), a "Latest release" card, and
  the releases grouped under the day they shipped (a sticky rail with the month, the day and that day's tags; each
  release's tag stays pinned under the header while its notes scroll). Days keep `#YYYY-MM-DD` anchors, releases `#vX.Y.Z`.
  `/releases/feed.xml` is the RSS (items link to release pages). Footer, the home-page "Latest release" button, and the
  app's What's new / version links open this page. The home page's "Recently shipped" section (`#changelog`, after
  "How it compares") lists the three newest releases, each linking to its page; it is left out when GitHub
  does not answer, and the home page revalidates hourly like `/releases`.
- `/releases/[releases]` (`lib/release-pages.ts`):
  - `/releases/v0.33.0` is one release: tag, day, headline (its first note's first sentence), other releases that day,
    the notes, and older / newer cards. Built ahead of time, in the sitemap, with its own OG card.
  - Sets, like git's `a..b`: `/releases/v0.32.4..v0.34.0` (both ends included, either order), `/releases/v0.30.0,v0.33.0`
    (up to 20 parts, mixable), and days: `/releases/2026-11-06`, `/releases/2026-11-05..2026-11-10` (leading zeros
    optional). They show the count, the days, up to three merged highlights (minor and major notes first), then the
    releases by day. Each set has one spelling (runs become `older..newer`, oldest first; days padded, sorted, merged)
    and other spellings 308 there; a one-tag set is that release's page. Sets render on request and are `noindex, follow`.
  - Real days with no release say "Nothing shipped …" with the release before and after; an unknown tag or a link that
    is not a selection gets the changelog's own 404 (`app/releases/not-found.tsx`) with the latest release.
- `app/layout.tsx`: title template, description, keywords, canonical, Open Graph and Twitter cards,
  robots directives. `NEXT_PUBLIC_SITE_URL` (default `https://reelsaw.com`) is the `metadataBase`.
- Open Graph images (Next.js file convention, built with `next/og` via `lib/og.tsx`):
  - `app/opengraph-image.tsx` — home page and site-wide fallback for any route without its own card
  - `app/alternatives/opengraph-image.tsx` — alternatives hub
  - `app/alternatives/[slug]/opengraph-image.tsx` — one card per competitor (`h1` + blurb)
  - `app/(guides)/[slug]/opengraph-image.tsx` — one card per guide
  Twitter large-image cards reuse the same files. `/pipeline-film` is `noindex` and inherits the
  fallback. Page metadata uses `lib/social-meta.ts` so the Twitter `card` type is never dropped.
- `app/robots.ts`, `app/sitemap.ts`, `app/manifest.ts`, `app/icon.svg`, `app/favicon.ico`, `app/apple-icon.png` (the same files as `apps/web/public`).
- `app/page.tsx` carries JSON-LD (`SoftwareApplication`, `SoftwareSourceCode`, `WebSite`), one `h1`,
  section landmarks with headings, descriptive alt text, and `next/image` for the screenshots.
- `/pricing`, `/terms` and `/privacy` are always published. The hosted app URL is `SITE.app`
  (default `https://app.reelsaw.com`). Plan list: `content/pricing.ts`, mirrored from the server.

## Analytics (optional)

PostHog is off unless `NEXT_PUBLIC_POSTHOG_KEY` is set. With a key:

- `components/analytics.tsx` loads `posthog-js` with `api_host: "/ingest"`, pageviews on history
  changes, pageleave, exception capture, `person_profiles: "identified_only"` and Do-Not-Track respected.
- `next.config.ts` adds rewrites that reverse-proxy `/ingest/*` to the PostHog ingestion host and
  `/ingest/static/*` to its asset host, so the browser only talks to this site.
- `NEXT_PUBLIC_POSTHOG_HOST` picks the region (`https://us.i.posthog.com` default, `https://eu.i.posthog.com`)
  or a self-hosted PostHog; `lib/posthog-hosts.ts` derives the asset and UI hosts from it so the
  proxy and the client never disagree.

Copy `.env.example` to `.env.local` to set these locally. On Vercel, set them as project
environment variables; rewrites are evaluated at build time, so redeploy after changing the key.

## Comparison and guide pages

Modelled on the "alternatives" pages hosted clippers rank with. All copy is data in `content/`:

- `content/competitors.ts`: one entry per competitor renders `/alternatives/<slug>` through
  `app/alternatives/[slug]/page.tsx`: their plans, a feature-by-feature table against the fixed
  Reelsaw column in `content/reelsaw.ts`, what they do better, pick-them / pick-Reelsaw, FAQ.
- `content/guides.ts`: keyword pages at the root (`/free-ai-clip-generator-no-watermark`, …) through
  `app/(guides)/[slug]/page.tsx`.
- `/alternatives` is the hub. Every page carries BreadcrumbList and FAQPage JSON-LD, a canonical URL,
  a sources list and the date the vendor's pricing page was read (`CHECKED` in `content/reelsaw.ts`).
  The sitemap, header, footer and home page link to all of them.

Adding a competitor or guide is a new object in the matching file; the route, sitemap and link
lists pick it up. Re-check vendor pricing before bumping `CHECKED`: every claim on these pages is
either from a vendor's public pricing page or from the Reelsaw README.

When Reelsaw gains or improves a capability, update this package in the same change as the
code ([docs/PRINCIPLES.md](../docs/PRINCIPLES.md), Process): the home-page features and MCP chips
(`app/page.tsx`), the Reelsaw column (`content/reelsaw.ts`), and any competitor or guide sentence
that still says Reelsaw cannot do it. Hosted Reelsaw (app.reelsaw.com) is always in the copy:
pricing, terms and privacy are always on the site.

## IndexNow

`.github/workflows/indexnow.yml` tells Bing, Yandex and the other IndexNow engines which pages
changed. It runs on every push to `main` that touches `website/` and by hand from the Actions tab.
A push first waits until the production deploy of that commit is live: `/version.txt`
(`app/version.txt/route.ts`) serves the commit the deployment was built from (Vercel's
`VERCEL_GIT_COMMIT_SHA`, so the project must expose system environment variables). Then it reads
the live `sitemap.xml` and submits every URL. (Vercel does not report its deploys to GitHub here, so
a `deployment_status` trigger never fired.)

The key is `public/indexnow-key.txt`. It is public by design: the engines fetch it from the site to
verify that the submitter controls the host, and knowing it only lets someone submit URLs on this
host. To rotate it, write a new 8 to 128 character string of letters and digits to that file
(`openssl rand -hex 16`) and deploy. Optional repository variable `SITE_URL` overrides
`https://reelsaw.com`. Google does not use IndexNow; submit the sitemap in Search Console for it.
