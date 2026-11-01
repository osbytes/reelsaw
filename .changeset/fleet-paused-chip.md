---
"@reelsaw/server": patch
---

The "Jobs paused" chip now reflects the workers that run jobs, read from their heartbeats, instead of the machine that served the page: on a split deploy (an API box plus worker boxes) it no longer shows paused because the API box is busy, nor misses a worker that is short of disk. The app checks it every 30 seconds instead of every 10. New metric `reelsaw.quota.minutes_precheck_skipped` counts links downloaded under a minutes limit before their length was known.
