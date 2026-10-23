/**
 * Pexels: stock photos and portrait videos. Docs: https://www.pexels.com/api/documentation/ (checked Oct 2026):
 * GET /v1/search (photos), GET /v1/videos/search (orientation=portrait&size=medium fits 9:16), single items at
 * /v1/photos/:id and /v1/videos/videos/:id, key in the `Authorization` header, 200 req/h.
 * externalId is `photo:<id>` or `video:<id>`.
 */
import { ProviderError, arr, clip, extOf, httpsUrl, needKey, num, obj, str } from "./http.js";
import type { Provider, ProviderDeps, ProviderItem, Resolved } from "./types.js";

const API = "https://api.pexels.com";
const LICENSE = { id: "pexels", name: "Pexels License", url: "https://www.pexels.com/license/" };

type Video = { link: string; width: number; height: number; type: string };
function videoFiles(v: Record<string, unknown>): Video[] {
  return arr(v.video_files).flatMap((f) => {
    const o = obj(f);
    const link = httpsUrl(o.link);
    return link && str(o.file_type) === "video/mp4" ? [{ link, width: num(o.width) ?? 0, height: num(o.height) ?? 0, type: "video/mp4" }] : [];
  });
}
/** The largest rendition that is at most 1080 wide, else the smallest there is. */
function pickVideo(files: Video[]): Video | undefined {
  const fit = files.filter((f) => f.width <= 1080).sort((a, b) => b.width - a.width)[0];
  return fit ?? [...files].sort((a, b) => a.width - b.width)[0];
}

export function pexels({ settings, http }: ProviderDeps): Provider {
  const headers = () => ({ authorization: needKey(settings().PEXELS_API_KEY, "PEXELS_API_KEY") });
  const photoItem = (p: Record<string, unknown>): ProviderItem | null => {
    const src = obj(p.src);
    const preview = httpsUrl(src.large) ?? httpsUrl(src.medium);
    if (!preview || p.id === undefined) return null;
    const who = str(p.photographer);
    return { provider: "pexels", externalId: `photo:${p.id}`, kind: "image", mime: "image/jpeg", name: clip(str(p.alt) ?? `Photo ${p.id}`, 120), previewUrl: preview, thumbUrl: httpsUrl(src.small) ?? preview, width: num(p.width), height: num(p.height), license: LICENSE, attribution: who ? `Photo by ${who} on Pexels` : "Photo on Pexels", url: httpsUrl(p.url) };
  };
  const videoItem = (v: Record<string, unknown>): ProviderItem | null => {
    const file = pickVideo(videoFiles(v));
    const poster = httpsUrl(v.image);
    if (!file || !poster || v.id === undefined) return null;
    const who = str(obj(v.user).name);
    return { provider: "pexels", externalId: `video:${v.id}`, kind: "video", mime: "video/mp4", name: `Video ${v.id}`, previewUrl: file.link, thumbUrl: poster, durationSec: num(v.duration), width: file.width, height: file.height, license: LICENSE, attribution: who ? `Video by ${who} on Pexels` : "Video on Pexels", url: httpsUrl(v.url) };
  };
  return {
    id: "pexels",
    label: "Pexels",
    kinds: ["image", "video"],
    needsKey: "PEXELS_API_KEY",
    attributionLine: "Photos and videos provided by Pexels",
    async search(q, { kind, cursor, limit }) {
      if (kind === "audio") return { items: [] };
      const page = Math.max(1, Number(cursor) || 1);
      const both = !kind;
      const per = String(Math.min(80, both ? Math.max(1, Math.ceil(limit / 2)) : limit));
      const calls: Array<Promise<{ items: ProviderItem[]; more: boolean }>> = [];
      if (kind !== "video") {
        const u = new URL(`${API}/v1/search`);
        u.search = new URLSearchParams({ query: q, per_page: per, page: String(page) }).toString();
        calls.push(http.json("pexels", u, { headers: headers() }).then((r) => ({ items: arr(obj(r).photos).flatMap((p) => photoItem(obj(p)) ?? []), more: !!obj(r).next_page })));
      }
      if (kind !== "image") {
        const u = new URL(`${API}/v1/videos/search`);
        u.search = new URLSearchParams({ query: q, per_page: per, page: String(page), orientation: "portrait", size: "medium" }).toString();
        calls.push(http.json("pexels", u, { headers: headers() }).then((r) => ({ items: arr(obj(r).videos).flatMap((p) => videoItem(obj(p)) ?? []), more: !!obj(r).next_page })));
      }
      const parts = await Promise.all(calls);
      const items = parts.flatMap((p) => p.items);
      return { items, ...(parts.some((p) => p.more) ? { nextCursor: String(page + 1) } : {}) };
    },
    async resolve(externalId): Promise<Resolved> {
      const [type, id] = externalId.split(":");
      if (!id || !/^\d+$/.test(id)) throw new ProviderError("That is not a Pexels id (photo:<id> or video:<id>).");
      if (type === "photo") {
        const p = obj(await http.json("pexels", `${API}/v1/photos/${id}`, { headers: headers() }));
        const src = obj(p.src);
        const url = httpsUrl(src.large2x) ?? httpsUrl(src.large) ?? httpsUrl(src.original);
        if (!url) throw new ProviderError("Pexels returned no file for that photo.");
        const who = str(p.photographer);
        return { url, ext: extOf(url, "jpg"), name: clip(str(p.alt) ?? `Pexels photo ${id}`, 120), kind: "image", tags: [], provenance: { provider: "pexels", externalId, url: httpsUrl(p.url), license: LICENSE, attribution: clip(who ? `Photo by ${who} on Pexels` : "Photo on Pexels", 300) } };
      }
      if (type === "video") {
        const v = obj(await http.json("pexels", `${API}/v1/videos/videos/${id}`, { headers: headers() }));
        const file = pickVideo(videoFiles(v));
        if (!file) throw new ProviderError("Pexels returned no file for that video.");
        const who = str(obj(v.user).name);
        return { url: file.link, ext: "mp4", name: `Pexels video ${id}`, kind: "video", tags: [], provenance: { provider: "pexels", externalId, url: httpsUrl(v.url), license: LICENSE, attribution: clip(who ? `Video by ${who} on Pexels` : "Video on Pexels", 300) } };
      }
      throw new ProviderError("That is not a Pexels id (photo:<id> or video:<id>).");
    },
  };
}
