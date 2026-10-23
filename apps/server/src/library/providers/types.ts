/** The shared shapes of the remote asset providers (Pexels, Pixabay, Freesound, Iconify, Openverse, Giphy, Klipy) and the Reelsaw catalog. */
import type { AssetKind, AssetProvenance } from "@reelsaw/shared";
import type { RuntimeKey, RuntimeSettings } from "../../instance-settings.js";
import type { ProviderHttp } from "./http.js";

export interface ItemLicense {
  id: string;
  name: string;
  url?: string;
}

/** One search hit, as the Browse panel, the MCP tool and the CLI show it. */
export interface ProviderItem {
  provider: string;
  externalId: string;
  kind: AssetKind;
  mime?: string;
  name: string;
  /** an image, or a playable video / audio file, for the panel to show; never imported from */
  previewUrl: string;
  thumbUrl?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  license: ItemLicense;
  attribution?: string;
  /** the item's page at the source */
  url?: string;
}

export interface SearchOptions {
  kind?: AssetKind;
  cursor?: string;
  limit: number;
  /** Freesound: cc0 (default) or by (CC0 and CC-BY) */
  license?: "cc0" | "by";
}
export interface SearchResult {
  items: ProviderItem[];
  nextCursor?: string;
}

/** What an import needs: the file to download and the row to create from it. */
export interface Resolved {
  url: string;
  ext: string;
  name: string;
  kind: AssetKind;
  tags?: string[];
  provenance: AssetProvenance;
  /** the file must hash to this (the Reelsaw catalog) */
  sha256?: string;
  /** a file bundled with this install: copied, not downloaded */
  localPath?: string;
}

export interface Provider {
  id: string;
  label: string;
  kinds: AssetKind[];
  /** the runtime setting holding its key; the provider is not listed while that is empty */
  needsKey?: RuntimeKey;
  /** the credit the provider's terms ask us to show next to its results */
  attributionLine: string;
  /** shown as such in the panel */
  experimental?: boolean;
  search(q: string, opts: SearchOptions): Promise<SearchResult>;
  resolve(externalId: string, opts?: { color?: string }): Promise<Resolved>;
}

export interface ProviderDeps {
  settings: () => RuntimeSettings;
  http: ProviderHttp;
}
