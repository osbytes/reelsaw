/**
 * The one way provider code talks to the network: https only, 10 s timeout, a `reelsaw/<version>` user
 * agent, rate-limit headers logged, and a 429 parks the provider until its reset (or 60 s). URLs are
 * logged without their query: several providers take the key there.
 */
import type { Logger } from "../../log.js";

export const REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_COOLDOWN_MS = 60_000;

/** The provider asked us to stop for a while; the message is a sentence for the panel. */
export class ProviderUnavailable extends Error {
  constructor(
    public readonly provider: string,
    public readonly until: number,
  ) {
    super(`${provider} is rate limiting this server; try again in a minute.`);
  }
}
/** The provider answered, but not with success. */
export class ProviderError extends Error {}

export interface ProviderHttp {
  json(provider: string, url: string | URL, init?: { headers?: Record<string, string> }): Promise<unknown>;
  /** ms epoch until which the provider is parked, or 0 */
  unavailableUntil(provider: string): number;
}

export function createProviderHttp(deps: { fetch?: typeof fetch | undefined; version: string; log: Logger; now?: () => number }): ProviderHttp {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const parked = new Map<string, number>();
  const unavailableUntil = (p: string) => {
    const t = parked.get(p) ?? 0;
    if (t <= now()) {
      parked.delete(p);
      return 0;
    }
    return t;
  };
  return {
    unavailableUntil,
    async json(provider, url, init) {
      const until = unavailableUntil(provider);
      if (until) throw new ProviderUnavailable(provider, until);
      const u = new URL(url);
      if (u.protocol !== "https:") throw new ProviderError(`${provider}: only https endpoints are used`);
      const res = await doFetch(u, {
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: "application/json", "user-agent": `reelsaw/${deps.version}`, ...init?.headers },
      }).catch((err: unknown) => {
        throw new ProviderError(`${provider} did not answer (${err instanceof Error ? err.message : "network error"})`);
      });
      const limits: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (/ratelimit|rate-limit|retry-after/i.test(k)) limits[k] = v;
      });
      deps.log.debug({ provider, host: u.host, path: u.pathname, status: res.status, limits }, "provider request");
      if (res.status === 429) {
        const retry = Number(res.headers.get("retry-after"));
        const reset = Number(res.headers.get("x-ratelimit-reset") ?? res.headers.get("ratelimit-reset"));
        const wait = Number.isFinite(retry) && retry > 0 ? retry * 1000 : Number.isFinite(reset) && reset > 0 ? (reset > 1e9 ? reset * 1000 - now() : reset * 1000) : DEFAULT_COOLDOWN_MS;
        const resumeAt = now() + Math.min(Math.max(wait, 1000), 60 * 60_000);
        parked.set(provider, resumeAt);
        deps.log.warn({ provider, until: new Date(resumeAt).toISOString() }, "provider rate limited; parked");
        throw new ProviderUnavailable(provider, resumeAt);
      }
      if (res.status === 401 || res.status === 403) throw new ProviderError(`${provider} refused the key (HTTP ${res.status}); check it under Settings → System.`);
      if (!res.ok) throw new ProviderError(`${provider} answered HTTP ${res.status}`);
      return res.json().catch(() => {
        throw new ProviderError(`${provider} answered with something that is not JSON`);
      });
    },
  };
}

/** Narrowing helpers for untrusted JSON: provider responses are data, never trusted shapes. */
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
export const httpsUrl = (v: unknown): string | undefined => {
  const s = str(v);
  if (!s) return undefined;
  try {
    return new URL(s).protocol === "https:" ? s : undefined;
  } catch {
    return undefined;
  }
};
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
/** Extension of a URL path, lower case without the dot; `def` when it has none. */
export const extOf = (url: string, def: string) => /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? def;
/** The key a provider needs, or a sentence saying where to set it. */
export function needKey(v: string | undefined, name: string): string {
  if (!v) throw new ProviderError(`${name} is not set: an admin adds it under Settings → System → Library.`);
  return v;
}
