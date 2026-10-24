/**
 * Remote asset providers (library/providers): request shape, mapping of untrusted answers, resolve, the 24 h
 * LRU search cache, 429 handling, which providers are listed. `fetch` is mocked; nothing here touches the network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Logger } from "../src/log.js";
import type { RuntimeSettings } from "../src/instance-settings.js";
import type { Catalog } from "../src/library/catalog.js";
import { createProviderHttp, createProviderRegistry, ProviderError, SEARCH_CACHE_MAX, SEARCH_CACHE_TTL_MS } from "../src/library/providers/index.js";
import { freesoundLicense } from "../src/library/providers/freesound.js";

const log = { info() {}, warn() {}, error() {}, debug() {}, child: () => log } as unknown as Logger;
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

type Call = { url: URL; headers: Record<string, string> };
function mockFetch(handler: (u: URL, headers: Record<string, string>) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(input.toString());
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, headers });
    return handler(url, headers);
  }) as typeof fetch;
  return { f, calls };
}

const KEYS = { PEXELS_API_KEY: "pex-key", PIXABAY_API_KEY: "pix-key", FREESOUND_API_KEY: "fs-key", GIPHY_API_KEY: "gi-key", KLIPY_API_KEY: "kl-key", ICONIFY_API_URL: "https://api.iconify.design", OPENVERSE_ENABLED: true } as const;
const catalogStub = { search: async () => ({ items: [] }), find: async () => undefined } as unknown as Catalog;

function setup(handler: Parameters<typeof mockFetch>[0], settings: Partial<RuntimeSettings> = KEYS, clock = { t: 1_000_000 }) {
  const m = mockFetch(handler);
  const http = createProviderHttp({ fetch: m.f, version: "9.9.9", log, now: () => clock.t });
  const registry = createProviderRegistry({ settings: () => settings as RuntimeSettings, http, catalog: catalogStub, now: () => clock.t });
  return { ...m, registry, clock, http };
}

describe("provider listing", () => {
  it("hides providers whose key is empty and Openverse until enabled", () => {
    const { registry } = setup(() => json({}), { ICONIFY_API_URL: "https://api.iconify.design", OPENVERSE_ENABLED: false });
    assert.deepEqual(registry.list().map((p) => p.id), ["reelsaw", "iconify"]);
    const all = setup(() => json({})).registry.list();
    assert.deepEqual(all.map((p) => p.id), ["reelsaw", "pexels", "pixabay", "freesound", "iconify", "giphy", "klipy", "openverse"]);
    assert.equal(all.find((p) => p.id === "giphy")!.attributionLine, "Powered by GIPHY");
    assert.equal(all.find((p) => p.id === "klipy")!.experimental, true);
  });
  it("refuses a provider that is not listed with a sentence", async () => {
    const { registry } = setup(() => json({}), { OPENVERSE_ENABLED: false, ICONIFY_API_URL: "https://api.iconify.design" });
    await assert.rejects(registry.search("pexels", "cat"), (e: Error) => e instanceof ProviderError && /Settings/.test(e.message));
  });
});

describe("pexels", () => {
  const photos = { photos: [{ id: 7, width: 4000, height: 6000, url: "https://www.pexels.com/photo/7/", photographer: "Ann", alt: "A cat", src: { large: "https://images.pexels.com/7-large.jpg", small: "https://images.pexels.com/7-small.jpg", large2x: "https://images.pexels.com/7-2x.jpg" } }], next_page: "https://api.pexels.com/v1/search?page=2" };
  const videos = { videos: [{ id: 9, duration: 12, url: "https://www.pexels.com/video/9/", image: "https://images.pexels.com/9.jpg", user: { name: "Bo" }, video_files: [{ file_type: "video/mp4", width: 2160, height: 3840, link: "https://videos.pexels.com/uhd.mp4" }, { file_type: "video/mp4", width: 1080, height: 1920, link: "https://videos.pexels.com/hd.mp4" }, { file_type: "video/webm", width: 540, height: 960, link: "https://videos.pexels.com/x.webm" }] }] };

  it("searches photos and portrait videos with the key in Authorization", async () => {
    const { registry, calls } = setup((u) => (u.pathname === "/v1/search" ? json(photos) : json(videos)));
    const r = await registry.search("pexels", "cat");
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.headers.authorization, "pex-key");
    assert.equal(calls[0]!.headers["user-agent"], "reelsaw/9.9.9");
    const v = calls.find((c) => c.url.pathname === "/v1/videos/search")!;
    assert.equal(v.url.searchParams.get("orientation"), "portrait");
    assert.equal(v.url.searchParams.get("size"), "medium");
    assert.deepEqual(r.items.map((i) => [i.externalId, i.kind]), [["photo:7", "image"], ["video:9", "video"]]);
    assert.equal(r.items[0]!.attribution, "Photo by Ann on Pexels");
    assert.equal(r.items[1]!.previewUrl, "https://videos.pexels.com/hd.mp4", "the mp4 up to 1080 wide");
    assert.equal(r.nextCursor, "2");
  });
  it("resolves a photo to its large2x file and a video to the 1080 mp4", async () => {
    const { registry } = setup((u) => (u.pathname === "/v1/photos/7" ? json(photos.photos[0]) : json(videos.videos[0])));
    const p = await registry.resolve("pexels", "photo:7");
    assert.equal(p.url, "https://images.pexels.com/7-2x.jpg");
    assert.equal(p.ext, "jpg");
    assert.equal(p.provenance.license?.name, "Pexels License");
    assert.equal(p.provenance.externalId, "photo:7");
    const v = await registry.resolve("pexels", "video:9");
    assert.deepEqual([v.url, v.ext, v.kind], ["https://videos.pexels.com/hd.mp4", "mp4", "video"]);
    await assert.rejects(registry.resolve("pexels", "7"), ProviderError);
  });
  it("ignores http (non-https) file links", async () => {
    const bad = { photos: [{ id: 1, src: { large: "http://insecure.example/x.jpg" } }] };
    const { registry } = setup(() => json(bad));
    assert.deepEqual((await registry.search("pexels", "x", { kind: "image" })).items, []);
  });
});

describe("pixabay", () => {
  it("passes the key and q, never logs it, and maps images and videos", async () => {
    const { registry, calls } = setup((u) =>
      u.pathname.startsWith("/api/videos")
        ? json({ totalHits: 1, hits: [{ id: 3, pageURL: "https://pixabay.com/videos/3/", tags: "sea, waves", duration: 8, user: "Cy", videos: { medium: { url: "https://cdn.pixabay.com/v.mp4", width: 1080, height: 1920, thumbnail: "https://cdn.pixabay.com/t.jpg" } } }] })
        : json({ totalHits: 100, hits: [{ id: 5, pageURL: "https://pixabay.com/p/5/", tags: "cat, pet", webformatURL: "https://pixabay.com/w.jpg", previewURL: "https://pixabay.com/p.jpg", largeImageURL: "https://pixabay.com/l.jpg", user: "Di", type: "photo" }] }),
    );
    const r = await registry.search("pixabay", "sea", { limit: 20 });
    assert.equal(calls[0]!.url.searchParams.get("key"), "pix-key");
    assert.deepEqual(r.items.map((i) => i.externalId), ["photo:5", "video:3"]);
    assert.equal(r.items[0]!.attribution, "Image by Di on Pixabay");
    assert.equal(r.nextCursor, "2");
  });
  it("resolves to the downloadable file (largeImageURL; vectors prefer vectorURL when approved)", async () => {
    const hit = { id: 5, pageURL: "https://pixabay.com/p/5/", tags: "cat", largeImageURL: "https://pixabay.com/l.png", vectorURL: "https://pixabay.com/v.svg", user: "Di" };
    const { registry, calls } = setup(() => json({ hits: [hit] }));
    const photo = await registry.resolve("pixabay", "photo:5");
    assert.deepEqual([photo.url, photo.ext], ["https://pixabay.com/l.png", "png"]);
    const vector = await registry.resolve("pixabay", "vector:5");
    assert.deepEqual([vector.url, vector.ext], ["https://pixabay.com/v.svg", "svg"]);
    assert.equal(calls[0]!.url.searchParams.get("id"), "5");
    await assert.rejects(setup(() => json({ hits: [] })).registry.resolve("pixabay", "photo:5"), /no longer/);
  });
});

describe("freesound", () => {
  const sound = (over: Record<string, unknown> = {}) => ({ id: 1, name: "boom.wav", username: "zed", license: "http://creativecommons.org/publicdomain/zero/1.0/", duration: 2.5, previews: { "preview-hq-mp3": "https://cdn.freesound.org/previews/1/1_1-hq.mp3" }, url: "https://freesound.org/s/1/", tags: ["Boom", "hit"], ...over });
  it("filters CC0 by default, asks for the fields and imports the HQ mp3 preview", async () => {
    const { registry, calls } = setup(() => json({ next: "https://freesound.org/apiv2/search/text/?page=2", results: [sound(), sound({ id: 2, license: "http://creativecommons.org/licenses/by-nc/4.0/" }), sound({ id: 3, license: "http://creativecommons.org/licenses/by/4.0/" })] }));
    const r = await registry.search("freesound", "boom");
    const u = calls[0]!.url;
    assert.equal(u.pathname, "/apiv2/search/text/");
    assert.equal(u.searchParams.get("filter"), 'license:"Creative Commons 0"');
    assert.equal(u.searchParams.get("token"), "fs-key");
    assert.match(u.searchParams.get("fields")!, /previews/);
    assert.deepEqual(r.items.map((i) => [i.externalId, i.license.id]), [["1", "cc0"], ["3", "cc-by"]], "NC is dropped");
    assert.equal(r.items[1]!.attribution, "boom.wav by zed (Freesound)");
    assert.equal(r.nextCursor, "2");
    const by = setup(() => json({ results: [] }));
    await by.registry.search("freesound", "boom", { license: "by" });
    assert.match(by.calls[0]!.url.searchParams.get("filter")!, /Attribution/);
  });
  it("resolves to an mp3 with the license and credit; refuses a non-commercial sound", async () => {
    const { registry } = setup(() => json(sound({ license: "http://creativecommons.org/licenses/by/4.0/" })));
    const r = await registry.resolve("freesound", "1");
    assert.deepEqual([r.url, r.ext, r.kind], ["https://cdn.freesound.org/previews/1/1_1-hq.mp3", "mp3", "audio"]);
    assert.equal(r.provenance.attribution, "boom.wav by zed (Freesound)");
    assert.equal(r.provenance.license?.id, "cc-by");
    await assert.rejects(setup(() => json(sound({ license: "http://creativecommons.org/licenses/by-nc/4.0/" }))).registry.resolve("freesound", "1"), /cannot be imported/);
  });
  it("maps license strings", () => {
    assert.equal(freesoundLicense("Creative Commons 0")?.id, "cc0");
    assert.equal(freesoundLicense("Attribution")?.id, "cc-by");
    assert.equal(freesoundLicense("Attribution NonCommercial"), null);
    assert.equal(freesoundLicense("Sampling+"), null);
  });
});

describe("iconify", () => {
  const handler = (u: URL) => {
    if (u.pathname === "/search") return json({ total: 3, icons: ["lucide:star", "tabler:star", "evil:star"] });
    if (u.pathname === "/collections") return json({ lucide: { license: { title: "ISC", spdx: "ISC" } }, tabler: { license: { title: "MIT", spdx: "MIT" } } });
    return json({});
  };
  it("searches only the allowlisted sets and reads each set's license", async () => {
    const { registry, calls } = setup(handler);
    const r = await registry.search("iconify", "star");
    assert.equal(calls.find((c) => c.url.pathname === "/search")!.url.searchParams.get("prefixes"), "lucide,tabler,mdi,ph,heroicons,ri,solar");
    assert.deepEqual(r.items.map((i) => [i.externalId, i.license.id, i.mime]), [["lucide:star", "isc", "image/svg+xml"], ["tabler:star", "mit", "image/svg+xml"]], "a set outside the list is dropped");
  });
  it("resolves to a coloured 512 px svg sticker, and refuses a bad colour or set", async () => {
    const { registry } = setup(handler);
    const r = await registry.resolve("iconify", "lucide:star", { color: "#ff0000" });
    const u = new URL(r.url);
    assert.equal(u.pathname, "/lucide/star.svg");
    assert.equal(u.searchParams.get("color"), "#ff0000");
    assert.equal(u.searchParams.get("width"), "512");
    assert.deepEqual([r.ext, r.kind], ["svg", "image"]);
    assert.equal((await registry.resolve("iconify", "lucide:star")).url.includes("color=%23ffffff"), true, "white by default");
    await assert.rejects(registry.resolve("iconify", "lucide:star", { color: "red" }), /hex/);
    await assert.rejects(registry.resolve("iconify", "evil:star"), /allowed set/);
  });
});

describe("openverse", () => {
  it("asks for commercial CC0 / BY and drops other licenses", async () => {
    const { registry, calls } = setup((u) =>
      u.pathname === "/v1/images/"
        ? json({ page_count: 3, results: [{ id: "11111111-1111-1111-1111-111111111111", title: "Pic", url: "https://o.example/a.jpg", thumbnail: "https://o.example/t.jpg", license: "by", license_version: "4.0", creator: "Eve", foreign_landing_url: "https://o.example/p" }, { id: "22222222-2222-2222-2222-222222222222", title: "Bad", url: "https://o.example/b.jpg", license: "by-nc" }] })
        : json({ results: [] }),
    );
    const r = await registry.search("openverse", "pic", { kind: "image" });
    const u = calls[0]!.url;
    assert.equal(u.searchParams.get("license"), "cc0,by");
    assert.equal(u.searchParams.get("license_type"), "commercial");
    assert.deepEqual(r.items.map((i) => i.license.id), ["cc-by-4.0"]);
    assert.match(r.items[0]!.attribution!, /Pic|Eve/);
    assert.equal(r.nextCursor, "2");
  });
});

describe("giphy", () => {
  const gif = { id: "abc", title: "wow", url: "https://giphy.com/gifs/abc", username: "u", images: { original: { url: "https://media.giphy.com/o.gif", mp4: "https://media.giphy.com/o.mp4", width: "480", height: "270" }, fixed_width: { url: "https://media.giphy.com/fw.gif" } } };
  it("imports gifs as mp4 video and stickers as the transparent gif", async () => {
    const { registry } = setup(() => json({ data: gif }));
    const g = await registry.resolve("giphy", "gif:abc");
    assert.deepEqual([g.url, g.ext, g.kind], ["https://media.giphy.com/o.mp4", "mp4", "video"]);
    const s = await registry.resolve("giphy", "sticker:abc");
    assert.deepEqual([s.url, s.ext, s.kind], ["https://media.giphy.com/o.gif", "gif", "image"]);
  });
  it("searches gifs and stickers and carries the offset cursor", async () => {
    const { registry, calls } = setup(() => json({ data: [gif], pagination: { total_count: 100, count: 1, offset: 0 } }));
    const r = await registry.search("giphy", "wow");
    assert.deepEqual(calls.map((c) => c.url.pathname).sort(), ["/v1/gifs/search", "/v1/stickers/search"]);
    assert.equal(r.items.length, 2);
    assert.equal(r.nextCursor, "1");
  });
});

describe("klipy (experimental)", () => {
  it("follows the Tenor v2 shape with the key in the path", async () => {
    const { registry, calls } = setup(() => json({ results: [{ id: "k1", title: "hey", media_formats: { mp4: { url: "https://static.klipy.com/a.mp4" }, tinygif: { url: "https://static.klipy.com/t.gif" }, gif: { url: "https://static.klipy.com/a.gif", dims: [320, 240] } } }] }));
    const r = await registry.search("klipy", "hey");
    assert.equal(calls[0]!.url.pathname, "/api/v1/kl-key/gifs/search");
    assert.deepEqual(r.items.map((i) => [i.externalId, i.kind]), [["k1", "video"]]);
    const res = await registry.resolve("klipy", "k1");
    assert.deepEqual([res.url, res.ext], ["https://static.klipy.com/a.mp4", "mp4"]);
  });
});

describe("transport rules", () => {
  it("refuses non-https endpoints", async () => {
    const { registry } = setup(() => json({}), { ...KEYS, ICONIFY_API_URL: "http://iconify.local" });
    await assert.rejects(registry.search("iconify", "x"), /only https/);
  });
  it("turns a request failure into a sentence", async () => {
    const { registry } = setup(() => {
      throw new Error("boom");
    });
    await assert.rejects(registry.search("pexels", "x"), /did not answer/);
  });
  it("explains a refused key and an upstream error", async () => {
    await assert.rejects(setup(() => new Response("no", { status: 401 })).registry.search("pexels", "x"), /refused the key/);
    await assert.rejects(setup(() => new Response("no", { status: 500 })).registry.search("pexels", "x"), /HTTP 500/);
  });
  it("parks a provider after a 429 until the reset and says so", async () => {
    let hits = 0;
    const { registry, clock } = setup(() => {
      hits++;
      return new Response("slow down", { status: 429, headers: { "retry-after": "90" } });
    });
    const first = await registry.search("pexels", "x");
    assert.deepEqual(first.items, []);
    assert.match(first.unavailable!, /pexels is rate limiting/);
    assert.equal(registry.list().find((p) => p.id === "pexels")!.available, false);
    const before = hits;
    await registry.search("pexels", "y");
    assert.equal(hits, before, "no request while parked");
    clock.t += 91_000;
    assert.equal(registry.list().find((p) => p.id === "pexels")!.available, true);
    await registry.search("pexels", "y");
    assert.ok(hits > before, "asks again after the reset");
  });
  it("defaults a 429 without a reset to 60 s", async () => {
    const { registry, clock } = setup(() => new Response("", { status: 429 }));
    await registry.search("giphy", "x");
    clock.t += 59_000;
    assert.equal(registry.list().find((p) => p.id === "giphy")!.available, false);
    clock.t += 2_000;
    assert.equal(registry.list().find((p) => p.id === "giphy")!.available, true);
  });
});

describe("empty query", () => {
  it("does not ask a remote provider, and still searches the catalog", async () => {
    let catalogHits = 0;
    const catalog = { ...catalogStub, search: async () => (catalogHits++, { items: [] }) } as unknown as Catalog;
    const m = mockFetch(() => json({}));
    const http = createProviderHttp({ fetch: m.f, version: "9.9.9", log, now: () => 1 });
    const registry = createProviderRegistry({ settings: () => KEYS as unknown as RuntimeSettings, http, catalog, now: () => 1 });
    assert.deepEqual((await registry.search("iconify", "")).items, []);
    assert.deepEqual((await registry.search("pexels", "  ")).items, []);
    assert.equal(m.calls.length, 0);
    await registry.search("reelsaw", "");
    assert.equal(catalogHits, 1);
  });
});

describe("search cache", () => {
  const ok = () => json({ photos: [{ id: 1, src: { large: "https://i.example/1.jpg" } }] });
  it("serves a repeat from memory for 24 h, keyed by provider, q, kind and cursor", async () => {
    const { registry, calls, clock } = setup(ok);
    await registry.search("pexels", "Cat", { kind: "image" });
    await registry.search("pexels", " cat ", { kind: "image" });
    assert.equal(calls.length, 1, "same query, one request");
    await registry.search("pexels", "cat", { kind: "image", cursor: "2" });
    assert.equal(calls.length, 2, "another page is another entry");
    clock.t += SEARCH_CACHE_TTL_MS + 1;
    await registry.search("pexels", "cat", { kind: "image" });
    assert.equal(calls.length, 3, "expired after 24 h");
  });
  it("evicts the least recently used entry beyond 2000", async () => {
    const { registry, calls } = setup(ok);
    for (let i = 0; i < SEARCH_CACHE_MAX; i++) await registry.search("pexels", `q${i}`, { kind: "image" });
    await registry.search("pexels", "q0", { kind: "image" }); // touch the oldest: now the newest
    assert.equal(calls.length, SEARCH_CACHE_MAX);
    await registry.search("pexels", "extra", { kind: "image" }); // evicts q1, not q0
    const n = calls.length;
    await registry.search("pexels", "q0", { kind: "image" });
    assert.equal(calls.length, n, "q0 survived");
    await registry.search("pexels", "q1", { kind: "image" });
    assert.equal(calls.length, n + 1, "q1 was evicted");
  });
  it("does not cache a rate-limited answer", async () => {
    let limited = true;
    const { registry, clock } = setup(() => (limited ? new Response("", { status: 429, headers: { "retry-after": "1" } }) : ok()));
    assert.ok((await registry.search("pexels", "x", { kind: "image" })).unavailable);
    limited = false;
    clock.t += 2_000;
    assert.equal((await registry.search("pexels", "x", { kind: "image" })).items.length, 1);
  });
});
