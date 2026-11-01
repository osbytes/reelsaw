# Ops: workers, queue and failed work

## Job
When I run Reelsaw with more than one process (an API box plus worker replicas, or
`docker compose --profile workers --scale worker=N`), I want Settings → System to show each
worker instance with its specs and what it is processing, and a place to see why work failed and
retry it after a platform limit was fixed (disk full, model down, encoder missing, outage), so
that I can operate the box without SSH and without guessing which container holds the GPU.

Today the System tab samples **this process only**. With `RUN_WORKERS=false` on the API and
separate workers, the gauges, GPU line and render concurrency describe the API box, not the
machines doing the work. Failed reasons live on projects and clips (and briefly in
`pgboss.job.output`); retry already exists per project and per clip for the owner, but an admin
has no fleet view and no "retry everything that failed for reason X" path.

## Appetite
One shippable slice that lands the registry + System sections + MCP/CLI mirrors, then a second
slice for failure grouping and bulk retry. No new queue product; extend what pg-boss and the
pipeline already do.

## Non-goals
- A general-purpose job dashboard that reimplements pg-boss (no cancel-by-id UI, no priority
  editor, no DLQ product).
- Auto-scaling or placement (k8s / compose stay outside the app).
- Per-tenant worker pools or affinity (fair priority already spreads by `userId`).
- Replacing the project/clip Retry buttons owners already use.
- Changing pg-boss retry limits or heartbeat as part of this work.

## Must-be
- Admins only; hosted non-admins never see instance-wide queue, worker specs or other accounts'
  failures (same rule as issue-report `system` and `admin.system`).
- One service behind tRPC, MCP and CLI (PRINCIPLES surfaces rule).
- Retry goes through existing lifecycle (`projects.retry` / `requestRender` / `requestPrepare` /
  `startRun`), never a raw `boss.send` that skips versioned gens or events.
- Lists bounded and labelled ("Showing 50 of …"); no silent caps.
- Plain-language reasons and actions ("Disk was full; Retry resumes from render"), raw detail one
  click away.
- Self-hosted single-process installs keep working with zero new settings: one row for "this box"
  appears automatically.

---

## What exists today (research)

### Workers and roles
| Fact | Where |
|---|---|
| One image, roles via `RUN_HTTP` / `RUN_WORKERS` | `config.ts`, `services.ts` (`role`: `app` \| `api` \| `worker` \| `cli`) |
| Compose profile `workers` + `--scale worker=N` | `docker-compose.yml` |
| Hosted plan: API with `RUN_WORKERS=false`, 2–4 worker replicas | `docs/specs/hosted.md` Part D |
| pg-boss `instanceName` is only `"reelsaw-worker"` or `"reelsaw-api"` | `queue/boss.ts` — **not unique per replica** |
| Heartbeat 15 s; jobs reassigned on crash | `queue/boss.ts` `HEARTBEAT_SECONDS` |
| Resource snapshot + GPU detect + render slots are **in-process** | `resources.ts`; wired into `admin.system` |
| No `worker_instances` / presence table | schema has nothing for fleet membership |

### Queue and failures
| Fact | Where |
|---|---|
| Eight stage queues, exclusive + singletonKey, fair priority | `queue/boss.ts` |
| Backstop expiry per job: analyze/refine = clamp(1800 s, 1800 s + project duration x factor, 24 h), factor 4 when the language model is self-hosted at enqueue time, else 1; other queues use the queue default. Disk leases live as long as the longest possible job (24 h) | `expireInSecondsFor`, `MAX_JOB_EXPIRE_SECONDS`, `queue/boss.ts`; `DISK_LEASE_TTL_MS` |
| Time budget of Finding moments: per model call (`LLM_CALL_TIMEOUT_SECONDS`) and idle (`STAGE_IDLE_TIMEOUT_MINUTES`), parts saved in `job_steps`; an attempt that saved a part gets one more retry; `NonRetryableError` fails at once | `pipeline/steps.ts`, `StageContext.step`, `queue/workers.ts` |
| Failed project: `projects.status=failed`, `projects.error`, event `project.failed` | `pipeline/common.ts` `failProject` |
| Mid-retry: event `stage.failed` with attempt/max | `stageFailedAttempt` |
| Failed clip: `clips.status=failed`, diagnostics, `clip.failed` | `pipeline/render.ts` |
| pg-boss keeps `output` (error / "job heartbeat timeout"); deleted after **3 days** | `deleteAfterSeconds: 3 * 24 * 3600` |
| Issue reports already dump queue counts + recent `state='failed'` rows (admin/self-host) | `report/system.ts` `queueInfo` |
| Reconciler re-enqueues missing live jobs; does **not** un-fail terminal projects | `queue/reconcile.ts`; CLI `recover` says so |

### Retry surfaces already shipped
| Surface | Behaviour |
|---|---|
| UI project banner / palette | `projects.retry` — resume from furthest completed stage |
| UI / batch bar | Retry failed clips → `clips.rerenderMany` / `requestRender` |
| MCP | `retry_project`, `rerender_clip`, `rerender_clips` |
| CLI | `status`, `stuck`, `recover`, `rerender` |
| Admin System UI | Overview gauges + Processing times for **this** process only (`Settings.tsx` → `admin.system`) |

**Gap:** no admin list of workers; no aggregate "failed work" view; no bulk retry by error
signature after a platform fix; System Overview is wrong under split API/worker deploy.

### Why not "just read pg-boss"?
pg-boss is the right source for **job state** (created / active / retry / failed counts, active
payloads, last `output`). It is the wrong source for **worker identity and specs**: every worker
shares `instanceName: "reelsaw-worker"`, there is no first-class hardware inventory, and failed
rows age out in three days while `projects.error` / clip status remain the durable operator
truth. Competitors in this shape (n8n, Bull Board–style UIs, Temporal Web) separate **workers**
(presence + capacity) from **workflows/jobs** (history + retry). Mirror that split.

---

## Decisions (hardest to reverse first)

1. **Heartbeat registry in Postgres, written by every process that can run work (and optionally
   the API for visibility).** Table roughly `worker_instances (id, role, hostname, started_at,
   last_seen_at, version, commit, pid, cpus, mem_total_mb, disk_free_mb, disk_total_mb, gpu jsonb, render jsonb, queues
   text[], processing jsonb)`. Each process upserts every ~10–15 s (aligned with job heartbeat)
   with a stable `id` = `hostname:pid` or `WORKER_ID` env when set (compose/k8s can pin it).
   Stale = `last_seen_at` older than ~45 s. No Redis; the database is already the coordination
   plane. **Rejected:** scrape Docker/k8s from the app (infra stays in `reelsaw-infra`);
   **rejected:** overload pg-boss `instanceName` alone (no specs, collision under scale).

2. **Durable failure list comes from app state, not from `pgboss.job`.** Admin "Failed work"
   queries `projects` / `clips` with `status = 'failed'`, shows `error` / diagnostics / last
   `project.failed` or `clip.failed` payload. Live queue depth and "what is running now" still
   come from `pgboss.job` (`state in ('created','retry','active')`) plus the registry's
   `processing` snapshot. Recent pg-boss failures stay available as raw detail (same as issue
   reports) but are not the primary list.

3. **Bulk retry is a thin admin wrapper over existing lifecycle.** Filter by failed stage, error
   substring / normalised signature, owner, and time window; for each match call the same paths
   as `projects.retry` or clip re-render (service function, ownership skipped only because the
   caller is `adminProcedure`). Cap batch size (e.g. 50) with an explicit "and N more". Write
   one `admin_events` row (`failures.retried`) with counts and filter. **Rejected:** re-queue
   by poking `pgboss.job` state; **rejected:** auto-retry on settings change (operator chooses).

4. **UI lives under Settings → System**, two new sections in the existing side nav: **Workers**
   (`#workers`) and **Queue** (`#queue`). Workers: instance cards/rows with specs, role, last
   seen, current jobs. Queue: depth by stage, active jobs, failed work table with Retry / Retry
   matching. Fits "one composition for System" and deep links; does not invent a second Admin
   app. Overview keeps this-process gauges but adds a one-line "N workers online" that links to
   `#workers` when the registry has more than one row (or any worker role).

5. **Surfaces ship together.** Service module (e.g. `ops/workers.ts`, `ops/failures.ts`) →
   `admin.workers.list`, `admin.queue.summary`, `admin.failures.list`, `admin.failures.get`,
   `admin.failures.retry` → MCP `list_workers`, `get_queue`, `list_failures`, `get_failure`,
   `retry_failures` → CLI `reelsaw workers`, `reelsaw queue`, `reelsaw failure`, `reelsaw retry-failures`.

---

## UI sketch (plain language)

**Workers**
- One row per live instance: hostname (or `WORKER_ID`), role (app / api / worker), version,
  CPUs, memory, disk (free of total), GPU note, render slots `running/max`, last seen.
- Expand: queues this process listens on, current job ids / project titles (from `processing`).
- Gone instances drop after stale timeout; no manual "remove".

**Queue**
- Counts: waiting / active / retrying per stage (from pg-boss).
- Active: project, stage, attempt, worker id, started.
- Failed work: project or clip, owner (email), stage, short reason, when. The item and reason
  open a dialog with the full recorded error, Retry, Copy reason, and Open project (secondary).
  Row Retry stays on the list. With a filter applied: "Retry matching (N)". Hash
  `#queue&fail=kind:id` deep-links the dialog. MCP `get_failure` / CLI `reelsaw failure` return
  the same item.

---

## Risks
- **Registry write load:** one upsert per process per 15 s is trivial; index `last_seen_at`.
- **Stale "processing" on crash:** job heartbeat already reassigns work; UI may show a ghost for
  up to the stale window — label "last reported" and prefer live `pgboss.job` for active lists.
- **Bulk retry storms:** respect existing fair priority and per-user live-job caps; process the
  batch serially in one admin transaction **or** enqueue with normal admission (prefer admission
  so one admin click cannot starve the fleet — document the choice in the plan).
- **Error signature quality:** start with `lower(left(error, 120))` / stage; refine later if
  noise (provider URLs, ids) needs normalisation.

## Out of scope follow-ups
- Partition / longer retention of `pgboss.job` history.
- Alerting (email/webhook when a worker goes stale or failed count spikes).
- Per-queue concurrency controls in the UI (today: env + `resources.renderSlot`).
