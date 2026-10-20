---
"@reelsaw/server": patch
---

Ingest fails immediately when the worker disk cannot hold `MIN_FREE_DISK_MB` plus the source (instead of waiting 900 s and retrying). Uploads reserve their actual size, and the UI says Preparing rather than Downloading.
