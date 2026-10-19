# reelsaw.com

The website for the Reelsaw open-source project: a single Next.js page (App Router, Tailwind v4)
that reuses the app's design tokens (`apps/web/src/index.css`), fonts and logo.

It is a standalone package with its own lockfile, outside the pnpm workspace, so the app's Docker
image, CI and `pnpm dev` are unaffected.

```bash
cd website
pnpm install
pnpm dev          # http://localhost:3200
pnpm typecheck
pnpm build && pnpm start
```

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

- `app/layout.tsx`: title template, description, keywords, canonical, Open Graph and Twitter cards,
  robots directives. `NEXT_PUBLIC_SITE_URL` (default `https://reelsaw.com`) is the `metadataBase`.
- `app/opengraph-image.tsx` renders the social card at build time from `public/logo-dark.png`.
- `app/robots.ts`, `app/sitemap.ts`, `app/manifest.ts`, `app/icon.svg`, `app/apple-icon.png`.
- `app/page.tsx` carries JSON-LD (`SoftwareApplication`, `SoftwareSourceCode`, `WebSite`), one `h1`,
  section landmarks with headings, descriptive alt text, and `next/image` for the screenshots.

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
