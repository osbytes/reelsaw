---
"@reelsaw/server": patch
---

Logs say more about why something failed: a slow request carries the event-loop delay, a process killed by a signal logs memory use and whether the container's memory limit killed it, Postgres pool errors carry the pool's connection counts, storage failures carry the project and clip, and a failed ffmpeg run leads with its own reason. New gauges: `reelsaw.event_loop.delay` and `reelsaw.db.pool.connections`.
