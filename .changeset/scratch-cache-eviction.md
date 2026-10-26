---
"@reelsaw/server": patch
---

With an S3 store, a worker's local copies of sources and rendered clips are now treated as the cache they are. The hourly sweep evicts the copies of finished projects idle longer than `SCRATCH_CACHE_HOURS` (24; a runtime setting under Settings → System → Retention), `reelsaw storage` reports them, and `reelsaw storage reclaim <MB>` frees a given amount least-recently-used first. A job short of disk no longer fails at once: it evicts first, then, if another live worker has the room, hands the job to it and stops taking media jobs on this worker until free disk is back above `MIN_FREE_DISK_MB` plus 1 GB (Settings → System → Workers shows "disk full"); only when no worker has the room does the run fail. The speech-to-text cache is pruned hourly as well as at boot.
