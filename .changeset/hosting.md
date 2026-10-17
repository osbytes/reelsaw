---
"@reelsaw/server": minor
---

Running Reelsaw for many people: quotas (`MAX_PROJECTS_PER_USER`, `MAX_SOURCE_MINUTES_PER_DAY`, `MAX_NEW_PROJECTS_PER_HOUR`, per-user overrides on the Users page) with plain-sentence refusals; usage per user (projects, source minutes, clips, model calls and tokens, stored bytes); retention (`SOURCE_RETENTION_DAYS`, `CLIP_RETENTION_DAYS`, "fetch again" on the project); captcha on sign-up/sign-in (`CAPTCHA_PROVIDER`); `YTDLP_PROXY` / `YTDLP_COOKIES_FILE` and plain-words download failures; `TERMS_URL` / `PRIVACY_URL`; MCP over OAuth 2.1 (`MCP_OAUTH=true`) so claude.ai and Claude Desktop connectors sign in with the browser. All off by default.
