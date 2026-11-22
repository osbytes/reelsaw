# Resource leases: CPU, memory and disk

## Job
When a job is about to use the machine (decode a source, render a clip, write scratch), I want it to
claim the CPU, memory and disk it needs in one step against what other jobs already hold, so that
parallel jobs never over-commit the box, a long scan does not starve renders (or the other way
round), and on the hosted service a burst of Free work cannot take the capacity paying accounts
need.

Today only disk works this way. CPU and memory are admitted on a measured sample (`MAX_CPU_PERCENT`,
`MIN_FREE_MEM_MB`) that reserves nothing: two jobs pass on the same reading, and ffmpeg's real use
only shows once it runs. Thread counts are guesses made in isolation: renders split the cores by the
number of renders running, the shot-cut scan subtracts renders it assumes take two cores each and
does not see other scans, and most other ffmpeg passes (ingest, audio extraction) set no `-threads`
at all, so ffmpeg takes every core. Processes on one host (the app and the worker replicas) each
think they own the whole machine.

## Appetite
Three slices, each shippable on its own: a CPU pool inside one process, the shared ledger across
processes (adding memory, and every heavy ffmpeg pass on it), then plan ceilings for the hosted
service.

## Non-goals
- cgroups, `nice`, container CPU limits or any OS-level enforcement. A lease is the app's own
  accounting; ffmpeg is told how many threads to use and is trusted to keep to it.
- Placement or auto-scaling across hosts (compose / k8s stay outside the app).
- Replacing pg-boss concurrency (`localConcurrency`, `oneAtATime`, fair-share priority). Leases size
  and admit the work a queue already handed this process; they do not pick which job runs next.
- Per-account ceilings on a self-hosted instance. Without EE there are no plans, so no tier limit.

## Must-be
- **One primitive.** CPU, memory and disk are claimed by one call that checks and records in the same
  step. No job reads "what is free" and acts on it later.
- **Leases see each other** in this process from slice 1, and across processes on one host from
  slice 2 (the same ledger, advisory lock, heartbeat and expiry as `disk_leases` today).
- **Correctness never depends on it.** Decoder threading is lossless and an encode's output does not
  depend on its thread count; a lease only changes speed and contention.
- **No priority inversion.** A job never sits in a worker slot waiting for its own account's ceiling
  while a paying account's job queues behind it (see Decisions 4).
- **Self-host is unchanged in kind.** Without EE the only limit is the host's capacity.
- **Visible.** Leased cores, memory and disk show per worker in Settings → System → Workers,
  `list_workers` and `reelsaw workers` / `reelsaw status` (slice 2).

## What exists today (research)
- `resources.ts` `acquire()`: measured CPU %, free memory and disk; disk is leased (`takeLease`,
  `leaseHandle`) against `disk_leases` through `disk-leases.ts` (advisory lock per volume, heartbeat
  staleness `LEASE_STALE_MS`, TTL `DISK_LEASE_TTL_MS`, own rows dropped at boot).
- `renderSlot()`: admits renders by count (`renderLimit`: ~`CPUS_PER_RENDER` cores and
  `RENDER_MEM_MB` each, or a pinned `RENDER_CONCURRENCY`). `ffmpegThreads()`: an encode takes
  `cpus / renders running`.
- Shot-cut scan (`media.detectScenes`): decoder threads from `SCENE_SCAN_THREADS` (0 = auto).
- Plans (`ee/billing/plans.ts`) already grant per-account numbers through `Grants`
  (`queuePriority`, `sourceHeight`, limits); `Entitlements` is null without EE.

## Decisions (hardest to reverse first)

1. **A lease is `{ min, max }` per resource, granted `clamp(capacity − leased, min, max)`.** `min` is
   the job's guarantee and what admission checks; `max` is how far it may burst into what is free
   right now. A grant never grows or shrinks after it is taken (ffmpeg's `-threads` is fixed at
   spawn). Fixed-size work asks `min = max`. So a lone scan on an idle 6-core box gets 4 decoder
   threads, a second scan beside it gets what the first left (1), and neither waits.
2. **Disk is shared per volume, cores and memory per machine, on one ledger.** The volume id (the
   `.volume-id` marker on DATA_DIR) names who shares disk: every process mounting it, which on k8s or NFS can
   span machines. The machine id (the kernel's boot id, the same in every container of one machine) names who
   shares cores and memory. Keying CPU by volume would pool the cores of different machines on a network
   volume. Each row carries both; a claim locks the volume then the machine, and sums disk by the one and
   cores, memory and render slots by the other. Slice 2 replaces `disk_leases` with `resource_leases`
   (`volume`, `machine`, `mb`, `cores`, `mem_mb`, `user_id`); the heartbeat, TTL and sweep carry over.
   A request carries an `admit` rule (why it does not fit what is out, or null) and a CPU ask, both
   evaluated against the live totals inside the locked transaction (`claimOnLive`), so every resource is
   checked and recorded by the same code.
3. **CPU capacity is the cores less one** (the Node process, Postgres in the single-box setup, the
   OS). **Memory capacity is total less `MIN_FREE_MEM_MB` less leases**, and the measured free memory
   stays a second guard, because a lease is an estimate (`RENDER_MEM_MB`), not a measurement.
   **Disk** is as today: measured free less leases.
4. **A ceiling never makes a job wait in its worker slot.** Elastic work (a scan) is granted fewer
   cores, down to its `min`. Fixed-size work that does not fit goes back to the queue with backoff
   (a retryable "waiting for capacity" outcome) instead of looping in `acquire`, so pg-boss's
   fair-share priority picks the next job and a paying account's job is not stuck behind a Free one.
   Host-capacity waits (everyone is short) keep today's bounded wait (`RESOURCE_WAIT_MAX_SECONDS`).
5. **Plan ceilings are a `Grants` field, EE only.** `resources: { maxCores, maxMemMB }` beside
   `queuePriority` and `sourceHeight`: the most one account may hold at once across all its leases,
   checked against that account's ledger rows in the same step. An admin's per-user override
   replaces it, like `queuePriority`. No EE, no grants, no account ceiling. Under a ceiling every
   CPU pass is elastic (down to one thread: thread count never changes the output); the fixed-size
   work that requeues is the render slot (its memory, and its place once the account's cores are
   all held). An account holding nothing may always start one render.
6. **A paid reserve on hosted.** Free accounts' leases may not take the last `FREE_RESERVE_CORES`
   cores (and, later, a matching memory reserve) of a host, so a burst of Free work leaves room for paid
   jobs. An EE setting; absent, 0. Shipped: a Free pass is granted only what is above the reserve (one
   thread at least), a Free render goes back to the queue while the machine's leased cores reach into it.
7. **Every heavy ffmpeg pass is leased.** Slice 2 makes the ffmpeg helper take the lease's grant and
   turn it into `-threads`, so a pass cannot skip the budget (the type is the guard). Light probes
   (`ffprobe`, single-frame grabs) stay unleased.

## Starting numbers (to be tuned from hosted measurements)
| | Free | Starter | Creator | Pro |
| --- | --- | --- | --- | --- |
| `maxCores` | 2 | 4 | 6 | 8 |
| `maxMemMB` | 2400 | 4800 | 7200 | 9600 |

`FREE_RESERVE_CORES` = 2 on hosted.

## Why a database for CPU and memory
Cores and memory belong to a machine, so a single worker process could lease them in memory. The ledger is there
for several processes on one machine (the app and `--scale worker=N` replicas): each sees every core, and only
a shared record stops each from starting a full set of renders or granting every core to its own scans. It also
lends idle capacity: a busy replica gets the cores an idle one is not using, which a fixed per-process split
cannot. The costs are a transaction before and after each leased pass and releases that can fail; both are
handled (Risks).

## Prior art
- Kubernetes requests and limits (a guaranteed minimum and a burst ceiling per container, accounted per node):
  the `{ min, max }` shape. ResourceQuota per namespace is the model for slice 3's per-account ceilings.
- The GNU Make jobserver (also Ninja and Cargo): a token pool shared by the processes of one machine.
- Ray and Dask: tasks ask for `{ CPU: n }`, each node tracks what is free.
- YARN's capacity and fair schedulers: a guaranteed share and a maximum per queue, idle capacity lent out
  (the paid reserve and borrowing).
- Distributed semaphores with expiring leases (Redisson's PermitExpirableSemaphore, etcd and Kubernetes
  Lease objects): what the ledger is, including its known weak spot, a release that never lands.

## Risks
- **Early grants do not shrink.** A lone render takes every core; a scan that starts a moment later
  gets 1 thread for its whole run. Acceptable: the OS still shares, and the alternative (re-spawning
  ffmpeg with new threads) costs more than it saves.
- **Estimates drift.** `RENDER_MEM_MB` and `CPUS_PER_RENDER` are averages; a 4K source uses more. The
  measured guard catches the worst case; the numbers are named constants so evals and hosted metrics
  can move them.
- **A lost process holds its claims** until its heartbeat is stale (`LEASE_STALE_MS`), as disk does today.
- **A release that fails** (a database blip at the delete) would count for the lease's 24 h TTL. The heartbeat
  drops this worker's rows that no live lease points at (`dropLeakedLeases`, after a 60 s grace for claims
  still being registered), so it costs one beat.
- **The ledger unreachable at a claim.** A CPU-only claim never waits, so it falls back to this process's own
  leases and the pass runs; a claim with an admit rule (a stage's disk, a render slot) fails and the job retries.

## Out of scope follow-ups
- GPU (NVENC sessions) as a leased resource.
- Showing an account its own share ("your jobs are using 2 of your 4 cores") on the Billing page.
