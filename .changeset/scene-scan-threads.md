---
"@reelsaw/server": patch
---

The shot-cut scan decodes with up to 4 threads instead of one, about 3x faster on CPU-only hosts with the same cuts. Cores, memory and disk are now leased from one shared ledger per host (`resource_leases`): every video ffmpeg pass takes its threads from a lease, render encodes share the host's cores across every worker process on it, and a render leases its memory, so parallel scans, renders and worker replicas no longer over-commit the machine. Settings → System → Workers, `list_workers` and `reelsaw workers` show the leased cores and memory. `SCENE_SCAN_THREADS` pins the scan's thread count.
