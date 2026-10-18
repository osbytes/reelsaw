---
"@reelsaw/server": minor
---

Admins can change instance settings without a restart: sign-up mode, email verification, captcha, legal links, per-account quotas, upload limits, retention, the stall watchdog, the update check and whether /api/health shows machine numbers. The environment stays the default; what an admin saves under Settings → System, with `reelsaw settings` or the `set_instance_settings` MCP tool overrides it for every process within seconds, is validated as a whole and audited. The Settings page is split into Account and System tabs, and project cards keep one height whatever the title length.
