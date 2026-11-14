---
"@reelsaw/server": patch
---

A zip export that you cancel, or that drops mid-download, now stops fetching the remaining clips and frees its temporary copies right away, instead of downloading every clip to the server and keeping them until the next day's cleanup. Cancelled exports are logged as cancelled rather than as failures.
