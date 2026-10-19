/**
 * Where posthog-js talks to, derived from one setting (NEXT_PUBLIC_POSTHOG_HOST).
 * Shared by next.config.ts (the reverse-proxy rewrites) and the browser init, so they can't drift.
 *
 * - api: the ingestion host the proxy forwards to
 * - assets: where PostHog serves its static bundles (`<region>-assets.i.posthog.com` on the cloud,
 *   the same host when self-hosted)
 * - ui: the PostHog app, needed by the toolbar when requests go through a proxy
 */
export const POSTHOG_PROXY_PATH = "/ingest";

export function posthogHosts(host = "https://us.i.posthog.com") {
  const api = host.replace(/\/+$/, "");
  const cloud = /^https:\/\/(\w+)\.i\.posthog\.com$/.exec(api);
  return {
    api,
    assets: cloud ? `https://${cloud[1]}-assets.i.posthog.com` : api,
    ui: cloud ? `https://${cloud[1]}.posthog.com` : api,
  };
}
