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
    // ignoreUrls keeps the export request from becoming another span (that loop never ends), and drops every other
    // host (PostHog, Sentry, a CDN): a span for a third party's endpoint is volume with nothing of ours under it.
    const here = escapeRegExp(window.location.origin);
    const origin = new RegExp(`^${here}`);
    const ignoreUrls = [new RegExp(escapeRegExp(base)), new RegExp(`^(?!${here}(?:/|$))[a-z][a-z0-9+.-]*://`, "i")];
    const name = (span: { updateName(n: string): unknown }, method: string | undefined, url: string | undefined) => {
      const n = apiSpanName(method, url, window.location.origin);
      if (n) span.updateName(n);
    };
    registerInstrumentations({
      instrumentations: [
        getWebAutoInstrumentations({
          // every click was a 0 ms root span with nothing under it: most of the trace volume, none of the insight
          "@opentelemetry/instrumentation-user-interaction": { enabled: false },
          // spans start as a bare "GET"; name them for the call ("GET /api/trpc/projects.get") so Sentry groups them.
          // The URL comes from the span, not the result: a stream that ends by abort or a dropped connection (the live
          // project events) hands this hook an error with no URL, and those spans stayed "GET".
          "@opentelemetry/instrumentation-fetch": {
            propagateTraceHeaderCorsUrls: [origin],
            ignoreUrls,
            clearTimingResources: true,
            applyCustomAttributesOnSpan: (span, request, result) =>
              name(span, request.method, spanUrl(span) ?? (result instanceof Response ? result.url : undefined)),
          },
          "@opentelemetry/instrumentation-xml-http-request": {
            propagateTraceHeaderCorsUrls: [origin],
            ignoreUrls,
            applyCustomAttributesOnSpan: (span, xhr) => name(span, undefined, xhr.responseURL),
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

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The request URL the fetch instrumentation put on its span when it started (`url.full`), if the span exposes it. */
function spanUrl(span: object): string | undefined {
  const attrs: unknown = Reflect.get(span, "attributes");
  const url = attrs && typeof attrs === "object" ? Reflect.get(attrs, "url.full") : undefined;
  return typeof url === "string" ? url : undefined;
}

const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24,}|\d+)$/i;
/**
 * A same-origin request's span name: method and path, ids replaced by `:id` and the query dropped (tRPC batches put
 * their input there), so one endpoint is one row in Sentry. Null for another host or an unreadable URL.
 */
export function apiSpanName(method: string | undefined, url: string | undefined, origin: string): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url, origin);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null;
  const path = u.pathname
    .split("/")
    .map((seg) => (ID_SEGMENT.test(seg) ? ":id" : seg))
    .join("/");
  return `${(method ?? "GET").toUpperCase()} ${path}`;
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
