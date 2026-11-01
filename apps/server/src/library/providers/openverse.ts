/**
 * Openverse: Creative Commons images and audio, keyless. API: https://api.openverse.org/v1/ (GET /v1/images/,
 * /v1/audio/, single items at /v1/images/<id>/ and /v1/audio/<id>/). We ask for license=cc0,by and
 * license_type=commercial, so nothing NC or ND appears. Audio and image `url`s point at the origin hosts, some of
 * which need auth or throttle downloads: an import that fails says so. Behind OPENVERSE_ENABLED.
 * externalId is `image:<uuid>` or `audio:<uuid>`.
 */
import { ProviderError, arr, clip, extOf, httpsUrl, num, obj, str } from "./http.js";
import type { ItemLicense, Provider, ProviderDeps, ProviderItem, Resolved } from "./types.js";

const API = "https://api.openverse.org/v1";

function licenseOf(r: Record<string, unknown>): ItemLicense | null {
  const l = (str(r.license) ?? "").toLowerCase();
  if (l === "cc0" || l === "pdm")
    return {
      id: "cc0",
      name: l === "pdm" ? "Public Domain Mark" : "CC0 1.0",
      url: httpsUrl(r.license_url) ?? "https://creativecommons.org/publicdomain/zero/1.0/",
    };
  if (l === "by") {
    const v = str(r.license_version) ?? "4.0";
    return { id: `cc-by-${v}`, name: `CC BY ${v}`, url: httpsUrl(r.license_url) ?? `https://creativecommons.org/licenses/by/${v}/` };
  }
  return null;
}

export function openverse({ http }: ProviderDeps): Provider {
  const list = (type: "images" | "audio", q: string, page: number, size: number) => {
    const u = new URL(`${API}/${type}/`);
    u.search = new URLSearchParams({ q, license: "cc0,by", license_type: "commercial", page: String(page), page_size: String(Math.min(50, size)) }).toString();
    return http.json("openverse", u);
  };
  const item = (r: Record<string, unknown>, type: "image" | "audio"): ProviderItem | null => {
    const license = licenseOf(r);
    const file = httpsUrl(r.url);
    const thumb = httpsUrl(r.thumbnail);
    if (!license || !file || !str(r.id) || (type === "image" && !thumb && !file)) return null;
    return {
      provider: "openverse",
      externalId: `${type}:${r.id}`,
      kind: type,
      mime: type === "audio" ? "audio/mpeg" : undefined,
      name: clip(str(r.title) ?? `Openverse ${type}`, 120),
      previewUrl: type === "image" ? (thumb ?? file) : file,
      thumbUrl: thumb,
      durationSec: type === "audio" && num(r.duration) ? num(r.duration)! / 1000 : undefined,
      width: num(r.width),
      height: num(r.height),
      license,
      attribution:
        license.id === "cc0" ? undefined : clip(str(r.attribution) ?? `${str(r.title) ?? "Untitled"} by ${str(r.creator) ?? "unknown"}, ${license.name}`, 300),
      url: httpsUrl(r.foreign_landing_url),
    };
  };
  return {
    id: "openverse",
    label: "Openverse",
    kinds: ["image", "audio"],
    attributionLine: "Search by Openverse; each result keeps its creator's Creative Commons license",
    async search(q, { kind, cursor, limit }) {
      if (kind === "video") return { items: [] };
      const page = Math.max(1, Number(cursor) || 1);
      const both = !kind;
      const size = both ? Math.ceil(limit / 2) : limit;
      const calls: Array<Promise<{ items: ProviderItem[]; more: boolean }>> = [];
      const more = (r: Record<string, unknown>) => page < (num(r.page_count) ?? 0);
      if (kind !== "audio")
        calls.push(list("images", q, page, size).then((r) => ({ items: arr(obj(r).results).flatMap((x) => item(obj(x), "image") ?? []), more: more(obj(r)) })));
      if (kind !== "image")
        calls.push(list("audio", q, page, size).then((r) => ({ items: arr(obj(r).results).flatMap((x) => item(obj(x), "audio") ?? []), more: more(obj(r)) })));
      const parts = await Promise.all(calls);
      return { items: parts.flatMap((p) => p.items), ...(parts.some((p) => p.more) ? { nextCursor: String(page + 1) } : {}) };
    },
    async resolve(externalId): Promise<Resolved> {
      const [type, id] = externalId.split(":");
      if ((type !== "image" && type !== "audio") || !id || !/^[0-9a-f-]{36}$/i.test(id))
        throw new ProviderError("That is not an Openverse id (image:<uuid> or audio:<uuid>).");
      const r = obj(await http.json("openverse", `${API}/${type}s/${id}/`));
      const license = licenseOf(r);
      const file = httpsUrl(r.url);
      if (!license) throw new ProviderError("That item's license cannot be imported.");
      if (!file) throw new ProviderError("Openverse returned no file for that item.");
      const tags = arr(r.tags)
        .flatMap((t) => str(obj(t).name) ?? [])
        .slice(0, 12);
      return {
        url: file,
        ext: extOf(file, type === "audio" ? "mp3" : "jpg"),
        name: clip(str(r.title) ?? `Openverse ${type} ${id.slice(0, 8)}`, 120),
        kind: type,
        tags,
        provenance: {
          provider: "openverse",
          externalId,
          url: httpsUrl(r.foreign_landing_url),
          license,
          attribution:
            license.id === "cc0"
              ? undefined
              : clip(str(r.attribution) ?? `${str(r.title) ?? "Untitled"} by ${str(r.creator) ?? "unknown"}, ${license.name}`, 300),
        },
      };
    },
  };
}
