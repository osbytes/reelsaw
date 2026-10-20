/**
 * Optional OpenTelemetry bootstrap. This module must be the FIRST import of the entrypoint:
 * the auto-instrumentations patch `http`, `undici` (fetch) and `pg` when those modules load,
 * so the SDK has to start before anything else is imported. Setup is synchronous (CJS requires)
 * to keep that ordering deterministic under ESM.
 *
 * Enable with OTEL_ENABLED=true. OTEL_* env vars configure the exporters independently of
 * SENTRY_DSN (error reporting). Point OTEL_EXPORTER_OTLP_ENDPOINT at a collector or at Sentry's
 * OTLP base (`…/integration/otlp`) and set OTEL_EXPORTER_OTLP_HEADERS (for Sentry:
 * `x-sentry-auth=sentry%20sentry_key%3D<public>`). Sentry destinations export traces only.
 * Resolution helpers live in otel-config.ts.
 */
import { createRequire } from "node:module";
import { trace, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";
import { publicFromResolved, resolveOtlp, type OtelPublic } from "./otel-config.js";

export type { OtelPublic } from "./otel-config.js";
export { resolveOtlp } from "./otel-config.js";

const truthy = (v: string | undefined) => v !== undefined && ["1", "true", "yes", "on"].includes(v.toLowerCase());

export interface Otel {
  enabled: boolean;
  /** browser-safe OTLP config for system.status; null when off or headers are not public */
  public: OtelPublic;
  shutdown(): Promise<void>;
}

function start(): Otel {
  if (!truthy(process.env.OTEL_ENABLED)) return { enabled: false, public: null, shutdown: async () => {} };
  const cfg = resolveOtlp(process.env);
  const require = createRequire(import.meta.url);
  const { NodeSDK, metrics } = require("@opentelemetry/sdk-node");
  const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
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
    metricReader: cfg.metrics
      ? new metrics.PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: cfg.metricsUrl, headers: cfg.headers }),
          exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 30_000),
        })
      : undefined,
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
      metrics: cfg.metrics,
      sentry: cfg.sentry,
      msg: "opentelemetry enabled",
    }) + "\n",
  );
  return { enabled: true, public: publicFromResolved(cfg), shutdown: () => sdk.shutdown() };
}

export const otel: Otel = start();
export const tracer = trace.getTracer("reelsaw");

/** Run `fn` inside a span. When OTel is disabled the API's noop tracer makes this free. */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
