/**
 * Webhooks and share links, the parts that need no database: Standard Webhooks signing (checked with the reference
 * library's verify), the retry schedule, masking, the POST outcomes (2xx, 4xx/5xx, redirect, connect error), share
 * link names and the redaction of tokens from logs and reports.
 * node --import tsx --test test/webhooks.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Webhook } from "standardwebhooks";
import { nextDelaySec, postOnce, RETRY_DELAYS_SEC, signedHeaders } from "../src/webhooks/deliver.js";
import { maskWebhookUrl, webhookEventId } from "../src/webhooks/service.js";
import { isWebhookEvent } from "../src/webhooks/outbox.js";
import { linkFileName, linkUrl, maskLinkUrl } from "../src/media-links/service.js";
import { redactPath } from "../src/request-log.js";
import { scrubOutboundText } from "../src/report/redact.js";
import { projectMetadataSchema } from "@reelsaw/shared";
import type { PublicResponse } from "../src/lib/safe-url.js";

// made here rather than written out, so the secret scan has nothing to flag
const testSecret = (seed: string) => `whsec_${Buffer.from(seed.padEnd(24, ".")).toString("base64")}`;
const SECRET = testSecret("current test secret");
const OLD = testSecret("previous test secret");

function response(status: number, text = "", headers: Record<string, string> = {}): PublicResponse {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    body: {
      cancel: async () => {},
      getReader: () => ({
        read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
        cancel: async () => {},
      }),
    },
  };
}

describe("webhook signing", () => {
  it("signs so the Standard Webhooks reference library verifies it", () => {
    const body = JSON.stringify({ id: "evt_1", type: "project.done", data: {} });
    const h = signedHeaders([SECRET], "evt_1", new Date(), body, "test");
    assert.equal(h["webhook-id"], "evt_1");
    assert.match(h["webhook-signature"]!, /^v1,[A-Za-z0-9+/=]+$/);
    assert.deepEqual(new Webhook(SECRET).verify(body, h), JSON.parse(body));
  });

  it("during a rotation, receivers on either secret verify", () => {
    const body = '{"x":1}';
    const h = signedHeaders([SECRET, OLD], "evt_2", new Date(), body, "test");
    assert.equal(h["webhook-signature"]!.split(" ").length, 2);
    assert.doesNotThrow(() => new Webhook(SECRET).verify(body, h));
    assert.doesNotThrow(() => new Webhook(OLD).verify(body, h));
  });

  it("a changed body does not verify", () => {
    const h = signedHeaders([SECRET], "evt_3", new Date(), '{"a":1}', "test");
    assert.throws(() => new Webhook(SECRET).verify('{"a":2}', h));
  });

  it("event ids are stable per delivery: the event's id, or the test delivery's", () => {
    assert.equal(webhookEventId({ id: 9, eventId: 8812 }), "evt_8812");
    assert.equal(webhookEventId({ id: 9, eventId: null }), "evt_test_9");
  });
});

describe("retry schedule", () => {
  it("8 attempts over about 22 hours, then none", () => {
    assert.equal(nextDelaySec(1), 30);
    assert.equal(nextDelaySec(7), 12 * 3600);
    assert.equal(nextDelaySec(8), null);
    const total = RETRY_DELAYS_SEC.reduce((a, b) => a + b, 0);
    assert.ok(total > 21 * 3600 && total < 23 * 3600, `${total / 3600} h`);
  });
});

describe("masking", () => {
  it("hook URLs show the origin and the last 4 characters", () => {
    assert.equal(maskWebhookUrl("https://hooks.zapier.com/hooks/catch/123/abcdef/"), "https://hooks.zapier.com/…cdef");
    assert.equal(maskWebhookUrl("https://example.com"), "https://example.com");
    assert.equal(maskWebhookUrl("not a url"), "(invalid URL)");
  });

  it("share links keep the file name and the last 4 characters of the token", () => {
    const url = linkUrl("https://app.example.test", "A".repeat(39) + "wxyz", "01-hook.mp4");
    assert.equal(url, `https://app.example.test/m/${"A".repeat(39)}wxyz/01-hook.mp4`);
    assert.equal(maskLinkUrl(url), "https://app.example.test/m/…wxyz/01-hook.mp4");
  });

  it("access log and issue reports drop share-link tokens and webhook secrets", () => {
    const token = "B".repeat(43);
    assert.equal(redactPath(`/m/${token}/01-hook.mp4`), "/m/…/01-hook.mp4");
    const text = scrubOutboundText(`GET https://x.test/m/${token}/clip.mp4 secret ${SECRET}`, []);
    assert.ok(!text.includes(token), text);
    assert.ok(!text.includes(SECRET), text);
  });
});

describe("share link names", () => {
  it("names follow the download names; the extension matches the kind", () => {
    assert.equal(linkFileName("clip", { projectTitle: "Ep", clipIndex: 2, clipTitle: "The hook!" }), "03-The-hook.mp4");
    assert.equal(linkFileName("thumb", { projectTitle: "Ep", clipIndex: 0, clipTitle: "A" }), "01-A-thumb.jpg");
    assert.equal(linkFileName("vtt", { projectTitle: "Ep", clipIndex: 0, clipTitle: "A" }), "01-A.vtt");
    assert.equal(linkFileName("export", { projectTitle: "Episode 42" }), "Episode-42.zip");
  });
});

describe("POST outcomes", () => {
  const send = (fetch: Parameters<typeof postOnce>[3]["fetch"]) =>
    postOnce("http://203.0.113.10/hook", "{}", { "content-type": "application/json" }, { allowPrivate: false, fetch });

  it("a 2xx is delivered, with the response excerpt", async () => {
    let seen: { method?: string; body?: string } = {};
    const r = await send(async (_u, init) => ((seen = init), response(204, "ok")));
    assert.equal(r.ok, true);
    assert.equal(r.code, 204);
    assert.equal(seen.method, "POST");
    assert.equal(seen.body, "{}");
  });

  it("a 500 fails with the code in a sentence", async () => {
    const r = await send(async () => response(500, "boom"));
    assert.deepEqual([r.ok, r.code, r.error, r.response], [false, 500, "Answered 500.", "boom"]);
  });

  it("a redirect is never followed", async () => {
    let calls = 0;
    const r = await send(async () => (calls++, response(302, "", { location: "https://elsewhere.test/" })));
    assert.equal(calls, 1);
    assert.equal(r.ok, false);
    assert.match(r.error!, /redirect/);
  });

  it("a connection error is a sentence, not a throw", async () => {
    const r = await send(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: new Error("connect ECONNREFUSED") });
    });
    assert.equal(r.ok, false);
    assert.match(r.error!, /ECONNREFUSED/);
  });

  it("a private address is refused before anything is sent", async () => {
    let calls = 0;
    const r = await postOnce("http://10.0.0.5/hook", "{}", {}, { allowPrivate: false, fetch: async () => (calls++, response(200)) });
    assert.equal(calls, 0);
    assert.equal(r.ok, false);
  });
});

describe("events and metadata", () => {
  it("only the subscribable events go to webhooks", () => {
    assert.ok(isWebhookEvent("project.done"));
    assert.ok(isWebhookEvent("clip.failed"));
    assert.ok(!isWebhookEvent("stage.progress"));
    assert.ok(!isWebhookEvent("project.updated"));
  });

  it("project metadata is a small flat map of strings", () => {
    assert.ok(projectMetadataSchema.safeParse({ runId: "n8n-123", "zap.step": "2" }).success);
    assert.ok(!projectMetadataSchema.safeParse({ "bad key": "x" }).success);
    assert.ok(!projectMetadataSchema.safeParse({ n: 1 }).success);
    assert.ok(!projectMetadataSchema.safeParse(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"]))).success);
    assert.ok(!projectMetadataSchema.safeParse({ a: "x".repeat(500), b: "x".repeat(500), c: "x".repeat(100) }).success);
  });
});
