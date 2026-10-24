/**
 * Search and import for the Library's Browse panel, `search_library` / `import_asset` and `reelsaw library
 * search|import`: one service behind all of them. The registry and the catalog are per `Services`
 * (created on first use; settings are read at the point of use, so an admin's key change applies at once).
 * An import resolves the item, brings the file in as an upload (download through the SSRF-guarded
 * `downloadAsUpload`, or copy for files bundled with the install), verifies the catalog's sha256 and creates the
 * library row through `createAsset`, so limits, dedupe and probing are the ones every upload gets. The row is
 * instance-shared (`user_id` null), one per (provider, externalId, colour); clips that name it keep it, the sweep
 * drops it once nothing does.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import type { AssetKind } from "@reelsaw/shared";
import type { Services } from "../services.js";
import { schema } from "../db/index.js";
import { keys } from "../storage/index.js";
import { sha256File } from "../pipeline/bumpers.js";
import { createAsset, downloadAsUpload, sharedSourceWhere, type FetchDeps } from "./service.js";
import { createCatalog, type Catalog } from "./catalog.js";
import { createProviderHttp, createProviderRegistry, ProviderError, ProviderUnavailable, type CatalogSearchResult, type ProviderRegistry } from "./providers/index.js";

interface Parts {
  catalog: Catalog;
  registry: ProviderRegistry;
}
const parts = new WeakMap<Services, Parts>();

export function libraryProviders(svc: Services, deps: { fetch?: typeof fetch; bundledDir?: string } = {}): Parts {
  let p = parts.get(svc);
  if (!p) {
    const log = svc.log.child({ module: "catalog" });
    const catalog = createCatalog({ config: svc.config, url: () => svc.settings.get().CATALOG_URL, log, fetch: deps.fetch, bundledDir: deps.bundledDir });
    const http = createProviderHttp({ fetch: deps.fetch, version: svc.config.REELSAW_VERSION, log });
    p = { catalog, registry: createProviderRegistry({ settings: () => svc.settings.get(), http, catalog }) };
    parts.set(svc, p);
  }
  return p;
}

/** Providers and catalog errors become sentences the panel, the tools and the CLI can show as they are. */
export function asTrpc(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  if (err instanceof ProviderUnavailable) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: err.message });
  if (err instanceof ProviderError) throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
  throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : String(err) });
}

export interface SearchInput {
  provider?: string;
  q: string;
  kind?: AssetKind;
  cursor?: string;
  limit?: number;
  license?: "cc0" | "by";
}
/** `provider` omitted = the Reelsaw catalog. */
export async function catalogSearch(svc: Services, input: SearchInput): Promise<CatalogSearchResult & { provider: string }> {
  const provider = input.provider ?? "reelsaw";
  try {
    return { provider, ...(await libraryProviders(svc).registry.search(provider, input.q, { kind: input.kind, cursor: input.cursor, limit: input.limit, license: input.license })) };
  } catch (err) {
    return asTrpc(err);
  }
}

export interface ImportInput {
  provider: string;
  externalId: string;
  color?: string;
  tags?: string[];
}
export interface ImportedAsset {
  id: string;
  name: string;
  kind: string;
  mime?: string | null;
  durationSec: number;
  /** the shared row already existed (another import, possibly by another account): this call reused it */
  duplicate: boolean;
  restored: boolean;
}

/** Copy a file bundled with the install into the uploads table, as `downloadAsUpload` does for a link. */
async function localAsUpload(svc: Services, userId: string, file: string, name: string, ext: string) {
  const id = randomUUID();
  const size = (await fs.stat(file)).size;
  const filename = `${name.replace(/[\\/]/g, "_")}.${ext}`.slice(0, 200);
  await svc.storage.putFile(keys.upload(id, `.${ext}`), file);
  await svc.database.db.insert(schema.uploads).values({ id, userId, filename, storageKey: keys.upload(id, `.${ext}`), sizeBytes: size });
  return { uploadId: id, filename, sizeBytes: size };
}

type SharedKey = { provider: string; externalId: string; variant: string };
/** The shared row for a source item, if this instance already imported it. */
async function existingShared(svc: Services, key: SharedKey): Promise<ImportedAsset | null> {
  const [row] = await svc.database.db.select().from(schema.assets).where(sharedSourceWhere(key)).limit(1);
  if (!row) return null;
  return { id: row.id, name: row.name, kind: row.kind, mime: row.mime, durationSec: row.durationSec, duplicate: true, restored: false };
}

/** `shared` replaces the database-backed steps (tests); the defaults are the real ones. */
export interface ImportDeps extends FetchDeps {
  shared?: { existing: typeof existingShared; create: typeof createAsset };
}

export async function importAsset(svc: Services, userId: string, input: ImportInput, deps: ImportDeps = {}): Promise<ImportedAsset> {
  const shared = deps.shared ?? { existing: existingShared, create: createAsset };
  try {
    const r = await libraryProviders(svc).registry.resolve(input.provider, input.externalId, { color: input.color });
    const variant = r.provenance.variant ?? "";
    const provenance = { ...r.provenance, variant };
    const key = { provider: provenance.provider, externalId: provenance.externalId ?? input.externalId, variant };
    // already on the instance: reuse the row, nothing to download
    const already = await shared.existing(svc, key);
    if (already) return already;
    let upload: { uploadId: string; filename: string };
    if (r.localPath) {
      if (r.sha256 && (await sha256File(r.localPath)) !== r.sha256) throw new ProviderError("The bundled file does not match the catalog (corrupted install?).");
      upload = await localAsUpload(svc, userId, r.localPath, r.name, r.ext);
    } else {
      upload = await downloadAsUpload(svc, userId, r.url, { ...deps, name: r.name, ext: r.ext });
      if (r.sha256) {
        const tmp = path.join(svc.paths.tmp, `catalog-${upload.uploadId}.${r.ext}`);
        try {
          await fs.mkdir(svc.paths.tmp, { recursive: true });
          await svc.storage.ensureLocal(keys.upload(upload.uploadId, `.${r.ext}`), tmp);
          if ((await sha256File(tmp)) !== r.sha256) {
            await svc.storage.delete(keys.upload(upload.uploadId, `.${r.ext}`)).catch(() => {});
            throw new ProviderError("The downloaded file does not match the catalog's checksum; nothing was added.");
          }
        } finally {
          await fs.rm(tmp, { force: true }).catch(() => {});
        }
      }
    }
    const tags = [...new Set([...(r.tags ?? []), ...(input.tags ?? [])].map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 30);
    return await shared.create(svc, { userId: null, actorId: userId, uploadId: upload.uploadId, name: r.name.slice(0, 120), tags, provenance, system: input.provider === "reelsaw" });
  } catch (err) {
    return asTrpc(err);
  }
}
