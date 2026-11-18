---
"@reelsaw/server": patch
---

Sorting the admin Users list by a column now sorts every matching account on the server. Before, a column header reordered only the rows already loaded, so "Stored, biggest first" showed the biggest of the first 50 accounts, not the biggest overall. Sorting works with search, filters and grouping, and pages with "Load more". The sort is in the page link (`#sort=storedBytes&dir=desc`). Agents and operators get the same order: `list_users` takes `sort` and `dir`, and `reelsaw users` takes `--sort` and `--dir`.
