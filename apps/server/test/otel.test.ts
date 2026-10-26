/**
 * OTEL endpoint resolution (otel-config.ts): no docker needed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { otlpBase, parseOtlpHeaders, resolveOtlp, otelLogFromLine, spanMetricAttributes, traceSampleRate, applyServerSampler, publicFromResolved, injectOtelBoot } from "../src/otel-config.js";
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

  it("records every trace unless OTEL_TRACES_SAMPLE_RATE says otherwise", () => {
    assert.equal(traceSampleRate({}), 1);
    assert.equal(traceSampleRate({ OTEL_TRACES_SAMPLE_RATE: "0.25" }), 0.25);
    assert.equal(traceSampleRate({ OTEL_TRACES_SAMPLE_RATE: "2" }), 1);
    assert.equal(traceSampleRate({ OTEL_TRACES_SAMPLE_RATE: "-1" }), 0);
    assert.equal(traceSampleRate({ OTEL_TRACES_SAMPLE_RATE: "nope" }), 1);
    const r = resolveOtlp({ OTEL_TRACES_SAMPLE_RATE: "0.1" });
    assert.equal(r.sampleRate, 0.1);
    assert.equal(publicFromResolved(r)?.sampleRate, 0.1);
  });

  it("sets a parent-based ratio unless the operator already chose a sampler", () => {
    const env: NodeJS.ProcessEnv = {};
    applyServerSampler(env, 0.2);
    assert.equal(env.OTEL_TRACES_SAMPLER, "parentbased_traceidratio");
    assert.equal(env.OTEL_TRACES_SAMPLER_ARG, "0.2");
    const chosen: NodeJS.ProcessEnv = { OTEL_TRACES_SAMPLER: "always_off" };
    applyServerSampler(chosen, 1);
    assert.equal(chosen.OTEL_TRACES_SAMPLER, "always_off");
    assert.equal(chosen.OTEL_TRACES_SAMPLER_ARG, undefined);
  });

  it("embeds the browser config in the page and escapes a closing script", () => {
    const html = injectOtelBoot("<head></head>", {
      endpoint: "https://example.test/otlp",
      headers: {},
      metrics: false,
      serviceName: "reelsaw-web",
      sampleRate: 1,
    });
    assert.match(html, /id="reelsaw-otel"/);
    assert.match(html, /"sampleRate":1/);
    const nasty = injectOtelBoot("<head></head>", {
      endpoint: "https://example.test/</script>",
      headers: {},
      metrics: false,
      serviceName: "reelsaw-web",
      sampleRate: 0,
    });
    const inner = nasty.match(/id="reelsaw-otel">([\s\S]*?)<\/script>/)?.[1] ?? "";
    assert.equal(inner.includes("<"), false);
    assert.match(inner, /\\u003c\/script>/);
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
  it("keeps bounded string and boolean attributes; drops ids, numbers and the rest", () => {
    assert.deepEqual(
      spanMetricAttributes("pipeline.render", false, {
        "reelsaw.project_id": "p1",
        "reelsaw.clip_id": "c1",
        jobId: "j1",
        "reelsaw.attempt": 2,
        "process.args_count": 40,
        "process.command": "x".repeat(250),
        cached: true,
        skipped: ["a"],
        empty: undefined,
      }),
      {
        span: "pipeline.render",
        status: "error",
        "process.command": "x".repeat(200),
        cached: true,
      },
    );
  });
});
