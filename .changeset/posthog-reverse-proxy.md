---
"@reelsaw/server": minor
---

`POSTHOG_PROXY=true` sends the web app's PostHog events through the app's own origin at `/api/relay`, which the server forwards to `POSTHOG_HOST`, so ad blockers that block posthog.com do not drop them. Cookies and authorization headers are not forwarded; the client address is, when `TRUST_PROXY` is on. Off by default.
