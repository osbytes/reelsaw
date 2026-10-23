/**
 * Giphy: GIFs and transparent stickers. API: https://developers.giphy.com/docs/api/endpoint/ :
 * GET /v1/gifs/search and /v1/stickers/search (api_key, q, limit, offset, rating), single items at /v1/gifs/<id> and
 * /v1/stickers/<id>. GIFs import as the `original.mp4` rendition (kind video; smaller, same loop); stickers import
 * as the `.gif` so the alpha survives. The Browse panel must show "Powered by GIPHY". Beta keys: 100 calls/h.
 * externalId is `gif:<id>` or `sticker:<id>`.
 */
import { ProviderError, arr, clip, httpsUrl, needKey, num, obj, str } from "./http.js";
import type { Provider, ProviderDeps, ProviderItem, Resolved } from "./types.js";

const API = "https://api.giphy.com/v1";
const LICENSE = { id: "giphy", name: "GIPHY terms", url: "https://support.giphy.com/hc/en-us/articles/360020027752-GIPHY-User-Terms-of-Service" };

export function giphy({ settings, http }: ProviderDeps): Provider {
  const url = (path: string, params: Record<string, string> = {}) => {
    const u = new URL(`${API}${path}`);
    u.search = new URLSearchParams({ ...params, api_key: needKey(settings().GIPHY_API_KEY, "GIPHY_API_KEY") }).toString();
    return u;
  };
  const item = (g: Record<string, unknown>, sticker: boolean): ProviderItem | null => {
    const img = obj(g.images);
    const orig = obj(img.original);
    const still = httpsUrl(obj(img.fixed_width).url) ?? httpsUrl(obj(img.fixed_width_still).url);
    if (!str(g.id) || !still) return null;
    const user = str(obj(g.user).display_name) ?? str(g.username);
    return { provider: "giphy", externalId: `${sticker ? "sticker" : "gif"}:${g.id}`, kind: sticker ? "image" : "video", mime: sticker ? "image/gif" : "video/mp4", name: clip(str(g.title) ?? `GIF ${g.id}`, 120), previewUrl: still, thumbUrl: httpsUrl(obj(img.fixed_width_small_still).url) ?? still, width: num(orig.width), height: num(orig.height), license: LICENSE, attribution: user ? `GIF by ${user} on GIPHY` : "GIF from GIPHY", url: httpsUrl(g.url) };
  };
  const file = (g: Record<string, unknown>, sticker: boolean) => {
    const orig = obj(obj(g.images).original);
    return sticker ? { url: httpsUrl(orig.url), ext: "gif" } : { url: httpsUrl(orig.mp4), ext: "mp4" };
  };
  return {
    id: "giphy",
    label: "GIPHY",
    kinds: ["video", "image"],
    needsKey: "GIPHY_API_KEY",
    attributionLine: "Powered by GIPHY",
    async search(q, { kind, cursor, limit }) {
      if (kind === "audio") return { items: [] };
      const offset = Math.max(0, Number(cursor) || 0);
      const both = !kind;
      const size = String(Math.min(50, both ? Math.ceil(limit / 2) : limit));
      const calls: Array<Promise<{ items: ProviderItem[]; next: number; more: boolean }>> = [];
      const run = (path: string, sticker: boolean) =>
        http.json("giphy", url(path, { q, limit: size, offset: String(offset), rating: "pg-13", lang: "en" })).then((r) => {
          const p = obj(obj(r).pagination);
          const count = num(p.count) ?? 0;
          return { items: arr(obj(r).data).flatMap((g) => item(obj(g), sticker) ?? []), next: offset + count, more: offset + count < (num(p.total_count) ?? 0) && count > 0 };
        });
      if (kind !== "image") calls.push(run("/gifs/search", false));
      if (kind !== "video") calls.push(run("/stickers/search", true));
      const parts = await Promise.all(calls);
      const more = parts.find((p) => p.more);
      return { items: parts.flatMap((p) => p.items), ...(more ? { nextCursor: String(Math.max(...parts.map((p) => p.next))) } : {}) };
    },
    async resolve(externalId): Promise<Resolved> {
      const [type, id] = externalId.split(":");
      if ((type !== "gif" && type !== "sticker") || !id || !/^[A-Za-z0-9]+$/.test(id)) throw new ProviderError("That is not a Giphy id (gif:<id> or sticker:<id>).");
      const g = obj(obj(await http.json("giphy", url(`/${type}s/${id}`))).data);
      const f = file(g, type === "sticker");
      if (!f.url) throw new ProviderError("Giphy returned no file for that item.");
      const user = str(obj(g.user).display_name) ?? str(g.username);
      return { url: f.url, ext: f.ext, name: clip(str(g.title) ?? `GIPHY ${id}`, 120), kind: type === "sticker" ? "image" : "video", category: "sticker", tags: [], provenance: { provider: "giphy", externalId, url: httpsUrl(g.url), license: LICENSE, attribution: clip(user ? `GIF by ${user} on GIPHY` : "GIF from GIPHY", 300) } };
    },
  };
}
