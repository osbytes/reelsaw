---
"@reelsaw/server": patch
---

Security fixes. Hono 4.13.18 and @hono/node-server 2.1.7 close advisories in CSRF checks, form validation, mounted-route middleware, router wildcards and backslash paths, and a crash on a reset WebSocket upgrade. The Docker image now takes Debian's security updates for apt, Cyrus SASL and SRT, and release builds refresh the OS packages every week instead of reusing an old cached layer.
