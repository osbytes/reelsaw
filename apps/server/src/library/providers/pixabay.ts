/**
 * Pixabay: photos, illustrations, vectors and videos. Docs: https://pixabay.com/api/docs/ (checked Oct 2026):
 * GET /api/?key&q&image_type=photo|illustration|vector&page&per_page&id and GET /api/videos/ (hits[].videos.
 * {large,medium,small,tiny}.url). Search results must be cached 24 h (the registry does) and files downloaded,
 * never hotlinked for good (we import them). The key rides in the query, so logs never print the query.
 * externalId is `photo:<id>`, `vector:<id>` or `video:<id>`.
 */
import { ProviderError, arr, clip, extOf, httpsUrl, needKey, num, obj, str } from "./http.js";
import type { Provider, ProviderDeps, ProviderItem, Resolved } from "./types.js";

const API = "https://pixabay.com/api";
const LICENSE = { id: "pixabay", name: "Pixabay Content License", url: "https://pixabay.com/service/license-summary/" };

function bestVideo(videos: Record<string, unknown>): { url: string; width: number; height: number } | undefined {
  for (const size of ["medium", "large", "small", "tiny"]) {
    const v = obj(videos[size]);
    const url = httpsUrl(v.url);
    if (url) return { url, width: num(v.width) ?? 0, height: num(v.height) ?? 0 };
  }
}
const tagsOf = (h: Record<string, unknown>) => (str(h.tags) ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 12);

export function pixabay({ settings, http }: ProviderDeps): Provider {
  const key = () => needKey(settings().PIXABAY_API_KEY, "PIXABAY_API_KEY");
  const url = (path: string, params: Record<string, string>) => {
    const u = new URL(`${API}${path}`);
    u.search = new URLSearchParams({ key: key(), ...params }).toString();
    return u;
  };
  const imageItem = (h: Record<string, unknown>, vector: boolean): ProviderItem | null => {
    const preview = httpsUrl(h.webformatURL) ?? httpsUrl(h.previewURL);
    if (!preview || h.id === undefined) return null;
    const tags = tagsOf(h);
    return { provider: "pixabay", externalId: `${vector ? "vector" : "photo"}:${h.id}`, kind: "image", mime: "image/jpeg", name: clip(tags.slice(0, 3).join(", ") || `Pixabay ${h.id}`, 120), previewUrl: preview, thumbUrl: httpsUrl(h.previewURL) ?? preview, width: num(h.imageWidth), height: num(h.imageHeight), license: LICENSE, attribution: str(h.user) ? `Image by ${str(h.user)} on Pixabay` : "Image from Pixabay", url: httpsUrl(h.pageURL) };
  };
  const videoItem = (h: Record<string, unknown>): ProviderItem | null => {
    const file = bestVideo(obj(h.videos));
    const thumb = httpsUrl(obj(obj(h.videos).medium).thumbnail) ?? httpsUrl(obj(obj(h.videos).small).thumbnail);
    if (!file || h.id === undefined) return null;
    const tags = tagsOf(h);
    return { provider: "pixabay", externalId: `video:${h.id}`, kind: "video", mime: "video/mp4", name: clip(tags.slice(0, 3).join(", ") || `Pixabay video ${h.id}`, 120), previewUrl: file.url, thumbUrl: thumb, durationSec: num(h.duration), width: file.width, height: file.height, license: LICENSE, attribution: str(h.user) ? `Video by ${str(h.user)} on Pixabay` : "Video from Pixabay", url: httpsUrl(h.pageURL) };
  };
  return {
    id: "pixabay",
    label: "Pixabay",
    kinds: ["image", "video"],
    needsKey: "PIXABAY_API_KEY",
    attributionLine: "Images and videos from Pixabay",
    async search(q, { kind, cursor, limit }) {
      if (kind === "audio") return { items: [] };
      const page = Math.max(1, Number(cursor) || 1);
      const per = String(Math.min(200, Math.max(3, limit)));
      const common = { q: q.slice(0, 100), page: String(page), per_page: per, safesearch: "true" };
      const calls: Array<Promise<{ items: ProviderItem[]; more: boolean }>> = [];
      const more = (r: unknown) => page * Number(per) < (num(obj(r).totalHits) ?? 0);
      if (kind !== "video") {
        calls.push(http.json("pixabay", url("/", { ...common, image_type: "all" })).then((r) => ({ items: arr(obj(r).hits).flatMap((h) => imageItem(obj(h), /\bvector\b/i.test(str(obj(h).type) ?? "")) ?? []), more: more(r) })));
      }
      if (kind !== "image") {
        calls.push(http.json("pixabay", url("/videos/", common)).then((r) => ({ items: arr(obj(r).hits).flatMap((h) => videoItem(obj(h)) ?? []), more: more(r) })));
      }
      const parts = await Promise.all(calls);
      return { items: parts.flatMap((p) => p.items), ...(parts.some((p) => p.more) ? { nextCursor: String(page + 1) } : {}) };
    },
    async resolve(externalId): Promise<Resolved> {
      const [type, id] = externalId.split(":");
      if (!id || !/^\d+$/.test(id) || !["photo", "vector", "video"].includes(type ?? "")) throw new ProviderError("That is not a Pixabay id (photo:<id>, vector:<id> or video:<id>).");
      const r = await http.json("pixabay", type === "video" ? url("/videos/", { id }) : url("/", { id }));
      const hit = obj(arr(obj(r).hits)[0]);
      if (hit.id === undefined) throw new ProviderError("Pixabay no longer has that item.");
      const page = httpsUrl(hit.pageURL);
      const tags = tagsOf(hit);
      const who = str(hit.user);
      if (type === "video") {
        const file = bestVideo(obj(hit.videos));
        if (!file) throw new ProviderError("Pixabay returned no file for that video.");
        return { url: file.url, ext: "mp4", name: clip(tags.slice(0, 3).join(", ") || `Pixabay video ${id}`, 120), kind: "video", tags, provenance: { provider: "pixabay", externalId, url: page, license: LICENSE, attribution: clip(who ? `Video by ${who} on Pixabay` : "Video from Pixabay", 300) } };
      }
      // largeImageURL is the standard size every key gets; vectorURL needs approved full access
      const file = (type === "vector" ? httpsUrl(hit.vectorURL) : undefined) ?? httpsUrl(hit.largeImageURL) ?? httpsUrl(hit.webformatURL);
      if (!file) throw new ProviderError("Pixabay returned no file for that image.");
      return { url: file, ext: extOf(file, "jpg"), name: clip(tags.slice(0, 3).join(", ") || `Pixabay image ${id}`, 120), kind: "image", tags, provenance: { provider: "pixabay", externalId, url: page, license: LICENSE, attribution: clip(who ? `Image by ${who} on Pixabay` : "Image from Pixabay", 300) } };
    },
  };
}
