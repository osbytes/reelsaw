import type { NextConfig } from "next";
import { POSTHOG_PROXY_PATH, posthogHosts } from "./lib/posthog-hosts";

// Analytics are opt-in: without a key, nothing is loaded in the browser and nothing is proxied.
const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const posthog = posthogHosts(process.env.NEXT_PUBLIC_POSTHOG_HOST);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // PostHog's API paths end in a slash (`/decide/`, `/e/`); Next would otherwise redirect them.
  skipTrailingSlashRedirect: true,
  // the site's language for this build (lib/i18n.ts), inlined into server and client bundles alike so they render the same
  env: { SITE_LOCALE: process.env.SITE_LOCALE ?? "en" },
  async rewrites() {
    if (!posthogKey) return [];
    return [
      { source: `${POSTHOG_PROXY_PATH}/static/:path*`, destination: `${posthog.assets}/static/:path*` },
      { source: `${POSTHOG_PROXY_PATH}/:path*`, destination: `${posthog.api}/:path*` },
    ];
  },
};

export default nextConfig;
