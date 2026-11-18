---
"@reelsaw/server": minor
---

Failed work under Settings → System → Queue now says why each item failed: a platform fault (disk, model, encoder, timeout) that a Retry fixes after the platform is repaired, a source problem (a dead or private link, no audio, no usable clips) that fails the same way again, or a plan limit. Admins can dismiss failures nobody will retry, one at a time or every match of a filter, and bring them back from Show dismissed. Dismissing only clears the admin list: the owner's project keeps its error and its own Retry. Retry matching now retries platform failures unless you pick another cause. Videos refused for a plan limit in the last 30 days are retried automatically when the owner subscribes, changes plan or has their limits raised. The same actions are available as the `dismiss_failures` MCP tool, a `cause` filter on `list_failures` and `retry_failures`, and the `reelsaw dismiss-failures` and `reelsaw retry-failures --cause` commands.
