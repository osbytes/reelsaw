/**
 * Iconify: 200k icons from permissive sets. API: https://iconify.design/docs/api/ : GET /search?query&limit&start&prefixes
 * ({ icons: ["lucide:star"], total }), GET /collections?prefixes=… (set info incl. license), GET /<prefix>/<name>.svg
 * (?color=%23ffffff&width=512). Only the allowlisted sets below are searched; each icon's license is its set's.
 * externalId is `<prefix>:<name>`.
 */
import { ProviderError, arr, clip, obj, str } from "./http.js";
import type { ItemLicense, Provider, ProviderDeps, Resolved } from "./types.js";

export const ICONIFY_SETS = ["lucide", "tabler", "mdi", "ph", "heroicons", "ri", "solar"] as const;
const COLOR = /^#?[0-9a-f]{6}$/i;

/** Set licenses as checked Oct 2026; used when /collections is unreachable. SPDX id, name, url. */
const FALLBACK_LICENSES: Record<string, ItemLicense> = {
  lucide: { id: "isc", name: "ISC", url: "https://github.com/lucide-icons/lucide/blob/main/LICENSE" },
  tabler: { id: "mit", name: "MIT", url: "https://github.com/tabler/tabler-icons/blob/main/LICENSE" },
  mdi: { id: "apache-2.0", name: "Apache 2.0", url: "https://github.com/Templarian/MaterialDesign/blob/master/LICENSE" },
  ph: { id: "mit", name: "MIT", url: "https://github.com/phosphor-icons/core/blob/main/LICENSE" },
  heroicons: { id: "mit", name: "MIT", url: "https://github.com/tailwindlabs/heroicons/blob/master/LICENSE" },
  ri: { id: "apache-2.0", name: "Apache 2.0", url: "https://github.com/Remix-Design/RemixIcon/blob/master/License" },
  solar: { id: "cc-by-4.0", name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
};
const PERMISSIVE = /^(isc|mit|apache-2\.0|cc0-1\.0|cc0|cc-by-4\.0|ofl-1\.1|bsd-3-clause|unlicense)$/;

export function iconify({ settings, http }: ProviderDeps): Provider {
  const base = () => settings().ICONIFY_API_URL.replace(/\/+$/, "");
  let licenses: Promise<Record<string, ItemLicense>> | undefined;
  /** each set's license from /collections, once per process; the fallback table when that fails */
  const setLicenses = () =>
    (licenses ??= http
      .json("iconify", `${base()}/collections?prefixes=${ICONIFY_SETS.join(",")}`)
      .then((r) => {
        const out = { ...FALLBACK_LICENSES };
        for (const [prefix, info] of Object.entries(obj(r))) {
          const l = obj(obj(info).license);
          const spdx = str(l.spdx)?.toLowerCase();
          if (spdx && str(l.title)) out[prefix] = { id: spdx, name: str(l.title)!, url: str(l.url) };
        }
        return out;
      })
      .catch(() => {
        licenses = undefined;
        return FALLBACK_LICENSES;
      }));
  const svgUrl = (prefix: string, name: string, color?: string, width = 512) => {
    const u = new URL(`${base()}/${prefix}/${name}.svg`);
    u.searchParams.set("width", String(width));
    if (color) u.searchParams.set("color", `#${color.replace(/^#/, "")}`);
    return u.toString();
  };
  const parse = (id: string) => {
    const [prefix, name] = id.split(":");
    if (!prefix || !name || !(ICONIFY_SETS as readonly string[]).includes(prefix) || !/^[a-z0-9][a-z0-9-]*$/.test(name))
      throw new ProviderError("That is not an Iconify id from an allowed set (<prefix>:<name>).");
    return { prefix, name };
  };
  return {
    id: "iconify",
    label: "Icons",
    kinds: ["image"],
    attributionLine: "Icons via Iconify; each set keeps its own license",
    async search(q, { kind, cursor, limit }) {
      if (kind && kind !== "image") return { items: [] };
      const start = Math.max(0, Number(cursor) || 0);
      const u = new URL(`${base()}/search`);
      u.search = new URLSearchParams({
        query: q,
        limit: String(Math.min(999, Math.max(32, limit))),
        start: String(start),
        prefixes: ICONIFY_SETS.join(","),
      }).toString();
      const [r, lic] = await Promise.all([http.json("iconify", u), setLicenses()]);
      const icons = arr(obj(r).icons).filter((i): i is string => typeof i === "string");
      const items = icons.flatMap((id) => {
        const [prefix, name] = id.split(":");
        const license = prefix ? lic[prefix] : undefined;
        if (!prefix || !name || !license || !PERMISSIVE.test(license.id)) return [];
        // previews are dark-friendly grey; the import colours the file
        const preview = svgUrl(prefix, name, "ffffff", 128);
        return [
          {
            provider: "iconify",
            externalId: id,
            kind: "image" as const,
            mime: "image/svg+xml",
            name: name.replace(/-/g, " "),
            previewUrl: preview,
            thumbUrl: preview,
            width: 512,
            height: 512,
            license,
            attribution: license.id.startsWith("cc-by") ? `${name} icon (${prefix}) via Iconify` : undefined,
            url: `https://icon-sets.iconify.design/${prefix}/${name}/`,
          },
        ];
      });
      const total = Number(obj(r).total) || 0;
      const used = icons.length + start;
      return { items, ...(used < total && icons.length ? { nextCursor: String(used) } : {}) };
    },
    async resolve(externalId, opts): Promise<Resolved> {
      const { prefix, name } = parse(externalId);
      if (opts?.color && !COLOR.test(opts.color)) throw new ProviderError("color must be a hex value like #ffffff.");
      const license = (await setLicenses())[prefix];
      if (!license || !PERMISSIVE.test(license.id)) throw new ProviderError("That icon set's license cannot be imported.");
      return {
        url: svgUrl(prefix, name, opts?.color ?? "#ffffff"),
        ext: "svg",
        name: clip(name.replace(/-/g, " "), 120),
        kind: "image",
        tags: [...name.split("-"), prefix, "icon"],
        provenance: {
          provider: "iconify",
          externalId,
          variant: (opts?.color ?? "#ffffff").replace(/^#/, "").toLowerCase(),
          url: `https://icon-sets.iconify.design/${prefix}/${name}/`,
          license,
          attribution: license.id.startsWith("cc-by") ? clip(`${name} icon (${prefix}) via Iconify`, 300) : undefined,
        },
      };
    },
  };
}
