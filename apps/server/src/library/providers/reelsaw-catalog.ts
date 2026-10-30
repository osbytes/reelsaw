/** The Reelsaw catalog as a provider: search and resolve over the manifest (library/catalog.ts). Always listed, needs no key. */
import { ProviderError } from "./http.js";
import type { Catalog } from "../catalog.js";
import type { Provider } from "./types.js";

export function reelsawCatalog(catalog: Catalog): Provider {
  return {
    id: "reelsaw",
    label: "Reelsaw",
    kinds: ["audio", "image", "video"],
    attributionLine: "Reelsaw catalog: CC0 and permissively licensed sounds, icons and stickers",
    search: (q, { kind, cursor, limit }) => catalog.search(q, { kind, cursor, limit }),
    async resolve(externalId) {
      const hit = await catalog.find(externalId);
      if (!hit) throw new ProviderError("That item is not in the Reelsaw catalog (it may have been removed in a newer version).");
      const { item, fileUrl, localPath } = hit;
      const ext =
        /\.([a-z0-9]{2,5})$/i.exec(item.url)?.[1]?.toLowerCase() ?? (item.mime.split("/")[1] ?? "bin").replace("svg+xml", "svg").replace("mpeg", "mp3");
      return {
        url: fileUrl,
        ext,
        name: item.name,
        kind: item.kind,
        tags: item.tags,
        sha256: item.sha256,
        ...(localPath ? { localPath } : {}),
        provenance: {
          provider: "reelsaw",
          externalId: item.id,
          url: item.source.url,
          license: { id: item.license.id, name: item.license.name, ...(item.license.url ? { url: item.license.url } : {}) },
          ...(item.attribution ? { attribution: item.attribution } : {}),
        },
      };
    },
  };
}
