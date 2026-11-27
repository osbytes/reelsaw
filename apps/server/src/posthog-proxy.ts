/**
 * PostHog reverse proxy (https://posthog.com/docs/advanced/proxy): with POSTHOG_PROXY on, the browser's
 * posthog-js sends to this origin at POSTHOG_PROXY_PATH, and this forwards to POSTHOG_HOST. Under `/api/`, which the
 * SPA fallback never answers, so no client route can be shadowed. Requests to the app's own origin
 * are not blocked by the extensions that block posthog.com. `/static/*` goes to the assets host, everything else
 * to the ingestion host.
 *
 * Only what PostHog needs goes upstream: no cookie (the session cookie stays here), no authorization header. The
 * client address goes as X-Forwarded-For so PostHog's GeoIP sees the visitor rather than this server, and only
 * when TRUST_PROXY says the address is real (abuse.ts#clientIp).
 */
import type { Context } from "hono";
import { clientIp } from "./abuse.js";
import type { Config } from "./config.js";

export const POSTHOG_PROXY_PATH = "/api/relay";

/** Where posthog-js talks to, derived from POSTHOG_HOST. */
// dup-of: website/lib/posthog-hosts.ts#posthogHosts
export function posthogHosts(host: string) {
  const api = host.replace(/\/+$/, "");
  const cloud = /^https:\/\/(\w+)\.i\.posthog\.com$/.exec(api);
  return {
    api,
    /** static bundles (`<region>-assets.i.posthog.com` on the cloud, the same host when self-hosted) */
    assets: cloud ? `https://${cloud[1]}-assets.i.posthog.com` : api,
    /** the PostHog app, for links the toolbar makes when requests go through a proxy */
    ui: cloud ? `https://${cloud[1]}.posthog.com` : api,
  };
}

/** Request headers posthog-js sends that matter upstream; everything else (cookie, authorization, our own) stays. */
const FORWARD_REQUEST = ["content-type", "content-encoding", "user-agent", "accept", "accept-language", "origin", "referer"];
/**
 * Response headers not passed back: fetch already decoded the body (so its encoding and length are wrong), and
 * nothing upstream may set a cookie on this origin.
 */
const DROP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie", "keep-alive"]);

/** The upstream URL for a request under the proxy path, or null when the path is not under it. */
export function upstreamUrl(requestUrl: string, proxyPath: string, host: string): string | null {
  const url = new URL(requestUrl);
  if (url.pathname !== proxyPath && !url.pathname.startsWith(`${proxyPath}/`)) return null;
  const rest = url.pathname.slice(proxyPath.length) || "/";
  const hosts = posthogHosts(host);
  const base = rest.startsWith("/static/") ? hosts.assets : hosts.api;
  return `${base}${rest}${url.search}`;
}

export function posthogProxy(config: Pick<Config, "POSTHOG_HOST" | "TRUST_PROXY" | "TRUSTED_PROXY_HEADER" | "TRUSTED_PROXY_HOPS">) {
  return async (c: Context) => {
    const target = upstreamUrl(c.req.url, POSTHOG_PROXY_PATH, config.POSTHOG_HOST);
    if (!target) return c.notFound();
    const headers = new Headers();
    for (const name of FORWARD_REQUEST) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    const ip = clientIp(c.req.raw.headers, config);
    if (ip) headers.set("x-forwarded-for", ip);
    const method = c.req.method;
    const hasBody = method !== "GET" && method !== "HEAD";
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method,
        headers,
        body: hasBody ? await c.req.arrayBuffer() : null,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // PostHog unreachable or slow: the browser retries on its own; nothing here is worth an error report
      return c.body(null, 502);
    }
    const out = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!DROP_RESPONSE.has(name)) out.set(name, value);
    });
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };
}
