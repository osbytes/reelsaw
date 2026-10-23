/**
 * Klipy: GIF search with a Tenor-compatible shape. EXPERIMENTAL. https://docs.klipy.com is a client-rendered site
 * and could not be read in Oct 2026 (the menu only shows "GET GIF - Search API" at /gifs-api/gifs-search-api), so
 * this follows the Tenor v2 response shape (`results[].media_formats.{mp4,gif,tinygif}.url`, `next` position) with
 * the key in the path: GET https://api.klipy.com/api/v1/<key>/gifs/search?q=&per_page=&page=. Verify against
 * the docs and a real key before relying on it; the panel marks it experimental. Terms for ads/attribution are
 * unverified, so the license shown is "Klipy terms" and the source is kept in provenance.
 * externalId is the Klipy item id/slug.
 */
import { ProviderError, arr, clip, httpsUrl, needKey, num, obj, str } from "./http.js";
import type { Provider, ProviderDeps, ProviderItem, Resolved } from "./types.js";

const API = "https://api.klipy.com/api/v1";
const LICENSE = { id: "klipy", name: "Klipy terms", url: "https://klipy.com/terms" };

/** Tenor-style `media_formats`, or Klipy's `file` map (hd/md/sm → gif/mp4/webp), whichever the answer has. */
function formats(g: Record<string, unknown>): { mp4?: string; gif?: string; thumb?: string; width?: number; height?: number } {
  const mf = obj(g.media_formats);
  if (Object.keys(mf).length) {
    const dims = arr(obj(mf.gif).dims);
    return { mp4: httpsUrl(obj(mf.mp4).url), gif: httpsUrl(obj(mf.gif).url), thumb: httpsUrl(obj(mf.tinygif).url) ?? httpsUrl(obj(mf.gif).url), width: num(dims[0]), height: num(dims[1]) };
  }
  const f = obj(g.file);
  const size = obj(f.md ?? f.hd ?? f.sm);
  const sm = obj(f.sm ?? f.md);
  return { mp4: httpsUrl(obj(size.mp4).url), gif: httpsUrl(obj(size.gif).url), thumb: httpsUrl(obj(sm.gif).url) ?? httpsUrl(obj(sm.webp).url), width: num(obj(size.gif).width), height: num(obj(size.gif).height) };
}

export function klipy({ settings, http }: ProviderDeps): Provider {
  const url = (path: string, params: Record<string, string> = {}) => {
    const u = new URL(`${API}/${encodeURIComponent(needKey(settings().KLIPY_API_KEY, "KLIPY_API_KEY"))}${path}`);
    u.search = new URLSearchParams(params).toString();
    return u;
  };
  const rows = (r: unknown) => {
    const o = obj(r);
    const data = obj(o.data);
    return arr(o.results).length ? arr(o.results) : arr(data.data).length ? arr(data.data) : arr(o.data);
  };
  const item = (g: Record<string, unknown>): ProviderItem | null => {
    const id = str(g.id) ?? str(g.slug);
    const f = formats(g);
    if (!id || !f.thumb || !(f.mp4 || f.gif)) return null;
    return { provider: "klipy", externalId: id, kind: "video", mime: f.mp4 ? "video/mp4" : "image/gif", name: clip(str(g.title) ?? str(g.content_description) ?? `GIF ${id}`, 120), previewUrl: f.thumb, thumbUrl: f.thumb, width: f.width, height: f.height, license: LICENSE, attribution: "GIFs via Klipy", url: httpsUrl(g.itemurl) ?? httpsUrl(g.url) };
  };
  return {
    id: "klipy",
    label: "Klipy",
    kinds: ["video"],
    needsKey: "KLIPY_API_KEY",
    experimental: true,
    attributionLine: "GIFs via Klipy",
    async search(q, { kind, cursor, limit }) {
      if (kind && kind !== "video") return { items: [] };
      const page = Math.max(1, Number(cursor) || 1);
      const r = await http.json("klipy", url("/gifs/search", { q, per_page: String(Math.min(50, limit)), page: String(page), customer_id: "reelsaw" }));
      const items = rows(r).flatMap((g) => item(obj(g)) ?? []);
      const o = obj(r);
      const hasNext = o.has_next ?? obj(o.data).has_next ?? (str(o.next) ? true : undefined);
      return { items, ...(hasNext && items.length ? { nextCursor: String(page + 1) } : {}) };
    },
    async resolve(externalId): Promise<Resolved> {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(externalId)) throw new ProviderError("That is not a Klipy id.");
      // no single-item endpoint is confirmed: search by the id and take the exact match
      const r = await http.json("klipy", url("/gifs/search", { q: externalId, per_page: "20", customer_id: "reelsaw" }));
      const g = rows(r).map(obj).find((x) => (str(x.id) ?? str(x.slug)) === externalId);
      const f = g ? formats(g) : undefined;
      const file = f?.mp4 ?? f?.gif;
      if (!g || !f || !file) throw new ProviderError("Klipy no longer returns that item; search for it again.");
      return { url: file, ext: f.mp4 ? "mp4" : "gif", name: clip(str(g.title) ?? `Klipy ${externalId}`, 120), kind: "video", category: "sticker", tags: [], provenance: { provider: "klipy", externalId, url: httpsUrl(g.itemurl) ?? httpsUrl(g.url), license: LICENSE, attribution: "GIF via Klipy" } };
    },
  };
}
