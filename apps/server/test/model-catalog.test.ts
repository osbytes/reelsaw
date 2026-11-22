/**
 * The model catalog's paged listing (ai/catalog.ts `page`), what the Settings → Models picker, list_models and
 * `reelsaw models` read: a self-hosted Speaches server lists hundreds of downloadable models, so a provider's models
 * leave a page at a time, the models in use first, with a cursor to the next page, and a search ranks matches on
 * the server. A fake Speaches server on localhost; no keys, so no cloud provider is asked.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createModelCatalog } from "../src/ai/catalog.js";
import type { CredentialSource } from "../src/ai/registry.js";
import type { Config } from "../src/config.js";
import type { Logger } from "../src/log.js";

const log = { info() {}, warn() {}, error() {}, debug() {}, child: () => log } as unknown as Logger;
const INSTALLED = ["Systran/faster-whisper-small"];
const REGISTRY = [
  ...INSTALLED,
  "Systran/faster-whisper-medium",
  "deepdml/faster-whisper-large-v3-turbo-ct2",
  ...Array.from({ length: 117 }, (_, i) => `acme/asr-fine-tune-${String(i).padStart(3, "0")}`),
];

let server: http.Server;
let base = "";
before(async () => {
  server = http.createServer((req, res) => {
    const json = (v: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (req.url === "/v1/models") return json({ data: INSTALLED.map((id) => ({ id })) });
    if (req.url === "/v1/registry?task=automatic-speech-recognition") return json({ data: REGISTRY.map((id) => ({ id })) });
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

function catalog() {
  const config = { OPENAI_COMPATIBLE_NAME: "ollama" } as unknown as Config;
  // only the Speaches server: a key in the developer's shell must not send the test to a real provider
  const credentials: CredentialSource = { get: (p) => (p === "openai" ? { baseUrl: `${base}/v1` } : {}), version: () => 0 };
  return createModelCatalog(config, log, credentials);
}

describe("model catalog pages", () => {
  it("sends a provider's first page, installed models first, with the total and a cursor", async () => {
    const r = await catalog().page("transcription", { limit: 50 });
    const speaches = r.providers.find((p) => p.provider === "openai")!;
    assert.equal(speaches.selfHosted?.server, "speaches");
    assert.equal(speaches.models.length, 50);
    assert.equal(speaches.total, REGISTRY.length);
    assert.equal(speaches.installedCount, 1);
    assert.equal(speaches.nextCursor, "50");
    assert.deepEqual(speaches.models[0], { id: "openai:Systran/faster-whisper-small", label: "Systran/faster-whisper-small", installed: true });
    // the small static lists fit on one page
    const deepgram = r.providers.find((p) => p.provider === "deepgram")!;
    assert.deepEqual([deepgram.total, deepgram.nextCursor, deepgram.available], [2, null, false]);
    assert.equal(r.limit, 50);
    assert.equal(r.q, null);
  });

  it("pages one provider to its end without repeats", async () => {
    const c = catalog();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const { providers } = await c.page("transcription", { provider: "openai", cursor, limit: 50 });
      assert.equal(providers.length, 1);
      seen.push(...providers[0]!.models.map((m) => m.id));
      cursor = providers[0]!.nextCursor ?? undefined;
      if (!cursor) break;
    }
    assert.equal(seen.length, REGISTRY.length);
    assert.equal(new Set(seen).size, REGISTRY.length);
  });

  it("puts the models in use first when browsing", async () => {
    const pin = ["openai:acme/asr-fine-tune-099", "anthropic:not-here"];
    const { providers } = await catalog().page("transcription", { provider: "openai", pin, limit: 5 });
    assert.equal(providers[0]!.models[0]!.id, "openai:acme/asr-fine-tune-099");
    assert.equal(providers[0]!.total, REGISTRY.length, "pinning reorders, never adds or drops");
  });

  it("searches on the server: matching providers only, best first, paged the same way", async () => {
    const c = catalog();
    const turbo = await c.page("transcription", { q: "large v3 turbo", limit: 20 });
    assert.equal(turbo.q, "large v3 turbo");
    assert.equal(turbo.providers[0]!.provider, "openai");
    assert.equal(turbo.providers[0]!.models[0]!.id, "openai:deepdml/faster-whisper-large-v3-turbo-ct2");
    const nova = await c.page("transcription", { q: "nova" });
    assert.deepEqual(
      nova.providers.map((p) => p.provider),
      ["deepgram"],
    );
    const fine = await c.page("transcription", { q: "asr-fine-tune", provider: "openai", limit: 20 });
    assert.equal(fine.providers[0]!.models.length, 20);
    assert.ok(fine.providers[0]!.total >= 117);
    const next = await c.page("transcription", { q: "asr-fine-tune", provider: "openai", limit: 20, cursor: fine.providers[0]!.nextCursor! });
    const ids = new Set(fine.providers[0]!.models.map((m) => m.id));
    assert.ok(next.providers[0]!.models.every((m) => !ids.has(m.id)));
    assert.deepEqual((await c.page("transcription", { q: "zzqqxx" })).providers, []);
  });

  it("refuses an unknown provider or a cursor it never gave", async () => {
    const c = catalog();
    await assert.rejects(c.page("transcription", { provider: "nope" }), /no provider "nope"/);
    await assert.rejects(c.page("transcription", { cursor: "-3" }), /not one this listing gave out/);
    await assert.rejects(c.page("transcription", { cursor: "abc" }), /not one this listing gave out/);
  });

  it("clamps the page size", async () => {
    const r = await catalog().page("transcription", { provider: "openai", limit: 5000 });
    assert.equal(r.limit, 100);
    assert.equal(r.providers[0]!.models.length, 100);
  });
});
