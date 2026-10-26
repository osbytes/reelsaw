---
"@reelsaw/server": minor
---

With `OTEL_ENABLED=true` (or Sentry Application Metrics), the server now exports metrics for the pipeline, yt-dlp proxies and model calls, and not only span durations. Each stage, link download and transcription is measured in seconds of work per second of video, so a 30-second clip and a 2-hour talk can be compared. Proxy pools report attempts by proxy and outcome, circuit changes, health, in-flight downloads and download speed. Language model calls report latency, tokens and cost by model and pipeline step. Render slots and active jobs are reported as gauges. Span-duration metrics no longer carry project, clip or attempt attributes, which had made one series per project. The README lists every metric.
