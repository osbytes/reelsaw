/**
 * The Reelsaw catalog: a versioned manifest of redistributable sounds, icons and stickers (docs/specs/library.md,
 * "System assets"). Two sources, the higher `version` wins:
 *   - the starter pack bundled in the image (`assets/catalog/index.json` + `files/`), so an offline install has something;
 *   - the online manifest (`CATALOG_URL`), fetched with ETag / If-None-Match, 10 s timeout, cached at
 *     `<DATA_DIR>/catalog/index.json`, refreshed hourly by the reconciler or `reelsaw catalog refresh`.
 * A failed fetch is a debug line, never an error. Search is Fuse over name / tags. Importing goes
 * through the same path as every provider (library/import.ts): download (or copy, for bundled files), verify the
 * sha256, `bumpers.create` with `system: true`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import Fuse from "fuse.js";
import { z } from "zod";
import { ASSET_KINDS, type AssetKind } from "@reelsaw/shared";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import type { ItemLicense, ProviderItem } from "./providers/types.js";

export const catalogItemSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(ASSET_KINDS),
  mime: z.string().max(100),
  name: z.string().min(1).max(120),
  tags: z.array(z.string().max(40)).max(30).default([]),
  durationSec: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** `files/<id>.<ext>` (relative to the manifest) or an absolute https URL */
  url: z.string().min(1).max(2000),
  license: z.object({ id: z.string().max(40), name: z.string().max(120), url: z.string().max(2000).optional() }),
  attribution: z.string().max(300).optional(),
  source: z.object({ url: z.string().url().max(2000) }),
});
export type CatalogItem = z.infer<typeof catalogItemSchema>;
export const manifestSchema = z.object({ version: z.number().int().nonnegative(), generatedAt: z.string(), items: z.array(catalogItemSchema).max(20_000) });
export type Manifest = z.infer<typeof manifestSchema>;

export type CatalogSource = "bundled" | "cache" | "remote";
export interface CatalogStatus {
  version: number;
  generatedAt: string;
  items: number;
  source: CatalogSource;
  bundledVersion: number;
  url: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  etag: string | null;
}

export interface Catalog {
  /** Manifest in force (reads the cache file again when another process changed it). */
  manifest(): Promise<{ manifest: Manifest; source: CatalogSource }>;
  search(
    q: string,
    opts: { kind?: AssetKind | undefined; cursor?: string | undefined; limit: number },
  ): Promise<{ items: ProviderItem[]; nextCursor?: string }>;
  find(id: string): Promise<{ item: CatalogItem; fileUrl: string; localPath?: string } | undefined>;
  /** Ask `CATALOG_URL` for a newer manifest; never throws. */
  refresh(opts?: { force?: boolean }): Promise<{ changed: boolean; status: CatalogStatus }>;
  status(): Promise<CatalogStatus>;
}

export interface CatalogDeps {
  config: Pick<Config, "DATA_DIR" | "REELSAW_VERSION">;
  url: () => string;
  log: Logger;
  fetch?: typeof fetch | undefined;
  /** where the starter pack lives; default `assets/catalog` next to the server's working directory */
  bundledDir?: string | undefined;
  now?: () => number;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_MANIFEST_BYTES = 20 * 1024 * 1024;
/**
 * The starter pack shipped next to the server code: `apps/server/assets/catalog` in a checkout, `/app/server/assets/catalog`
 * in the image (where the process runs from `/app`, so the working directory cannot be relied on). Resolved from this module
 * like the migrations folder in db/index.ts: the bundle lives in `dist/` (or `dist/chunks/`), the sources in `src/library/`.
 */
export const DEFAULT_BUNDLED_DIR = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../assets/catalog"),
    path.resolve(here, "../../assets/catalog"),
    path.resolve(here, "../../../assets/catalog"),
    path.resolve(process.cwd(), "assets/catalog"),
    path.resolve(process.cwd(), "apps/server/assets/catalog"),
  ];
  return candidates.find((d) => existsSync(path.join(d, "index.json"))) ?? candidates[0]!;
})();

async function readManifest(file: string): Promise<Manifest | null> {
  try {
    return manifestSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
  } catch {
    return null;
  }
}

export function createCatalog(deps: CatalogDeps): Catalog {
  const bundledDir = deps.bundledDir ?? DEFAULT_BUNDLED_DIR;
  const dir = path.join(deps.config.DATA_DIR, "catalog");
  const cacheFile = path.join(dir, "index.json");
  const etagFile = path.join(dir, "etag");
  const now = deps.now ?? Date.now;
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log;

  let bundled: Manifest | null | undefined;
  let cached: { manifest: Manifest; mtimeMs: number } | null | undefined;
  let fuse: { manifest: Manifest; index: Fuse<CatalogItem> } | undefined;
  let lastCheckedAt: number | null = null;
  let lastError: string | null = null;
  let refreshing: Promise<unknown> | undefined;

  async function load() {
    bundled ??= await readManifest(path.join(bundledDir, "index.json"));
    const st = await fs.stat(cacheFile).catch(() => null);
    if (!st) cached = null;
    else if (!cached || cached.mtimeMs !== st.mtimeMs) {
      const m = await readManifest(cacheFile);
      cached = m ? { manifest: m, mtimeMs: st.mtimeMs } : null;
    }
    const b = bundled ?? { version: 0, generatedAt: new Date(0).toISOString(), items: [] };
    if (cached && cached.manifest.version > b.version) return { manifest: cached.manifest, source: "cache" as const };
    return { manifest: b, source: "bundled" as const };
  }

  /** Where a file lives: a bundled path when the bundled manifest is the one in force, else the URL next to the manifest. */
  async function resolveFile(item: CatalogItem, source: CatalogSource) {
    if (/^https:\/\//i.test(item.url)) return { fileUrl: item.url };
    if (source === "bundled") {
      const rel = path.normalize(item.url);
      const abs = path.resolve(bundledDir, rel);
      if (abs.startsWith(path.resolve(bundledDir) + path.sep)) return { fileUrl: abs, localPath: abs };
      throw new Error("The catalog entry points outside the catalog folder");
    }
    return { fileUrl: new URL(item.url, deps.url()).toString() };
  }

  async function status(): Promise<CatalogStatus> {
    const { manifest, source } = await load();
    return {
      version: manifest.version,
      generatedAt: manifest.generatedAt,
      items: manifest.items.length,
      source,
      bundledVersion: bundled?.version ?? 0,
      url: deps.url(),
      lastCheckedAt: lastCheckedAt ? new Date(lastCheckedAt).toISOString() : null,
      lastError,
      etag: await fs.readFile(etagFile, "utf8").then(
        (s) => s.trim() || null,
        () => null,
      ),
    };
  }

  async function doRefresh(force: boolean) {
    const before = (await load()).manifest.version;
    const url = deps.url();
    lastCheckedAt = now();
    try {
      if (!/^https:\/\//i.test(url)) throw new Error("CATALOG_URL must be an https URL");
      const etag = force
        ? null
        : await fs.readFile(etagFile, "utf8").then(
            (s) => s.trim(),
            () => null,
          );
      const res = await doFetch(url, {
        headers: { accept: "application/json", "user-agent": `reelsaw/${deps.config.REELSAW_VERSION}`, ...(etag ? { "if-none-match": etag } : {}) },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "follow",
      });
      if (res.status === 304) {
        lastError = null;
        log.debug({ url }, "catalog unchanged");
      } else if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      } else {
        const declared = Number(res.headers.get("content-length") ?? 0);
        if (declared > MAX_MANIFEST_BYTES) throw new Error("manifest too large");
        const body = await res.text();
        if (body.length > MAX_MANIFEST_BYTES) throw new Error("manifest too large");
        const manifest = manifestSchema.parse(JSON.parse(body));
        await fs.mkdir(dir, { recursive: true });
        // write beside, then rename: a reader in another process never sees half a file
        const tmp = `${cacheFile}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(manifest));
        await fs.rename(tmp, cacheFile);
        const newTag = res.headers.get("etag");
        if (newTag) await fs.writeFile(etagFile, newTag);
        else await fs.rm(etagFile, { force: true });
        lastError = null;
        log.info({ version: manifest.version, items: manifest.items.length }, "catalog manifest updated");
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.debug({ err: lastError, url }, "catalog refresh failed; keeping what we have");
    }
    const after = (await load()).manifest.version;
    return { changed: after !== before, status: await status() };
  }

  return {
    manifest: load,
    status,
    refresh(opts) {
      // one refresh at a time per process
      const run = (refreshing = (refreshing ?? Promise.resolve()).then(() => doRefresh(!!opts?.force)).finally(() => (refreshing = undefined)));
      return run as ReturnType<Catalog["refresh"]>;
    },
    async find(id) {
      const { manifest, source } = await load();
      const item = manifest.items.find((i) => i.id === id);
      return item ? { item, ...(await resolveFile(item, source)) } : undefined;
    },
    async search(q, { kind, cursor, limit }) {
      const { manifest, source } = await load();
      if (fuse?.manifest !== manifest) {
        fuse = {
          manifest,
          index: new Fuse(manifest.items, {
            keys: [
              { name: "name", weight: 2 },
              { name: "tags", weight: 1.5 },
            ],
            threshold: 0.35,
            ignoreLocation: true,
          }),
        };
      }
      const query = q.trim();
      const all = query ? fuse.index.search(query).map((r) => r.item) : manifest.items;
      const filtered = kind ? all.filter((i) => i.kind === kind) : all;
      const start = Math.max(0, Number(cursor) || 0);
      const page = filtered.slice(start, start + limit);
      return {
        items: page.map((i) => toProviderItem(i, source, deps.url())),
        ...(start + limit < filtered.length ? { nextCursor: String(start + limit) } : {}),
      };
    },
  };
}

/** The panel previews bundled files through `/media/catalog/…` and online ones from the URL next to the manifest. */
export function toProviderItem(i: CatalogItem, source: CatalogSource, manifestUrl: string): ProviderItem {
  const license: ItemLicense = i.license;
  const preview = source === "bundled" && !/^https:\/\//i.test(i.url) ? `/media/catalog/${path.basename(i.url)}` : new URL(i.url, manifestUrl).toString();
  return {
    provider: "reelsaw",
    externalId: i.id,
    kind: i.kind,
    mime: i.mime,
    name: i.name,
    previewUrl: preview,
    thumbUrl: i.kind === "image" ? preview : undefined,
    durationSec: i.durationSec,
    width: i.width,
    height: i.height,
    license,
    attribution: i.attribution,
    url: i.source.url,
  };
}
