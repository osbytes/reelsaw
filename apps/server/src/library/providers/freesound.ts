/**
 * Freesound: sound effects. Docs: https://freesound.org/docs/api/resources_apiv2.html (checked Oct 2026):
 * GET /apiv2/search/text/?query&filter&fields&page&page_size&token, GET /apiv2/sounds/<id>/?fields&token.
 * Originals need per-user OAuth2, so we import `previews.preview-hq-mp3` (128 kbps), fine under speech.
 * CC0 by default; `license: "by"` adds CC-BY (attribution stored). Anything else (NC, ND, sampling+) is dropped.
 */
import { ProviderError, arr, clip, httpsUrl, needKey, num, obj, str } from "./http.js";
import type { ItemLicense, Provider, ProviderDeps, ProviderItem, Resolved } from "./types.js";

const API = "https://freesound.org/apiv2";
const FIELDS = "id,name,username,license,duration,previews,url,tags";
const FILTER = { cc0: 'license:"Creative Commons 0"', by: 'license:("Creative Commons 0" OR "Attribution")' } as const;

/** Freesound reports the license as a deed URL (or, in older answers, its name). null = not allowed. */
export function freesoundLicense(raw: string | undefined): ItemLicense | null {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("publicdomain/zero") || s.includes("creative commons 0"))
    return { id: "cc0", name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" };
  if (/creativecommons\.org\/licenses\/by\/|^attribution$/.test(s))
    return { id: "cc-by", name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" };
  return null;
}

export function freesound({ settings, http }: ProviderDeps): Provider {
  const url = (path: string, params: Record<string, string>) => {
    const u = new URL(`${API}${path}`);
    u.search = new URLSearchParams({ ...params, token: needKey(settings().FREESOUND_API_KEY, "FREESOUND_API_KEY") }).toString();
    return u;
  };
  const credit = (name: string, user: string | undefined) => clip(`${name} by ${user ?? "unknown"} (Freesound)`, 300);
  const item = (s: Record<string, unknown>): ProviderItem | null => {
    const license = freesoundLicense(str(s.license));
    const preview = httpsUrl(obj(s.previews)["preview-hq-mp3"]);
    const name = str(s.name);
    if (!license || !preview || !name || s.id === undefined) return null;
    return {
      provider: "freesound",
      externalId: String(s.id),
      kind: "audio",
      mime: "audio/mpeg",
      name: clip(name.replace(/\.(wav|mp3|flac|ogg|aif+)$/i, ""), 120),
      previewUrl: preview,
      durationSec: num(s.duration),
      license,
      attribution: license.id === "cc0" ? undefined : credit(name, str(s.username)),
      url: httpsUrl(s.url),
    };
  };
  return {
    id: "freesound",
    label: "Freesound",
    kinds: ["audio"],
    needsKey: "FREESOUND_API_KEY",
    attributionLine: "Sounds from Freesound.org; each keeps its creator's license",
    async search(q, { kind, cursor, limit, license }) {
      if (kind && kind !== "audio") return { items: [] };
      const page = Math.max(1, Number(cursor) || 1);
      const r = obj(
        await http.json(
          "freesound",
          url("/search/text/", { query: q, filter: FILTER[license ?? "cc0"], fields: FIELDS, page: String(page), page_size: String(Math.min(150, limit)) }),
        ),
      );
      return { items: arr(r.results).flatMap((s) => item(obj(s)) ?? []), ...(r.next ? { nextCursor: String(page + 1) } : {}) };
    },
    async resolve(externalId): Promise<Resolved> {
      if (!/^\d+$/.test(externalId)) throw new ProviderError("That is not a Freesound id (a number).");
      const s = obj(await http.json("freesound", url(`/sounds/${externalId}/`, { fields: FIELDS })));
      const license = freesoundLicense(str(s.license));
      if (!license) throw new ProviderError("That sound's license (not CC0 or CC-BY) cannot be imported.");
      const file = httpsUrl(obj(s.previews)["preview-hq-mp3"]);
      const name = str(s.name);
      if (!file || !name) throw new ProviderError("Freesound returned no preview for that sound.");
      const tags = arr(s.tags)
        .flatMap((t) => (typeof t === "string" ? [t.toLowerCase()] : []))
        .slice(0, 12);
      return {
        url: file,
        ext: "mp3",
        name: clip(name.replace(/\.(wav|mp3|flac|ogg|aif+)$/i, ""), 120),
        kind: "audio",
        tags,
        provenance: { provider: "freesound", externalId, url: httpsUrl(s.url), license, attribution: credit(name, str(s.username)) },
      };
    },
  };
}
