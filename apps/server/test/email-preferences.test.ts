/**
 * The ready email's one-click unsubscribe (notify/preferences.ts): the link is signed per account
 * and topic, and the note carries the RFC 8058 headers and a visible link.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { unsubscribeHeaders, unsubscribeToken, unsubscribeUrl, verifyUnsubscribeToken } from "../src/notify/preferences.js";
import { templates } from "../src/email.js";

const SECRET = "test-secret-at-least-sixteen";

describe("unsubscribe link", () => {
  it("verifies its own token and nobody else's", () => {
    const t = unsubscribeToken(SECRET, "u1", "ready");
    assert.equal(verifyUnsubscribeToken(SECRET, "u1", "ready", t), true);
    assert.equal(verifyUnsubscribeToken(SECRET, "u2", "ready", t), false);
    assert.equal(verifyUnsubscribeToken("another-secret-of-16+", "u1", "ready", t), false);
    assert.equal(verifyUnsubscribeToken(SECRET, "u1", "ready", ""), false);
    assert.equal(verifyUnsubscribeToken(SECRET, "u1", "ready", t.slice(0, -1)), false);
  });

  it("builds the URL under APP_URL with the account, topic and token", () => {
    const url = new URL(unsubscribeUrl("https://app.example.com/", SECRET, "u1", "ready"));
    assert.equal(url.origin + url.pathname, "https://app.example.com/api/email/unsubscribe");
    assert.equal(url.searchParams.get("u"), "u1");
    assert.equal(url.searchParams.get("topic"), "ready");
    assert.equal(verifyUnsubscribeToken(SECRET, "u1", "ready", url.searchParams.get("t")!), true);
  });

  it("gives the one-click header pair", () => {
    assert.deepEqual(unsubscribeHeaders("https://x.test/u?a=1"), {
      "List-Unsubscribe": "<https://x.test/u?a=1>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("puts the headers and a visible link on the ready note, and nothing without a URL", () => {
    const base = {
      greeting: null,
      projects: [{ id: "p1", title: "Talk", clips: 3, failed: 0, rerender: false, highlights: [], more: 0 }],
      hidden: 0,
      milestone: null,
    };
    const url = "https://app.example.com/api/email/unsubscribe?u=u1&topic=ready&t=abc";
    const mail = templates.clipsReady("https://app.example.com", { ...base, unsubscribeUrl: url });
    assert.equal(mail.headers?.["List-Unsubscribe"], `<${url}>`);
    assert.match(mail.text, /Stop these emails: https:\/\/app\.example\.com\/api\/email\/unsubscribe/);
    assert.match(mail.html, /Stop these emails/);
    assert.match(mail.html, /href="https:\/\/app\.example\.com\/settings#email"/);
    const plain = templates.clipsReady("https://app.example.com", base);
    assert.equal("headers" in plain, false);
    assert.doesNotMatch(plain.text, /Stop these emails/);
  });
});
