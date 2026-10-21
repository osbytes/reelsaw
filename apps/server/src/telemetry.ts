/**
 * Error reporting (Sentry) and product analytics (PostHog), both optional and off unless their keys are set:
 * nothing is initialised, nothing is sent, no code path changes. When OpenTelemetry is aimed at Sentry and
 * metrics are on, this also sends Sentry Application Metrics (Sentry has no OTLP metrics ingest).
 * One service, used from the few places where the facts are known: boot and process-level failures (main.ts), 5xx tRPC errors (http.ts), a job's final
 * failed attempt (queue/workers.ts), committed project events (uow.ts), sign-ups (auth.ts), billing
 * transitions (ee/billing) and abuse flags (abuse.ts). The browser gets the public keys from `system.status`
 * and its own init (apps/web/src/lib/telemetry.ts).
 *
 * Identity: the user id is the distinct id; email and name go to PostHog's person profile (it is the
 * operator's own analytics of their own users), never to Sentry (no PII is attached: user id only). Prompts, transcripts
 * and media never leave through here; event properties are ids, counts and names.
 */
import * as Sentry from "@sentry/node";
import { PostHog } from "posthog-node";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import { spanMetricAttributes } from "./otel-config.js";
import { otel, setSpanMetric } from "./otel.js";

export interface TelemetryPublic {
  sentry: { dsn: string; environment: string; release: string } | null;
  posthog: { key: string; host: string } | null;
}

export interface Telemetry {
  enabled: { sentry: boolean; posthog: boolean };
  /** what the browser needs: public values only */
  public: TelemetryPublic;
  /** an error a person must look at (also logged by the caller); tags are ids and names, never bodies */
  captureException(err: unknown, tags?: Record<string, string | number | boolean | null | undefined>): void;
  /** a product event for one account */
  capture(event: string, distinctId: string, properties?: Record<string, unknown>): void;
  identify(distinctId: string, properties: Record<string, unknown>): void;
  /** flush what is queued (shutdown) */
  shutdown(): Promise<void>;
}

/** Sentry's own collector interval, unless OTEL_METRIC_EXPORT_INTERVAL is a sane number. Below 1s the SDK clamps and warns. */
function metricIntervalMs(): number {
  const n = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 30_000);
  return Number.isFinite(n) && n >= 1000 ? n : 30_000;
}

export function createTelemetry(config: Pick<Config, "SENTRY_DSN" | "SENTRY_ENVIRONMENT" | "POSTHOG_KEY" | "POSTHOG_HOST" | "REELSAW_VERSION" | "NODE_ENV">, log: Logger): Telemetry {
  const release = `reelsaw@${config.REELSAW_VERSION}`;
  const environment = config.SENTRY_ENVIRONMENT ?? (config.NODE_ENV === "production" ? "production" : "development");
  const sentry = !!config.SENTRY_DSN;
  // Sentry has no OTLP metrics endpoint. With the exporter pointed at Sentry and metrics left on,
  // runtime gauges and span durations go through the DSN. Tracing stays on the OTLP exporter.
  const sentryMetrics = sentry && otel.sentryMetrics;
  if (otel.sentryMetrics && !sentry) log.warn("Sentry OTLP does not accept metrics, and SENTRY_DSN is unset, so metrics are not exported");
  if (sentry) {
    Sentry.init({
      dsn: config.SENTRY_DSN,
      environment,
      release,
      // OpenTelemetry owns spans. Leave Sentry's tracer off so the same request is not sent twice.
      tracesSampleRate: 0,
      enableOpenTelemetrySetup: false,
      integrations: (defaults) => [
        ...defaults,
        // Logs go out as OTLP (log.ts), not through pinoIntegration, so a line is not sent twice.
        ...(otel.enabled ? [Sentry.openTelemetryIntegration()] : []),
        ...(sentryMetrics ? [Sentry.nodeRuntimeMetricsIntegration({ collectionIntervalMs: metricIntervalMs() })] : []),
      ],
    });
  }
  if (sentryMetrics) {
    setSpanMetric(({ name, durationMs, ok, attributes }) => {
      Sentry.metrics.distribution("reelsaw.span.duration", durationMs, {
        unit: "millisecond",
        attributes: spanMetricAttributes(name, ok, attributes),
      });
    });
  } else {
    setSpanMetric(null);
  }
  const posthog = config.POSTHOG_KEY ? new PostHog(config.POSTHOG_KEY, { host: config.POSTHOG_HOST, flushAt: 20, flushInterval: 10_000 }) : null;
  if (posthog) posthog.on("error", (err: unknown) => log.warn({ err }, "posthog send failed"));
  if (sentry || posthog) log.info({ sentry, posthog: !!posthog, environment, release, sentryMetrics }, "telemetry on");
  return {
    enabled: { sentry, posthog: !!posthog },
    public: {
      sentry: sentry ? { dsn: config.SENTRY_DSN!, environment, release } : null,
      posthog: posthog ? { key: config.POSTHOG_KEY!, host: config.POSTHOG_HOST } : null,
    },
    captureException(err, tags) {
      if (!sentry) return;
      const clean = Object.fromEntries(Object.entries(tags ?? {}).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
      Sentry.captureException(err, { tags: clean });
    },
    capture(event, distinctId, properties) {
      posthog?.capture({ distinctId, event, properties: { ...properties, $lib_custom: "reelsaw-server", release } });
    },
    identify(distinctId, properties) {
      posthog?.identify({ distinctId, properties });
    },
    async shutdown() {
      setSpanMetric(null);
      await posthog?.shutdown().catch(() => {});
      if (sentry) await Sentry.close(2000).catch(() => {});
    },
  };
}
