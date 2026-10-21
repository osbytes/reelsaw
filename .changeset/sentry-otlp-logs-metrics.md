---
"@reelsaw/server": minor
---

When OpenTelemetry points at Sentry, traces and logs go to Sentry's OTLP endpoint, and metrics go through the Sentry SDK. Sentry does not accept OTLP metrics. Logs are the same pino lines as the local log, with prompts, transcripts and secret values left out. The browser records traces on the same rate (`OTEL_TRACES_SAMPLE_RATE`, default all of them) and its API calls, including live subscriptions, stay on the server's trace.

**Upgrade:** With `OTEL_ENABLED=true`, a Sentry OTLP endpoint and `SENTRY_DSN` set, the server starts sending logs and, unless `OTEL_METRICS_ENABLED=false`, runtime gauges and span durations. The browser starts sending traces too. Set `OTEL_METRICS_ENABLED=false` to keep traces and logs only, or `OTEL_TRACES_SAMPLE_RATE` below 1 to keep fewer traces.
