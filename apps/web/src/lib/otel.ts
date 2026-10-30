/**
 * Browser OpenTelemetry: OTLP/HTTP traces (and metrics when the collector supports them).
 * Config is embedded in the page (or GET /api/otel in Vite dev) and applied in bootOtel before
 * the first API call. system.status.otel still calls initOtel, which no-ops once boot has run.
 * Loaded on demand so instances without OTEL never pull the SDK chunk. The Sentry SDK does not
 * trace: that would send a second copy. OTEL_TRACES_SAMPLE_RATE is the sample rate.
 */
type Public = {
  endpoint: string;
  headers: Record<string, string>;
  metrics: boolean;
  serviceName: string;
  /** 0–1. Missing on an older server means record every trace. */
  sampleRate?: number;
};

let started: Promise<void> | null = null;

export function initOtel(t: Public | null | undefined): Promise<void> {
  if (started || !t?.endpoint) return started ?? Promise.resolve();
  const cfg = t;
  started = (async () => {
    const [
      { WebTracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler },
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
    const rate = typeof cfg.sampleRate === "number" && Number.isFinite(cfg.sampleRate) ? Math.min(1, Math.max(0, cfg.sampleRate)) : 1;
    const provider = new WebTracerProvider({
      resource,
      // Same ratio as the server. Parent-based, so a dropped parent stays dropped.
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(rate) }),
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${base}/v1/traces`, headers: cfg.headers }))],
    });
    provider.register({ contextManager: new ZoneContextManager() });

    // Same-origin only: API calls carry traceparent, the collector export does not.
    // ignoreUrls keeps the export request from becoming another span (that loop never ends).
    const origin = new RegExp(`^${window.location.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    const ignoreUrls = [new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))];
    registerInstrumentations({
      instrumentations: [
        getWebAutoInstrumentations({
          // every click was a 0 ms root span with nothing under it: most of the trace volume, none of the insight
          "@opentelemetry/instrumentation-user-interaction": { enabled: false },
          "@opentelemetry/instrumentation-fetch": {
            propagateTraceHeaderCorsUrls: [origin],
            ignoreUrls,
            clearTimingResources: true,
          },
          "@opentelemetry/instrumentation-xml-http-request": {
            propagateTraceHeaderCorsUrls: [origin],
            ignoreUrls,
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

function asPublic(value: unknown): Public | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Public;
  if (typeof v.endpoint !== "string" || !v.endpoint) return null;
  return v;
}

/**
 * Config embedded in the page by the server. `undefined` means the page has no island
 * (Vite dev), so the caller fetches `/api/otel`. `null` means tracing is off.
 */
export function readOtelBoot(): Public | null | undefined {
  const el = document.getElementById("reelsaw-otel");
  if (!el) return undefined;
  try {
    return asPublic(JSON.parse(el.textContent || "null"));
  } catch {
    return null;
  }
}

/** Start the browser SDK before the app's first request. No-op when tracing is off. */
export async function bootOtel(): Promise<void> {
  let cfg = readOtelBoot();
  if (cfg === undefined) {
    try {
      const res = await fetch("/api/otel", { signal: AbortSignal.timeout(2000) });
      cfg = res.ok ? asPublic(await res.json()) : null;
    } catch {
      cfg = null;
    }
  }
  if (cfg) await initOtel(cfg);
}
