/**
 * The provider registry: which providers are listed (a key setting that is empty hides its provider), search
 * with a 24 h in-memory cache per (provider, q, kind, cursor), capped at 2000 entries (LRU), and a 429 turned
 * into `{ items: [], unavailable: "sentence" }`. Pixabay requires the 24 h cache; for the rest it keeps us
 * inside everyone's hourly limits.
 */
import type { AssetKind } from "@reelsaw/shared";
import type { Catalog } from "../catalog.js";
import { ProviderError, ProviderUnavailable, type ProviderHttp } from "./http.js";
import { freesound } from "./freesound.js";
import { giphy } from "./giphy.js";
import { iconify } from "./iconify.js";
import { klipy } from "./klipy.js";
import { openverse } from "./openverse.js";
import { pexels } from "./pexels.js";
import { pixabay } from "./pixabay.js";
import { reelsawCatalog } from "./reelsaw-catalog.js";
import type { Provider, ProviderDeps, Resolved, SearchOptions, SearchResult } from "./types.js";
import type { RuntimeSettings } from "../../instance-settings.js";

export * from "./types.js";
export { ProviderError, ProviderUnavailable, createProviderHttp, type ProviderHttp } from "./http.js";

export const SEARCH_CACHE_TTL_MS = 24 * 60 * 60_000;
export const SEARCH_CACHE_MAX = 2000;
export const DEFAULT_LIMIT = 24;

export interface ProviderInfo {
  id: string;
  label: string;
  kinds: AssetKind[];
  attributionLine: string;
  experimental: boolean;
  /** false while the provider is parked after a 429 */
  available: boolean;
}
export type CatalogSearchResult = SearchResult & { unavailable?: string };

export interface ProviderRegistry {
  /** the providers an admin has switched on, the Reelsaw catalog first */
  list(): ProviderInfo[];
  has(id: string): boolean;
  search(id: string, q: string, opts?: Partial<SearchOptions>): Promise<CatalogSearchResult>;
  resolve(id: string, externalId: string, opts?: { color?: string | undefined }): Promise<Resolved>;
}

export function createProviderRegistry(deps: { settings: () => RuntimeSettings; http: ProviderHttp; catalog: Catalog; now?: () => number }): ProviderRegistry {
  const now = deps.now ?? Date.now;
  const pd: ProviderDeps = { settings: deps.settings, http: deps.http };
  const all: Array<{ provider: Provider; listed: (s: RuntimeSettings) => boolean }> = [
    { provider: reelsawCatalog(deps.catalog), listed: () => true },
    { provider: pexels(pd), listed: (s) => !!s.PEXELS_API_KEY },
    { provider: pixabay(pd), listed: (s) => !!s.PIXABAY_API_KEY },
    { provider: freesound(pd), listed: (s) => !!s.FREESOUND_API_KEY },
    { provider: iconify(pd), listed: () => true },
    { provider: giphy(pd), listed: (s) => !!s.GIPHY_API_KEY },
    { provider: klipy(pd), listed: (s) => !!s.KLIPY_API_KEY },
    { provider: openverse(pd), listed: (s) => s.OPENVERSE_ENABLED },
  ];
  const active = () => all.filter((p) => p.listed(deps.settings())).map((p) => p.provider);
  const get = (id: string) => {
    const p = active().find((x) => x.id === id);
    if (!p) throw new ProviderError(`Unknown or disabled provider "${id}". Providers with a key are hidden until an admin sets it under Settings → System → Library.`);
    return p;
  };

  // Map keeps insertion order: delete + set on every hit makes the first key the least recently used
  const cache = new Map<string, { at: number; value: SearchResult }>();
  const cacheGet = (k: string) => {
    const hit = cache.get(k);
    if (!hit) return undefined;
    if (now() - hit.at > SEARCH_CACHE_TTL_MS) {
      cache.delete(k);
      return undefined;
    }
    cache.delete(k);
    cache.set(k, hit);
    return hit.value;
  };
  const cacheSet = (k: string, value: SearchResult) => {
    cache.delete(k);
    cache.set(k, { at: now(), value });
    while (cache.size > SEARCH_CACHE_MAX) cache.delete(cache.keys().next().value as string);
  };

  return {
    list: () => active().map((p) => ({ id: p.id, label: p.label, kinds: p.kinds, attributionLine: p.attributionLine, experimental: !!p.experimental, available: !deps.http.unavailableUntil(p.id) })),
    has: (id) => active().some((p) => p.id === id),
    async search(id, q, opts = {}) {
      const p = get(id);
      const query = q.trim();
      // remote APIs reject or waste a quota hit on an empty string (Iconify 400); the catalog lists everything
      if (!query && id !== "reelsaw") return { items: [] };
      const o: SearchOptions = { kind: opts.kind, cursor: opts.cursor, limit: opts.limit ?? DEFAULT_LIMIT, license: opts.license };
      // the catalog is local and cheap; its manifest can change under the cache, so it is never cached
      const key = `${id}|${query.toLowerCase()}|${o.kind ?? ""}|${o.cursor ?? ""}|${o.limit}|${o.license ?? ""}`;
      if (id !== "reelsaw") {
        const hit = cacheGet(key);
        if (hit) return hit;
      }
      try {
        const res = await p.search(query, o);
        if (id !== "reelsaw") cacheSet(key, res);
        return res;
      } catch (err) {
        if (err instanceof ProviderUnavailable) return { items: [], unavailable: err.message };
        throw err;
      }
    },
    resolve: (id, externalId, opts) => get(id).resolve(externalId, opts),
  };
}
