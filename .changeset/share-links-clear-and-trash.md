---
"@reelsaw/server": patch
---

Settings → Share links no longer grows without end. The list scrolls inside its card, and a new Clear button deletes revoked and expired links (also `clear_media_links` in MCP and `reelsaw media-links clear <email>`). Before, those links stayed listed for `MEDIA_LINK_RETENTION_DAYS` after they stopped working. Links of a deleted project or clip now show as "In trash" instead of "Active". They have not worked since the delete, and restoring the project brings them back. You can still revoke them so a restore keeps them off. Other Settings lists that grow with use (a webhook's deliveries, API keys) now scroll at the same height.
