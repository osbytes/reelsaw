/**
 * The Reelsaw catalog (library/catalog.ts) and the import path (library/import.ts): bundled vs online manifest by
 * version, ETag refresh, failure handling, Fuse search, the committed starter pack's integrity, and an import that
 * verifies the sha256 and lands in `library.add` with system provenance. No network, no database.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../src/log.js";
import { createCatalog, manifestSchema, type Manifest } from "../src/library/catalog.js";
import { importAsset, libraryProviders } from "../src/library/import.js";
import type { Services } from "../src/services.js";

const log = { info() {}, warn() {}, error() {}, debug() {}, child: () => log } as unknown as Logger;
const URL_ = "https://reelsaw.test/catalog/v1/index.json";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const PACK = path.resolve(import.meta.dirname, "../assets/catalog");

const item = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "audio",
  mime: "audio/mpeg",
  name,
  tags: [name.toLowerCase()],
  bytes: 3,
  sha256: sha("abc"),
  url: `files/${id}.mp3`,
  license: { id: "cc0", name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
  source: { url: "https://example.com/" },
  ...over,
});
const manifest = (version: number, items: unknown[]): Manifest => manifestSchema.parse({ version, generatedAt: "2026-10-01T00:00:00Z", items });

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "reelsaw-catalog-test-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function bundle(m: Manifest, files: Record<string, string> = {}) {
  const b = path.join(dir, "bundled");
  await fs.mkdir(path.join(b, "files"), { recursive: true });
  await fs.writeFile(path.join(b, "index.json"), JSON.stringify(m));
  for (const [n, c] of Object.entries(files)) await fs.writeFile(path.join(b, "files", n), c);
  return b;
}
function store(bundledDir: string, f: typeof fetch = (async () => new Response("", { status: 500 })) as typeof fetch) {
  return createCatalog({ config: { DATA_DIR: path.join(dir, "data"), REELSAW_VERSION: "1.2.3" }, url: () => URL_, log, fetch: f, bundledDir });
}

describe("catalog manifest", () => {
  it("serves the bundled starter pack when offline", async () => {
    const c = store(await bundle(manifest(1, [item("sfx-pop", "Pop")])));
    const st = await c.refresh();
    assert.equal(st.changed, false);
    assert.equal(st.status.source, "bundled");
    assert.ok(st.status.lastError, "the failed fetch is recorded, not thrown");
    assert.equal((await c.search("", { limit: 10 })).items.length, 1);
  });

  it("takes the higher version, caches it, and sends If-None-Match afterwards", async () => {
    const seen: Array<string | undefined> = [];
    const online = manifest(5, [item("sfx-pop", "Pop"), item("sfx-new", "Whoosh Extra", { url: "files/sfx-new.mp3" })]);
    const f = (async (_u: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      seen.push(h["if-none-match"]);
      assert.equal(h["user-agent"], "reelsaw/1.2.3");
      return h["if-none-match"] === '"v5"'
        ? new Response(null, { status: 304 })
        : new Response(JSON.stringify(online), { status: 200, headers: { etag: '"v5"' } });
    }) as unknown as typeof fetch;
    const c = store(await bundle(manifest(1, [item("sfx-pop", "Pop")])), f);
    const first = await c.refresh();
    assert.equal(first.changed, true);
    assert.deepEqual([first.status.source, first.status.version, first.status.items, first.status.etag], ["cache", 5, 2, '"v5"']);
    const again = await c.refresh();
    assert.equal(again.changed, false);
    assert.deepEqual(seen, [undefined, '"v5"']);
    // a second process (new store, same DATA_DIR) reads the cache file
    assert.equal((await store(await bundle(manifest(1, []))).status()).version, 5);
    // force ignores the stored tag
    await c.refresh({ force: true });
    assert.equal(seen[2], undefined);
  });

  it("keeps the bundled pack when the online manifest is older, invalid, or unreachable", async () => {
    const b = await bundle(manifest(3, [item("sfx-pop", "Pop")]));
    for (const res of [
      () => new Response(JSON.stringify(manifest(2, [])), { status: 200 }),
      () => new Response("not json", { status: 200 }),
      () => new Response(JSON.stringify({ version: 9, items: [{ id: 1 }] }), { status: 200 }),
      () => {
        throw new Error("offline");
      },
    ]) {
      const c = store(b, (async () => res()) as unknown as typeof fetch);
      const r = await c.refresh({ force: true });
      assert.equal(r.status.version, 3);
      assert.equal(r.status.source, "bundled");
    }
  });

  it("refuses a non-https CATALOG_URL without fetching", async () => {
    let called = false;
    const c = createCatalog({
      config: { DATA_DIR: dir, REELSAW_VERSION: "x" },
      url: () => "http://insecure.test/index.json",
      log,
      fetch: (async () => ((called = true), new Response("{}"))) as unknown as typeof fetch,
      bundledDir: await bundle(manifest(1, [])),
    });
    const r = await c.refresh();
    assert.equal(called, false);
    assert.match(r.status.lastError!, /https/);
  });

  it("searches name and tags with Fuse, filters by kind and pages", async () => {
    const items = [
      item("sfx-whoosh", "Whoosh in", { tags: ["swoosh", "transition"] }),
      item("sfx-ding", "Ding", { tags: ["bell"] }),
      item("icon-star", "Star", { kind: "image", mime: "image/svg+xml", url: "files/icon-star.svg", tags: ["favorite"] }),
    ];
    const c = store(await bundle(manifest(1, items)));
    assert.equal((await c.search("swoosh", { limit: 5 })).items[0]!.externalId, "sfx-whoosh", "found by tag");
    assert.equal((await c.search("wosh", { limit: 5 })).items[0]!.externalId, "sfx-whoosh", "fuzzy");
    assert.deepEqual(
      (await c.search("", { kind: "image", limit: 5 })).items.map((i) => i.externalId),
      ["icon-star"],
    );
    const p1 = await c.search("", { limit: 2 });
    assert.equal(p1.items.length, 2);
    assert.equal(p1.nextCursor, "2");
    assert.equal((await c.search("", { limit: 2, cursor: p1.nextCursor })).items.length, 1);
    const hit = (await c.search("ding", { limit: 5 })).items[0]!;
    assert.equal(hit.previewUrl, "/media/catalog/sfx-ding.mp3");
    assert.equal(hit.license.id, "cc0");
  });
});

describe("the committed starter pack", () => {
  it("is a valid manifest whose files match their sha256, under 3 MB, and only permissive licenses", async () => {
    const m = manifestSchema.parse(JSON.parse(await fs.readFile(path.join(PACK, "index.json"), "utf8")));
    assert.ok(m.items.length >= 60, `${m.items.length} items`);
    let total = 0;
    for (const i of m.items) {
      const data = await fs.readFile(path.join(PACK, i.url));
      assert.equal(sha(data), i.sha256, i.id);
      assert.equal(data.length, i.bytes, i.id);
      assert.match(i.license.id, /^(cc0|isc|mit|apache-2\.0)$/, `${i.id} license`);
      assert.ok(i.source.url.startsWith("https://"), i.id);
      if (i.kind === "audio") assert.ok(i.durationSec! > 0 && i.durationSec! <= 8, i.id);
      total += data.length;
    }
    assert.ok(total < 3 * 1024 * 1024, `${total} bytes`);
    assert.ok(m.items.some((i) => i.id === "sfx-pop") && m.items.some((i) => i.id.startsWith("lucide-")) && m.items.some((i) => i.id.startsWith("emoji-")));
  });
  it("finds the sounds it is named for", async () => {
    const c = createCatalog({ config: { DATA_DIR: dir, REELSAW_VERSION: "x" }, url: () => URL_, log, bundledDir: PACK });
    for (const q of ["pop", "ding", "whoosh", "click", "error", "success", "record scratch"])
      assert.ok((await c.search(q, { kind: "audio", limit: 3 })).items.length, q);
  });
});

/** Just enough of Services for importAsset: storage in memory, an uploads table that records inserts. */
function fakeSvc(opts: { fetch?: typeof fetch; bundledDir: string }) {
  const objects = new Map<string, Buffer>();
  const uploads: Array<Record<string, unknown>> = [];
  const svc = {
    log,
    config: { DATA_DIR: path.join(dir, "data"), REELSAW_VERSION: "1.2.3" },
    settings: { get: () => ({ CATALOG_URL: URL_, ICONIFY_API_URL: "https://api.iconify.design", OPENVERSE_ENABLED: false }) },
    paths: { uploads: path.join(dir, "uploads"), tmp: path.join(dir, "tmp") },
    storage: {
      putFile: async (k: string, p: string) => void objects.set(k, await fs.readFile(p)),
      ensureLocal: async (k: string, p: string) => (await fs.writeFile(p, objects.get(k)!), p),
      delete: async (k: string) => void objects.delete(k),
    },
    database: { db: { insert: () => ({ values: async (v: Record<string, unknown>) => void uploads.push(v) }) } },
    // the unit of work: the same fake table, no quota (settings carry no MAX_STORAGE_MB), the lock and settings reads answered empty
    tx: async (fn: (u: unknown) => Promise<unknown>) =>
      fn({
        db: {
          insert: () => ({ values: async (v: Record<string, unknown>) => void uploads.push(v) }),
          execute: async () => ({ rows: [] }),
          query: { userSettings: { findFirst: async () => undefined } },
        },
      }),
  } as unknown as Services;
  libraryProviders(svc, { fetch: opts.fetch, bundledDir: opts.bundledDir });
  return { svc, objects, uploads };
}

describe("importing from the catalog", () => {
  // an in-memory stand-in for the shared rows: one per (provider, externalId, variant), like the unique index
  const created: Array<Record<string, any>> = [];
  const rows = new Map<string, { id: string; name: string; kind: string; mime: string; durationSec: number; duplicate: boolean; restored: boolean }>();
  const shared = {
    existing: async (_svc: unknown, k: { provider: string; externalId: string; variant: string }) => {
      const row = rows.get(`${k.provider}|${k.externalId}|${k.variant}`);
      if (!row) return null;
      return { ...row, duplicate: true };
    },
    create: async (_svc: unknown, i: Record<string, any>) => {
      created.push(i);
      const p = i.provenance;
      const row = { id: `asset-${rows.size + 1}`, name: i.name, kind: "audio", mime: "audio/mpeg", durationSec: 1, duplicate: false, restored: false };
      rows.set(`${p.provider}|${p.externalId}|${p.variant ?? ""}`, row);
      return row;
    },
  } as never;
  beforeEach(() => {
    created.length = 0;
    rows.clear();
  });

  it("copies a bundled file, verifies it and creates a system asset with provenance", async () => {
    const b = await bundle(manifest(1, [item("sfx-pop", "Pop", { sha256: sha("abc"), tags: ["bubble"] })]), { "sfx-pop.mp3": "abc" });
    const { svc, objects, uploads } = fakeSvc({ bundledDir: b });
    const r = await importAsset(svc, "u1", { provider: "reelsaw", externalId: "sfx-pop", tags: ["Extra"] }, { shared });
    assert.equal(r.id, "asset-1");
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]!.userId, "u1");
    assert.match(String(uploads[0]!.filename), /^Pop\.mp3$/);
    assert.equal(objects.get(String(uploads[0]!.storageKey))!.toString(), "abc");
    const c = created[0]!;
    assert.equal(c.system, true);
    assert.equal(c.userId, null, "an import is an instance-shared row");
    assert.equal(c.actorId, "u1");
    assert.equal("saveFor" in c, false);
    assert.equal("category" in c, false);
    assert.deepEqual(c.tags, ["bubble", "extra"]);
    assert.deepEqual(c.provenance, {
      provider: "reelsaw",
      externalId: "sfx-pop",
      url: "https://example.com/",
      license: { id: "cc0", name: "CC0 1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" },
      variant: "",
    });
  });

  it("a second account importing the same item reuses the shared row", async () => {
    const b = await bundle(manifest(1, [item("sfx-pop", "Pop", { sha256: sha("abc") })]), { "sfx-pop.mp3": "abc" });
    const { svc, uploads } = fakeSvc({ bundledDir: b });
    const first = await importAsset(svc, "u1", { provider: "reelsaw", externalId: "sfx-pop" }, { shared });
    const second = await importAsset(svc, "u2", { provider: "reelsaw", externalId: "sfx-pop" }, { shared });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.id, first.id);
    assert.equal(created.length, 1, "one row for the whole instance");
    assert.equal(uploads.length, 1, "nothing is copied or downloaded the second time");
  });

  it("refuses a bundled file that no longer matches the manifest", async () => {
    const b = await bundle(manifest(1, [item("sfx-pop", "Pop")]), { "sfx-pop.mp3": "tampered" });
    const { svc, uploads } = fakeSvc({ bundledDir: b });
    await assert.rejects(importAsset(svc, "u1", { provider: "reelsaw", externalId: "sfx-pop" }, { shared }), /does not match/);
    assert.equal(uploads.length, 0);
    assert.equal(created.length, 0);
  });

  it("downloads a file of the online manifest, verifies the checksum and says so when it differs", async () => {
    const online = manifest(9, [item("sfx-new", "New", { url: "files/sfx-new.mp3", sha256: sha("abc") })]);
    let body = "abc";
    const f = (async (u: URL | string) => {
      const href = u.toString();
      if (href === URL_) return new Response(JSON.stringify(online), { status: 200 });
      assert.equal(href, "https://reelsaw.test/catalog/v1/files/sfx-new.mp3");
      return new Response(body, { status: 200, headers: { "content-type": "audio/mpeg" } });
    }) as unknown as typeof fetch;
    const { svc, objects } = fakeSvc({ fetch: f, bundledDir: await bundle(manifest(1, [])) });
    await libraryProviders(svc).catalog.refresh();
    const found = await libraryProviders(svc).catalog.find("sfx-new");
    assert.equal(found?.fileUrl, "https://reelsaw.test/catalog/v1/files/sfx-new.mp3");
    assert.equal(found?.localPath, undefined, "an online item is downloaded, not read from disk");
    const lookup = async () => ["93.184.216.34"];
    const ok = await importAsset(svc, "u1", { provider: "reelsaw", externalId: "sfx-new" }, { shared, fetch: f, lookup });
    assert.equal(ok.id, "asset-1");
    assert.equal(created.at(-1)!.system, true);
    assert.equal(
      [...objects.values()].some((b) => b.toString() === "abc"),
      true,
    );
    body = "evil";
    objects.clear();
    rows.clear(); // not yet on the instance, so it is fetched again
    await assert.rejects(importAsset(svc, "u1", { provider: "reelsaw", externalId: "sfx-new" }, { shared, fetch: f, lookup }), /checksum/);
    assert.equal(objects.size, 0, "the mismatching upload is removed");
  });

  it("explains an unknown catalog id and an unlisted provider", async () => {
    const { svc } = fakeSvc({ bundledDir: await bundle(manifest(1, [])) });
    await assert.rejects(importAsset(svc, "u1", { provider: "reelsaw", externalId: "nope" }, { shared }), /not in the Reelsaw catalog/);
    await assert.rejects(importAsset(svc, "u1", { provider: "pexels", externalId: "photo:1" }, { shared }), /Unknown or disabled provider/);
  });
});
