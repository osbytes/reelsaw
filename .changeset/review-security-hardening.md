---
"@reelsaw/server": patch
---
API keys now have permissions: admins choose whether a key may change instance settings over MCP, and OAuth connectors never can. Connected apps can be reviewed and revoked in Settings, the consent screen shows where approval returns to, and client registration is rate-limited. New TRUSTED_PROXY_HEADER and TRUSTED_PROXY_HOPS settings stop spoofed client addresses, server-side link fetches can no longer be redirected inside your network, CSV exports neutralise spreadsheet formulas, uploaded SVGs from S3 keep their sandbox, and sign-up no longer reveals whether an email has an account.
