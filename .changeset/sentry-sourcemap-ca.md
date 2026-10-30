---
"@reelsaw/server": patch
---

Release images build again with the Sentry source map upload on: the build stage now has CA certificates, so `sentry-cli` can reach Sentry. A failed upload (Sentry unreachable, a bad token) now prints a warning and the release goes on without maps instead of failing.
