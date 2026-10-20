/**
 * Browser OpenTelemetry: OTLP/HTTP traces (and metrics when the collector supports them).
 * Config comes from `system.status.otel` (server derives Sentry ingest from SENTRY_DSN when set).
 * Loaded on demand so instances without OTEL never pull the SDK chunk.
 */
type Public = {
  endpoint: string;
  headers: Record<string, string>;
  metrics: boolean;
  serviceName: string;
};

let started: Promise<void> | null = null;

export function initOtel(t: Public | null | undefined): Promise<void> {
  if (started || !t?.endpoint) return started ?? Promise.resolve();
  const cfg = t;
  started = (async () => {
    const [
      { WebTracerProvider, BatchSpanProcessor },
      { OTLPTraceExporter },
      { resourceFromAttributes },
      { ATTR_SERVICE_NAME },
      { registerInstrumentations },
      { getWebAutoInstrumentations },
      { ZoneContextManager },
    ] = await Promise.all([
      import("@opentelemetry/sdk-trace-web"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/resources"),
      import("@opentelemetry/semantic-conventions"),
      import("@opentelemetry/instrumentation"),
      import("@opentelemetry/auto-instrumentations-web"),
      import("@opentelemetry/context-zone"),
    ]);

    const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: cfg.serviceName });
    const base = cfg.endpoint.replace(/\/$/, "");
    const provider = new WebTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${base}/v1/traces`, headers: cfg.headers }))],
    });
    provider.register({ contextManager: new ZoneContextManager() });

    registerInstrumentations({
      instrumentations: [
        getWebAutoInstrumentations({
          "@opentelemetry/instrumentation-fetch": {
            propagateTraceHeaderCorsUrls: [/.*/],
            clearTimingResources: true,
          },
          "@opentelemetry/instrumentation-xml-http-request": {
            propagateTraceHeaderCorsUrls: [/.*/],
          },
        }),
      ],
    });

    if (cfg.metrics) {
      const [{ MeterProvider, PeriodicExportingMetricReader }, { OTLPMetricExporter }, { metrics }] = await Promise.all([
        import("@opentelemetry/sdk-metrics"),
        import("@opentelemetry/exporter-metrics-otlp-http"),
        import("@opentelemetry/api"),
      ]);
      metrics.setGlobalMeterProvider(
        new MeterProvider({
          resource,
          readers: [
            new PeriodicExportingMetricReader({
              exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics`, headers: cfg.headers }),
              exportIntervalMillis: 30_000,
            }),
          ],
        }),
      );
    }
  })().catch((err) => console.warn("otel init failed", err));
  return started;
}
