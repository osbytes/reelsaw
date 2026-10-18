---
"@reelsaw/server": minor
---

MCP over stdio: `reelsaw mcp` serves the same tools as `/api/mcp` to clients that launch a command instead of calling a URL with a header (Claude Desktop without OAuth, Cursor's stdio entries, registry checks). It forwards every call to a running instance (`REELSAW_URL`, default the app in the same container, with `REELSAW_API_KEY`), so it needs no database or models. Settings → API keys and MCP shows the `docker exec` config next to the HTTP ones.
