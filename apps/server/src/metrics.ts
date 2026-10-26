/**
 * Application metrics, one call site per fact, two sinks:
 *
 *   - OpenTelemetry (`@opentelemetry/api`): the global meter. A no-op until otel.ts starts the SDK with
 *     a metric reader (OTEL_ENABLED and an OTLP collector), so recording is free when metrics are off.
 *   - Sentry Application Metrics: registered by telemetry.ts when the exporter points at Sentry (which
 *     has no OTLP metrics ingest). Gauges are polled on the same interval as the OTLP reader.
 *
 * Attributes are bounded sets only (stage, queue, proxy id, model, outcome). Never a project, clip,
 * job or user id: every distinct value is a new time series. Durations are seconds (OTel semconv),
 * so "seconds of work per second of video" ratios read directly.
 *
 * Catalogue (README "Metrics" lists the same):
 *   reelsaw.pipeline.stage.duration        s    stage, outcome[, encoder]
 *   reelsaw.pipeline.media.duration        s    stage           (source length; clip length for prepare/render)
 *   reelsaw.pipeline.realtime_factor       1    stage[, encoder] (wall seconds per media second, ok jobs only)
 *   reelsaw.ytdlp.attempt.duration         s    proxy, outcome  (one yt-dlp process through one candidate)
 *   reelsaw.ytdlp.attempts                 {attempt} proxy, outcome
 *   reelsaw.ytdlp.download.duration        s    proxy, outcome, fallback (whole pool walk, waits included)
 *   reelsaw.ytdlp.download.realtime_factor 1    proxy           (download seconds per second of video)
 *   reelsaw.ytdlp.download.throughput      By/s proxy
 *   reelsaw.ytdlp.proxy.circuit.changes    {change} proxy, state
 *   reelsaw.ytdlp.proxy.healthy            1    proxy           (gauge: circuit closed or half-open)
 *   reelsaw.ytdlp.proxy.in_flight          {download} proxy  (gauge)
 *   reelsaw.ytdlp.proxy.success_rate       1    proxy           (gauge: last PROXY_RESULT_WINDOW results)
 *   reelsaw.render.slots                   {render} state      (gauge: running, limit)
 *   reelsaw.worker.jobs.active             {job} queue         (gauge: this process)
 *   gen_ai.client.operation.duration       s    gen_ai.request.model, reelsaw.stage, reelsaw.call, outcome
 *   gen_ai.client.token.usage              {token} gen_ai.request.model, gen_ai.token.type, reelsaw.stage, reelsaw.call
 *   reelsaw.llm.cost                       USD  gen_ai.request.model, reelsaw.stage
 *   reelsaw.stt.duration                   s    provider, model, outcome
 *   reelsaw.stt.audio.duration             s    provider, model
 *   reelsaw.stt.realtime_factor            1    provider, model
 *   reelsaw.span.duration                  s    span, status    (every withSpan: stages, ffmpeg/yt-dlp exec)
 * pg-boss adds its own `messaging.*` and `pgboss.queue.jobs` instruments to the OTLP meter.
 */
import { metrics as otelMetrics, type Attributes, type Counter, type Histogram, type ObservableResult } from "@opentelemetry/api";

export type MetricAttributes = Record<string, string | number | boolean>;
export type GaugeReading = [value: number, attributes: MetricAttributes];

/** Sentry Application Metrics (telemetry.ts). Units arrive in OTel's UCUM spelling. */
export interface MetricSink {
  count(name: string, value: number, unit: string, attributes: MetricAttributes): void;
  distribution(name: string, value: number, unit: string, attributes: MetricAttributes): void;
  gauge(name: string, value: number, unit: string, attributes: MetricAttributes): void;
}

interface GaugeDef {
  name: string;
  unit: string;
  read: () => GaugeReading[];
}

/**
 * Histogram buckets. The SDK default tops out at 10 000, which in seconds is fine, but its low end is
 * built for milliseconds; ratios need resolution around 0.05–5.
 */
const SECONDS_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200];
const RATIO_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10, 20];

const meter = () => otelMetrics.getMeter("reelsaw");
const histograms = new Map<string, Histogram>();
const counters = new Map<string, Counter>();
const gauges: GaugeDef[] = [];
let sink: MetricSink | null = null;

/** Registered by telemetry.ts once Sentry is initialised; null detaches it. */
export function setMetricSink(next: MetricSink | null): void {
  sink = next;
}

/** Every registered gauge's current readings, for a sink that is pushed to rather than pulled from (Sentry). */
export function readGauges(): Array<{ name: string; unit: string; readings: GaugeReading[] }> {
  return gauges.map((g) => ({ name: g.name, unit: g.unit, readings: safeRead(g) }));
}

function safeRead(g: GaugeDef): GaugeReading[] {
  try {
    return g.read();
  } catch {
    return [];
  }
}

function buckets(unit: string): number[] | undefined {
  if (unit === "s") return SECONDS_BUCKETS;
  if (unit === "1") return RATIO_BUCKETS;
  return undefined;
}

/** Record one value. Never throws: a metric must not change the result of the work it measures. */
export function histogram(name: string, value: number, unit: string, attributes: MetricAttributes = {}, description?: string): void {
  if (!Number.isFinite(value)) return;
  try {
    let h = histograms.get(name);
    if (!h) {
      const b = buckets(unit);
      h = meter().createHistogram(name, { unit, ...(description ? { description } : {}), ...(b ? { advice: { explicitBucketBoundaries: b } } : {}) });
      histograms.set(name, h);
    }
    h.record(value, attributes as Attributes);
    sink?.distribution(name, value, unit, attributes);
  } catch {
    /* never fail the caller */
  }
}

export function count(name: string, value = 1, unit = "1", attributes: MetricAttributes = {}, description?: string): void {
  if (!Number.isFinite(value) || value < 0) return;
  try {
    let c = counters.get(name);
    if (!c) {
      c = meter().createCounter(name, { unit, ...(description ? { description } : {}) });
      counters.set(name, c);
    }
    c.add(value, attributes as Attributes);
    sink?.count(name, value, unit, attributes);
  } catch {
    /* never fail the caller */
  }
}

/**
 * A gauge read on every export (OTLP observable gauge, Sentry interval). `read` must be cheap and
 * synchronous: it runs on the exporter's timer, not in a request.
 */
export function gauge(name: string, unit: string, read: () => GaugeReading[], description?: string): void {
  if (gauges.some((g) => g.name === name)) return;
  const def: GaugeDef = { name, unit, read };
  gauges.push(def);
  try {
    meter()
      .createObservableGauge(name, { unit, ...(description ? { description } : {}) })
      .addCallback((result: ObservableResult) => {
        for (const [v, a] of safeRead(def)) if (Number.isFinite(v)) result.observe(v, a as Attributes);
      });
  } catch {
    /* never fail boot */
  }
}

/** Seconds of work per second of media; null when the media length is unknown or zero. */
export function realtimeFactor(wallSec: number, mediaSec: number | null | undefined): number | null {
  if (!mediaSec || !Number.isFinite(mediaSec) || mediaSec <= 0 || !Number.isFinite(wallSec) || wallSec < 0) return null;
  return wallSec / mediaSec;
}

/** Test hook: forget instruments and gauges so a test starts clean. */
export function resetMetricsForTest(): void {
  histograms.clear();
  counters.clear();
  gauges.length = 0;
  sink = null;
}
