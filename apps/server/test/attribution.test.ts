/**
 * Sign-up attribution (@reelsaw/shared attribution.ts): what the app reads from the link the website sent, and what the
 * server accepts back in the sign-up header. Tags, domains, paths and ids only; anything else is dropped.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ATTRIBUTION_HEADER, attributionFromSearch, encodeAttributionHeader, parseAttributionHeader } from "@reelsaw/shared";

describe("attributionFromSearch", () => {
  it("reads the button's UTM tags and the visit's first touch from a website link", () => {
    assert.deepEqual(
      attributionFromSearch("?utm_source=reelsaw.com&utm_medium=website&utm_content=home_hero&site_ref=reddit.com&site_landing=%2Fpricing&site_id=abc&url=x"),
      { utm_source: "reelsaw.com", utm_medium: "website", utm_content: "home_hero", site_ref: "reddit.com", site_landing: "/pricing", site_id: "abc" },
    );
  });
  it("is null for a link with none", () => {
    assert.equal(attributionFromSearch("?url=https%3A%2F%2Fyoutu.be%2Fx"), null);
  });
});

describe("parseAttributionHeader", () => {
  it("round-trips what the form sends", () => {
    const sent = { utm_source: "reelsaw.com", site_ref: "google.com" };
    assert.deepEqual(parseAttributionHeader(encodeAttributionHeader(sent)), sent);
    assert.equal(ATTRIBUTION_HEADER, "x-reelsaw-attribution");
  });
  it("sends any text as a value a header can carry (a raw emoji makes fetch refuse the sign-up)", () => {
    const sent = { utm_campaign: "🚀 launch", site_landing: "/blog/über-clips", utm_term: "短视频".repeat(60) };
    const value = encodeAttributionHeader(sent);
    assert.match(value, /^[ -~]+$/);
    assert.doesNotThrow(() => new Headers({ [ATTRIBUTION_HEADER]: value }));
    assert.deepEqual(parseAttributionHeader(value), sent);
  });
  it("drops what is not the shape, too long or not JSON (it is only a hint)", () => {
    assert.equal(parseAttributionHeader(null), null);
    assert.equal(parseAttributionHeader("not json"), null);
    assert.equal(parseAttributionHeader(JSON.stringify({ utm_source: 5 })), null);
    assert.equal(parseAttributionHeader("x".repeat(20_000)), null);
    assert.equal(parseAttributionHeader("%E0%A4%A"), null);
    assert.deepEqual(parseAttributionHeader(JSON.stringify({ utm_source: "a", email: "someone@example.com" })), { utm_source: "a" });
  });
});
