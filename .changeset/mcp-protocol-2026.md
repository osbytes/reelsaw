---
"@reelsaw/server": minor
---

The MCP server now speaks the 2026-07-28 protocol as well as the 2025 revisions. Agents and clients on the new protocol were refused with "Unsupported protocol version"; they now connect to `/api/mcp` and to `reelsaw mcp` (stdio) like older clients do.
