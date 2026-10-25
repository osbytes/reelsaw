# reelsaw.com

The website for the Reelsaw open-source project: Next.js (App Router, Tailwind v4) that reuses
the app's design tokens (`apps/web/src/index.css`), fonts and logo. Home, alternatives, guides,
pricing, legal, releases and the pipeline film.

It is a standalone package with its own lockfile, outside the pnpm workspace, so the app's Docker
image, CI and `pnpm dev` are unaffected.

```bash
cd website
pnpm install
pnpm dev          # http://localhost:3200
pnpm typecheck
pnpm build && pnpm start
```

## The demo films

`components/films/*.tsx` are the short loops on the home page: `hero` (a link in, four clips out, 12 s),
`captions` (the same seconds raw and rendered, 7 s) and `reframe` (before → after per layout, 9 s).
Like the pipeline film below, each is one element tree rendered as a pure function of authored time,
but these also play real rendered clips as `<video>` elements (`<Clip>` in `components/films/core.tsx`;
the excerpts and their Creative Commons sources are in `public/films/footage/README.md`). The site
serves the rendered MP4 with a poster through `components/demo-video.tsx` (muted, looping, paused off
screen, a still under `prefers-reduced-motion`), the same way every clipper's landing page does.

```bash
pnpm dev                                  # or pnpm build && pnpm start
pnpm render:film hero                     # → public/films/hero.{mp4,jpg}; --gif ../docs/assets/hero.gif for the README
pnpm render:film reframe --still --at 4.4 --out /tmp/stills   # one frame, to check a moment
```

`/films/<name>` is the capture page (`noindex`); `/films/<name>?preview=1` plays a film live while you
write it. `scripts/render-film.mjs` steps `window.__film.seek(t)`, which also seeks every `<video>` to
the time the frame asks for and waits for `seeked`, so frames are exact and the render is repeatable.
Adding a film: a `FilmDef` in `components/films/<name>.tsx`, registered in `components/films/index.ts`
and `components/films/names.ts`.

## The pipeline film

`components/pipeline-film.tsx` is the animation under "How it works": one video going through the five
queues, with a worker restart that resumes from its checkpoint. It is a single element tree rendered
as a pure function of authored time, so the home page plays it with `requestAnimationFrame` (looping,
paused while off screen, with a pause button, and opening on a still frame under
`prefers-reduced-motion`), and the same component makes the README video:

```bash
pnpm build && pnpm start          # or pnpm dev; the dev overlay is hidden in the frames
pnpm render:pipeline-film         # ../docs/assets/pipeline.{mp4,gif} + pipeline-poster.jpg
```

`scripts/render-pipeline-film.mjs` opens `/pipeline-film` (the film at 1920×1080 with its clock off,
`noindex`), steps time one frame at a time through `window.__pipelineFilm.seek`, and pipes the
screenshots into ffmpeg (H.264, 30 fps), then makes the GIF the README shows from the MP4
(GitHub's video player never autoplays, a GIF does; a per-film palette keeps the dark UI to a few
MB). It drives the installed Google Chrome through `playwright-core`, so there is no browser
download; ffmpeg must be on `PATH`. Re-run it after changing the film so the README and the site
stay the same animation.

## SEO

- `/releases` is the changelog: GitHub releases plus a 90-day commit heatmap (ISR hourly). `/releases/feed.xml` is the RSS. Footer, the home-page "Latest release" button, and the app's What's new / version links open this page.
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
changed. It runs after a successful production deployment (Vercel reports one as a GitHub
`deployment_status` event) or by hand from the Actions tab, reads the live `sitemap.xml` and submits
every URL.

The key is `public/indexnow-key.txt`. It is public by design: the engines fetch it from the site to
verify that the submitter controls the host, and knowing it only lets someone submit URLs on this
host. To rotate it, write a new 8 to 128 character string of letters and digits to that file
(`openssl rand -hex 16`) and deploy. Optional repository variable `SITE_URL` overrides
`https://reelsaw.com`. Google does not use IndexNow; submit the sitemap in Search Console for it.
