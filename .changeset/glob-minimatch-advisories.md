---
"@reelsaw/server": patch
---

The server no longer ships the `glob` and `minimatch` versions named in GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249: pnpm overrides move the copies pulled in by OpenTelemetry, Sentry and archiver to glob 14 and minimatch 11.
