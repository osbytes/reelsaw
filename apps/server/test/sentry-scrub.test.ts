/** Error events leave without the person's address or the request's headers, cookies and body (docs/CONFIG.md). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ErrorEvent } from "@sentry/node";
import { SENTRY_DATA_COLLECTION, scrubSentryEvent } from "../src/telemetry.js";

describe("Sentry event scrub", () => {
  it("keeps the user id and the route, drops the address, headers, cookies, body and query", () => {
    const event = {
      type: undefined,
      user: { id: "u1", ip_address: "203.0.113.7", email: "a@example.com", geo: { country_code: "US" } },
      request: { method: "POST", url: "https://app.example/api/upload", headers: { cookie: "s=1" }, cookies: { s: "1" }, data: "{}", query_string: "k=v" },
    } as ErrorEvent;
    const out = scrubSentryEvent(event);
    assert.deepEqual(out.user, { id: "u1" });
    assert.deepEqual(out.request, { method: "POST", url: "https://app.example/api/upload" });
  });

  it("asks the SDK to collect nothing about the person or the request itself", () => {
    assert.equal(SENTRY_DATA_COLLECTION.userInfo, false);
    assert.equal(SENTRY_DATA_COLLECTION.cookies, false);
    assert.equal(SENTRY_DATA_COLLECTION.httpHeaders, false);
    assert.deepEqual(SENTRY_DATA_COLLECTION.httpBodies, []);
  });
});
