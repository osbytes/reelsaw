/**
 * OTEL endpoint resolution (otel-config.ts): no docker needed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { otlpBase, parseOtlpHeaders, resolveOtlp } from "../src/otel-config.js";

describe("otlpBase", () => {
  it("strips a pasted /v1/traces suffix", () => {
    assert.equal(otlpBase("https://o1.ingest.sentry.io/api/42/integration/otlp/v1/traces"), "https://o1.ingest.sentry.io/api/42/integration/otlp");
  });
});

describe("parseOtlpHeaders", () => {
  it("decodes URL-encoded values", () => {
    assert.deepEqual(parseOtlpHeaders("x-sentry-auth=sentry%20sentry_key%3Dpk"), { "x-sentry-auth": "sentry sentry_key=pk" });
  });
});

describe("resolveOtlp", () => {
  it("defaults to localhost and keeps metrics for a generic collector", () => {
    const r = resolveOtlp({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel-collector:4318" });
    assert.equal(r.sentry, false);
    assert.equal(r.metrics, true);
    assert.equal(r.tracesUrl, "http://otel-collector:4318/v1/traces");
  });

  it("treats a Sentry OTLP base as traces-only and does not read SENTRY_DSN", () => {
    const r = resolveOtlp({
      SENTRY_DSN: "https://pk@o1.ingest.sentry.io/42",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://o1.ingest.sentry.io/api/42/integration/otlp",
      OTEL_EXPORTER_OTLP_HEADERS: "x-sentry-auth=sentry%20sentry_key%3Dpk",
    });
    assert.equal(r.sentry, true);
    assert.equal(r.metrics, false);
    assert.equal(r.tracesUrl, "https://o1.ingest.sentry.io/api/42/integration/otlp/v1/traces");
    assert.equal(r.headers["x-sentry-auth"], "sentry sentry_key=pk");
  });

  it("does not invent a Sentry endpoint from SENTRY_DSN alone", () => {
    const r = resolveOtlp({ SENTRY_DSN: "https://pk@o1.ingest.sentry.io/42" });
    assert.equal(r.endpoint, "http://localhost:4318");
    assert.equal(r.sentry, false);
    assert.deepEqual(r.headers, {});
  });
});
