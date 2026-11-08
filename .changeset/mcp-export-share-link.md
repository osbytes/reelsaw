---
"@reelsaw/server": patch
---

Agents signed in through a connector (claude.ai, Claude Desktop) can download their clips: MCP `export_project` returns a share link for the zip that needs no sign-in, since the keyed `export.zip` link only opens with an API key (`share: false` still asks for it, `share: true` gives API-key callers a share link too). The server instructions now send agents to `get_media_links` or `export_project` for downloads and explain that a 403 comes from the client sandbox's network allowlist, not Reelsaw.
