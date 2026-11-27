/**
 * PostHog reverse proxy (posthog-proxy.ts): which upstream a path goes to, and what is forwarded. No docker needed.
 * Run: pnpm --filter @reelsaw/server exec node --import tsx --test test/posthog-proxy.test.ts
 */
import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { posthogHosts, posthogProxy, upstreamUrl } from "../src/posthog-proxy.js";

describe("posthogHosts", () => {
  it("derives the assets and app hosts for the PostHog cloud, and reuses a self-hosted one", () => {
    assert.deepEqual(posthogHosts("https://eu.i.posthog.com/"), {
      api: "https://eu.i.posthog.com",
      assets: "https://eu-assets.i.posthog.com",
      ui: "https://eu.posthog.com",
    });
    assert.deepEqual(posthogHosts("https://ph.example.com"), { api: "https://ph.example.com", assets: "https://ph.example.com", ui: "https://ph.example.com" });
  });
});

describe("upstreamUrl", () => {
  const host = "https://us.i.posthog.com";
  it("forwards the rest of the path and the query; static bundles go to the assets host", () => {
    assert.equal(upstreamUrl("http://app.test/relay/e/?compression=gzip-js&ver=1", "/relay", host), "https://us.i.posthog.com/e/?compression=gzip-js&ver=1");
    assert.equal(upstreamUrl("http://app.test/relay/static/array.js", "/relay", host), "https://us-assets.i.posthog.com/static/array.js");
    assert.equal(upstreamUrl("http://app.test/relay", "/relay", host), "https://us.i.posthog.com/");
  });
  it("ignores paths that only start with the same letters", () => {
    assert.equal(upstreamUrl("http://app.test/relayed/e/", "/relay", host), null);
  });
});

describe("posthogProxy", () => {
  afterEach(() => mock.restoreAll());
  const config = {
    POSTHOG_HOST: "https://us.i.posthog.com",

    TRUST_PROXY: true,
    TRUSTED_PROXY_HEADER: "x-forwarded-for",
    TRUSTED_PROXY_HOPS: 1,
  };

  it("sends no cookie or authorization upstream, the client address as X-Forwarded-For, and sets no cookie back", async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      sent = { url, init };
      return new Response('{"status":1}', { status: 200, headers: { "content-type": "application/json", "set-cookie": "x=1", "content-encoding": "gzip" } });
    });
    const app = new Hono();
    app.all("/api/relay/*", posthogProxy(config));
    const res = await app.request("/api/relay/e/?ver=1", {
      method: "POST",
      body: "payload",
      headers: { cookie: "session=secret", authorization: "Bearer rs_x", "content-type": "text/plain", "x-forwarded-for": "203.0.113.7" },
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"status":1}');
    assert.equal(res.headers.get("set-cookie"), null);
    assert.equal(res.headers.get("content-encoding"), null);
    assert.ok(sent);
    const { url, init } = sent as { url: string; init: RequestInit };
    assert.equal(url, "https://us.i.posthog.com/e/?ver=1");
    const headers = init.headers as Headers;
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("content-type"), "text/plain");
    assert.equal(headers.get("x-forwarded-for"), "203.0.113.7");
    assert.equal(new TextDecoder().decode(init.body as ArrayBuffer), "payload");
  });

  it("answers 502 when PostHog cannot be reached", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const app = new Hono();
    app.all("/api/relay/*", posthogProxy(config));
    assert.equal((await app.request("/api/relay/flags/?v=2", { method: "POST", body: "{}" })).status, 502);
  });
});
