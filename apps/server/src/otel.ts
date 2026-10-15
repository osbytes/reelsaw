/**
 * Optional OpenTelemetry bootstrap. This module must be the FIRST import of the entrypoint:
 * the auto-instrumentations patch `http`, `undici` (fetch) and `pg` when those modules load,
 * so the SDK has to start before anything else is imported. Setup is synchronous (CJS requires)
 * to keep that ordering deterministic under ESM.
 *
 * Enable with OTEL_ENABLED=true. Standard OTEL_* env vars configure the exporters:
 *   OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS,
 *   OTEL_RESOURCE_ATTRIBUTES, OTEL_LOG_LEVEL, OTEL_METRICS_ENABLED, OTEL_METRIC_EXPORT_INTERVAL
 */
import { createRequire } from "node:module";
import { trace, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";

const truthy = (v: string | undefined) => v !== undefined && ["1", "true", "yes", "on"].includes(v.toLowerCase());

export interface Otel {
  enabled: boolean;
  shutdown(): Promise<void>;
}

function start(): Otel {
  if (!truthy(process.env.OTEL_ENABLED)) return { enabled: false, shutdown: async () => {} };
  const require = createRequire(import.meta.url);
  const { NodeSDK, metrics } = require("@opentelemetry/sdk-node");
  const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
  const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http");
  const { resourceFromAttributes } = require("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require("@opentelemetry/semantic-conventions");

  const metricsOn = !["0", "false", "no", "off"].includes((process.env.OTEL_METRICS_ENABLED ?? "true").toLowerCase());
  const runWorkers = process.env.RUN_WORKERS === undefined || truthy(process.env.RUN_WORKERS);
  const runHttp = process.env.RUN_HTTP === undefined || truthy(process.env.RUN_HTTP);

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "reelsaw",
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.1.0",
      "reelsaw.role": runHttp && runWorkers ? "app" : runHttp ? "api" : "worker",
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReader: metricsOn
      ? new metrics.PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
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
  process.stdout.write(JSON.stringify({ level: 30, time: new Date().toISOString(), module: "otel", endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318", msg: "opentelemetry enabled" }) + "\n");
  return { enabled: true, shutdown: () => sdk.shutdown() };
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
