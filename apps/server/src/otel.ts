/**
 * Optional OpenTelemetry bootstrap. This module must be the FIRST import of the entrypoint:
 * the auto-instrumentations patch `http`, `undici` (fetch) and `pg` when those modules load,
 * so the SDK has to start before anything else is imported. Setup is synchronous (CJS requires)
 * to keep that ordering deterministic under ESM.
 *
 * Enable with OTEL_ENABLED=true. OTEL_* env vars configure the exporters independently of
 * SENTRY_DSN (error reporting). Point OTEL_EXPORTER_OTLP_ENDPOINT at a collector or at Sentry's
 * OTLP base (`…/integration/otlp`) and set OTEL_EXPORTER_OTLP_HEADERS (for Sentry:
 * `x-sentry-auth=sentry%20sentry_key%3D<public>`). Sentry accepts OTLP traces and logs
 * (`/v1/logs`); when metrics are left on, telemetry.ts sends those through the Sentry SDK
 * instead of `/v1/metrics`. Application logs are pino lines forwarded by log.ts.
 * OTEL_TRACES_SAMPLE_RATE (default 1) is the fraction kept. The browser uses the same rate,
 * and a trace it drops stays dropped here. Resolution helpers live in otel-config.ts.
 */
import { createRequire } from "node:module";
import { trace, SpanKind, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";
import { applyServerSampler, publicFromResolved, resolveOtlp, spanMetricAttributes, type OtelPublic } from "./otel-config.js";
import { setOtelLogsEnabled } from "./otel-log.js";
import { histogram } from "./metrics.js";

export type { OtelPublic } from "./otel-config.js";
export { resolveOtlp } from "./otel-config.js";

const truthy = (v: string | undefined) => v !== undefined && ["1", "true", "yes", "on"].includes(v.toLowerCase());

export interface Otel {
  enabled: boolean;
  /** browser-safe OTLP config for system.status; null when off or headers are not public */
  public: OtelPublic;
  /** Sentry SDK metrics (runtime gauges + metrics.ts). OTLP metrics stay off for that endpoint. */
  sentryMetrics: boolean;
  shutdown(): Promise<void>;
}

function start(): Otel {
  if (!truthy(process.env.OTEL_ENABLED)) return { enabled: false, public: null, sentryMetrics: false, shutdown: async () => {} };
  const cfg = resolveOtlp(process.env);
  const operatorSampler = !!process.env.OTEL_TRACES_SAMPLER?.trim();
  // Before the SDK loads: it reads OTEL_TRACES_SAMPLER when it starts. The browser uses cfg.sampleRate.
  applyServerSampler(process.env, cfg.sampleRate);
  const require = createRequire(import.meta.url);
  const { NodeSDK, metrics, tracing } = require("@opentelemetry/sdk-node");
  const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
  const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
  const { BatchLogRecordProcessor } = require("@opentelemetry/sdk-logs");
  const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http");
  const { resourceFromAttributes } = require("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require("@opentelemetry/semantic-conventions");

  const runWorkers = process.env.RUN_WORKERS === undefined || truthy(process.env.RUN_WORKERS);
  const runHttp = process.env.RUN_HTTP === undefined || truthy(process.env.RUN_HTTP);

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: cfg.serviceName,
      [ATTR_SERVICE_VERSION]: process.env.REELSAW_VERSION ?? process.env.npm_package_version ?? "0.1.0",
      "reelsaw.role": runHttp && runWorkers ? "app" : runHttp ? "api" : "worker",
    }),
    traceExporter: new OTLPTraceExporter({ url: cfg.tracesUrl, headers: cfg.headers }),
    // Explicit processor so the SDK does not also build one from OTEL_LOGS_EXPORTER (that path
    // defaults to protobuf and would send a second copy). Same URL and headers as traces.
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: cfg.logsUrl, headers: cfg.headers }) })],
    metricReader: cfg.metrics
      ? new metrics.PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: cfg.metricsUrl, headers: cfg.headers }),
          exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 30_000),
        })
      : undefined,
    // unless the operator chose a sampler: parent-based at OTEL_TRACES_SAMPLE_RATE, minus orphan client spans
    ...(operatorSampler
      ? {}
      : {
          sampler: new tracing.ParentBasedSampler({
            root: dropOrphanClientSpans(new tracing.TraceIdRatioBasedSampler(cfg.sampleRate), tracing.SamplingDecision.NOT_RECORD),
          }),
        }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
        "@opentelemetry/instrumentation-http": {
          ignoreIncomingRequestHook: (req: { url?: string }) => (req.url ?? "").startsWith("/api/health"),
        },
        "@opentelemetry/instrumentation-pg": { enhancedDatabaseReporting: false },
      }),
    ],
  });
  sdk.start();
  setOtelLogsEnabled(true);
  // runs before the logger exists (it must patch modules first); one JSON line in pino's shape
  let host = cfg.endpoint;
  try {
    host = new URL(cfg.endpoint).host;
  } catch {
    /* keep raw */
  }
  process.stdout.write(
    JSON.stringify({
      level: 30,
      time: new Date().toISOString(),
      module: "otel",
      host,
      traces: true,
      logs: true,
      metrics: cfg.metrics,
      sentryMetrics: cfg.sentryMetrics,
      sentry: cfg.sentry,
      sampleRate: cfg.sampleRate,
      msg: "opentelemetry enabled",
    }) + "\n",
  );
  return { enabled: true, public: publicFromResolved(cfg), sentryMetrics: cfg.sentryMetrics, shutdown: () => sdk.shutdown() };
}

/**
 * A root sampler that drops client spans with no parent: an S3 read, a pg query or a fetch that no request, job or
 * stage span is around (pg-boss polling, a stream read after its handler returned). Alone, each is a one-span trace
 * with nothing to explain it, and together they were most of the trace volume. Everything else goes to `inner`.
 */
export function dropOrphanClientSpans<S extends { shouldSample(...a: unknown[]): unknown }>(inner: S, notRecord: number) {
  return {
    shouldSample(context: unknown, traceId: string, name: string, kind: SpanKind, attributes: Attributes, links: unknown) {
      return kind === SpanKind.CLIENT ? { decision: notRecord } : inner.shouldSample(context, traceId, name, kind, attributes, links);
    },
    toString: () => `DropOrphanClientSpans{${String(inner)}}`,
  };
}

export const otel: Otel = start();
export const tracer = trace.getTracer("reelsaw");

/** Run `fn` inside a span. When OTel is disabled the API's noop tracer makes this free. */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    const t0 = performance.now();
    let ok = true;
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      ok = false;
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      // Recorded while the span is still current so Sentry can attach its trace id. histogram() never throws.
      histogram("reelsaw.span.duration", (performance.now() - t0) / 1000, "s", spanMetricAttributes(name, ok, attributes));
      span.end();
    }
  });
}
