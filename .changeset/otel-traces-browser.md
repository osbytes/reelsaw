---
"@reelsaw/server": patch
---

OpenTelemetry is clearer to wire and works in the browser too: the server exports traces with explicit OTLP URLs/headers (Sentry destinations skip metrics), and when OTEL is on the web app gets the same public endpoint from `system.status` and sends browser traces. `SENTRY_DSN` stays separate from OTEL — set `OTEL_EXPORTER_OTLP_*` yourself.
