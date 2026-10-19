---
"@reelsaw/server": patch
---

The image entrypoint now `chown`s a volume-mounted `DATA_DIR` (e.g. Railway) before dropping to `node`, so boot no longer fails with `EACCES` on `/data/uploads`.
