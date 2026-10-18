---
"@reelsaw/server": minor
---

Admins are told when a newer Reelsaw is published: Settings → System shows the release with its notes link and the one command to upgrade, and the account menu marks Settings with the waiting version (a dot on the account button) until it is done. Settings itself moved from the top bar into the account menu. `reelsaw version` prints the same from the shell and the `check_for_update` MCP tool returns it to agents. The app asks GitHub's releases API every 6 hours, sending nothing but the request; `UPDATE_CHECK=false` turns it off.
