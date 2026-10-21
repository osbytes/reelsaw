/**
 * OTEL endpoint resolution (otel-config.ts): no docker needed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { otlpBase, parseOtlpHeaders, resolveOtlp, otelLogFromLine, spanMetricAttributes } from "../src/otel-config.js";
import { scrubOutboundText } from "../src/report/redact.js";

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
    assert.equal(r.sentryMetrics, false);
    assert.equal(r.metrics, true);
    assert.equal(r.tracesUrl, "http://otel-collector:4318/v1/traces");
    assert.equal(r.logsUrl, "http://otel-collector:4318/v1/logs");
  });

  it("keeps a Sentry OTLP base traces-only and routes metrics through the Sentry SDK", () => {
    const r = resolveOtlp({
      SENTRY_DSN: "https://pk@o1.ingest.sentry.io/42",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://o1.ingest.sentry.io/api/42/integration/otlp",
      OTEL_EXPORTER_OTLP_HEADERS: "x-sentry-auth=sentry%20sentry_key%3Dpk",
    });
    assert.equal(r.sentry, true);
    assert.equal(r.metrics, false);
    assert.equal(r.sentryMetrics, true);
    assert.equal(r.tracesUrl, "https://o1.ingest.sentry.io/api/42/integration/otlp/v1/traces");
    assert.equal(r.logsUrl, "https://o1.ingest.sentry.io/api/42/integration/otlp/v1/logs");
    assert.equal(r.headers["x-sentry-auth"], "sentry sentry_key=pk");
  });

  it("does not send Sentry SDK metrics when OTEL_METRICS_ENABLED is off", () => {
    const r = resolveOtlp({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://o1.ingest.sentry.io/api/42/integration/otlp",
      OTEL_METRICS_ENABLED: "false",
    });
    assert.equal(r.metrics, false);
    assert.equal(r.sentryMetrics, false);
  });

  it("does not invent a Sentry endpoint from SENTRY_DSN alone", () => {
    const r = resolveOtlp({ SENTRY_DSN: "https://pk@o1.ingest.sentry.io/42" });
    assert.equal(r.endpoint, "http://localhost:4318");
    assert.equal(r.sentry, false);
    assert.equal(r.sentryMetrics, false);
    assert.deepEqual(r.headers, {});
  });
});

describe("otelLogFromLine", () => {
  const scrub = (text: string) => scrubOutboundText(text, ["hunter2-secret"]);

  it("keeps the message and ids, drops local-only bodies, and scrubs values that are not under a secret key", () => {
    const rec = otelLogFromLine(
      JSON.stringify({
        level: 30,
        msg: "llm call",
        module: "llm",
        projectId: "p1",
        model: "m",
        prompt: [{ role: "user", content: "secret words" }],
        response: "the answer",
        ip: "203.0.113.4",
        to: "ada@b.co",
        note: "see hunter2-secret",
        password: "[redacted]",
        usage: { input: 3 },
      }),
      scrub,
    );
    assert.equal(rec?.body, "llm call");
    assert.equal(rec?.severityText, "INFO");
    assert.equal(rec?.attributes.module, "llm");
    assert.equal(rec?.attributes.projectId, "p1");
    assert.equal(rec?.attributes.model, "m");
    assert.equal(rec?.attributes["usage.input"], 3);
    assert.equal(rec?.attributes.password, "[redacted]");
    assert.equal(rec?.attributes.to, "[redacted email]");
    assert.equal(rec?.attributes.note, "see [redacted]");
    assert.equal(rec?.attributes.prompt, undefined);
    assert.equal(rec?.attributes.response, undefined);
    assert.equal(rec?.attributes.ip, undefined);
  });

  it("reads a serialised error and skips a line with no message", () => {
    const rec = otelLogFromLine(JSON.stringify({ level: 50, msg: "render failed", module: "render", err: { type: "Error", message: "disk full" } }), scrub);
    assert.equal(rec?.severityText, "ERROR");
    assert.equal(rec?.attributes["err.message"], "disk full");
    assert.equal(rec?.attributes["err.type"], "Error");
    assert.equal(otelLogFromLine(JSON.stringify({ level: 30, only: "fields" })), null);
  });
});

describe("spanMetricAttributes", () => {
  it("keeps scalar attributes and drops the rest", () => {
    assert.deepEqual(
      spanMetricAttributes("pipeline.render", false, {
        "reelsaw.project_id": "p1",
        "reelsaw.attempt": 2,
        "process.command": "x".repeat(250),
        skipped: ["a"],
        empty: undefined,
      }),
      {
        span: "pipeline.render",
        status: "error",
        "reelsaw.project_id": "p1",
        "reelsaw.attempt": 2,
        "process.command": "x".repeat(200),
      },
    );
  });
});
