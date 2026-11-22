# Resource leases — plan

Companion to [resource-leases.md](resource-leases.md). Check items off as they ship.

## Slice 1 — CPU pool in one process

Goal: every thread budget in this process comes from one pool that sees every other claim.

- [x] 1.1 `resources.ts`: pure `cpuGrant({ capacity, leased, min, max })`; governor `cpuLease({ kind, min, max })`
      returns `{ cores, release }` and records the grant synchronously; `cpuLeased()` for status.
- [x] 1.2 Renders lease a fixed share (`min = max = cpus / renders running`, today's size) for the encode;
      `ffmpegThreads()` is gone.
- [x] 1.3 Shot-cut scans (analyze, per-clip in render, `reelsaw scenes`) lease `{ min: 1, max: 4 }`, or
      `SCENE_SCAN_THREADS` pinned, and release when the decode ends.
- [x] 1.4 Tests: grant arithmetic, two scans side by side, a scan beside a render, release returns the cores.

## Slice 2 — Shared ledger: CPU, memory, disk across processes

- [x] 2.1 Migrations: `resource_leases` (`mb`, `cores`, `mem_mb`, `user_id`) created, then `disk_leases` dropped
      (two steps so drizzle-kit never has to ask about a rename; leases live minutes, nothing to copy).
      `worker_instances` gains `cores_leased`, `mem_leased_mb`.
- [x] 2.2 One claim underneath (`claimOnLive` + `createLeaser`, an `admit` rule and a CPU ask per request):
      `acquire` (a stage's disk), `withCpu` (an ffmpeg pass) and `renderSlot` (a render's memory and its place
      among the host's renders, `renderRefusal`) are its three shapes. A render encode's share counts the host's
      renders, not this process's.
- [x] 2.3 `media.ffmpeg` requires `threads` (a lease's grant or "light") and places `-threads` before every input
      and the output (`threadedArgv`); a caller's own `-threads` is refused. Leased: render encode, bumper
      normalise, stitched windows, still-picture video, dev scenarios. Light: thumbnails, posters, loudness, audio
      extraction and segmenting.
- [x] 2.3b Frame samplers that spawn ffmpeg themselves take `decodeThreadArgs`: text, faces and speaker
      sampling lease `SAMPLE_CPU` (1 to 2); single frames and audio-only passes (overlay frames, clip PCM, cut
      previews, audio cuts) take 1. `media.ffmpeg` also caps the filtergraph pools on every pass.
- [x] 2.5 Cores and memory keyed by machine (`machineId`, the boot id), disk by volume; leaked rows dropped on
      the heartbeat; a CPU claim falls back to this process when the ledger is unreachable; a render encode's
      share is the pool (cores less one) divided by the machine's renders, rounded up.
- [x] 2.4 Leased cores / MB per worker in the heartbeat; Settings → System → Workers, `list_workers`,
      `reelsaw workers`.

Caveat for a rolling upgrade: processes on the old version write `disk_leases`, the new ones `resource_leases`,
so for the minutes both run they do not see each other's disk claims. A single-host compose restart has no overlap.

## Slice 3 — Plan ceilings (EE)

- [ ] 3.1 `Grants.resources { maxCores, maxMemMB }` per plan; admin per-user override.
- [ ] 3.2 Account ceiling checked in the lease step; elastic work shrinks, fixed work requeues with backoff.
- [ ] 3.3 `FREE_RESERVE_CORES` EE setting.
- [ ] 3.4 Tests: Free burst leaves the reserve; paid job not behind a Free job waiting on its ceiling.

## Done when
- No ffmpeg pass that decodes or encodes a video runs without a lease.
- Two processes on one host cannot together lease more than the host's capacity, beyond the minimums a pass is always granted.
