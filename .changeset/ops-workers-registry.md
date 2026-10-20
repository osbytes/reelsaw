---
"@reelsaw/server": minor
---

Show each API and worker process under Settings → System → Workers, and a Queue section for live job depth, failed work, and bulk retry after a platform fix. A failed-work row opens the recorded reason (Retry, Copy, Open project); `#queue&fail=kind:id` deep-links it. Admins get the same from `list_workers` / `get_queue` / `list_failures` / `get_failure` / `retry_failures` and `reelsaw workers` / `reelsaw queue` / `reelsaw failure` / `reelsaw retry-failures`.
