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
