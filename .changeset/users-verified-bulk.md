---
"@reelsaw/server": patch
---

The Users page shows whether each account's email address is verified and filters by status and verification (kept in the link). Rows can be selected, or every matching account at once, to approve, suspend, reinstate or delete them together; refusals (yourself, the last admin) are listed with the reason. The waiting-for-approval count covers every account, not only the loaded page, and the list reads from a new index on its sort order. New MCP tools `list_users` and `manage_users`, and `reelsaw users` (now paged, with filters) and `reelsaw users-bulk` on the CLI.
