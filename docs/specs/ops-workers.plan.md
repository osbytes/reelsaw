# Ops workers / queue — plan

Companion to [ops-workers.md](ops-workers.md). Check items off as they ship.

## Slice A — Worker registry and System → Workers

Goal: every process that runs (or could run) pipeline work is visible with specs; System Overview
stops lying under a split API/worker deploy.

- [ ] A1 Schema: `worker_instances` (id text PK, role, hostname, started_at, last_seen_at,
      version, commit, pid, cpus, mem_total_mb, gpu jsonb, renders jsonb, queues text[],
      processing jsonb, updated_at). Index on `last_seen_at`. Migration via drizzle-kit.
- [ ] A2 Config: optional `WORKER_ID` (default `hostname:pid`). Document in README / CONFIG.
- [ ] A3 Heartbeat loop in `main.ts` (when `RUN_HTTP` or `RUN_WORKERS`): every 15 s upsert
      snapshot from `resources` + listening queues + in-flight job ids the workers module tracks.
      On graceful stop, delete own row (best-effort).
- [ ] A4 Service `ops/workers.ts`: `listWorkers(svc)` → live vs stale (45 s), sorted by role then
      hostname. Single implementation for tRPC / MCP / CLI.
- [ ] A5 tRPC `admin.workers.list`; MCP `list_workers`; CLI `reelsaw workers` (`--json`).
- [ ] A6 Web: Settings → System section **Workers** (`#workers`); Overview line "N workers
      online" → `#workers` when useful. Poll with `admin.system` interval or dedicated query
      (~5 s). Tokens only; no new card chrome beyond existing System section pattern.
- [ ] A7 Tests: heartbeat upsert; stale classification; adminProcedure refusal for non-admin;
      MCP tool registered in definitions test.

## Slice B — Queue summary and failed work + bulk retry

Goal: see depth / active jobs / failed reasons; retry matching failures after a platform fix.

- [ ] B1 Service `ops/queue.ts`: counts by `name, state` from `pgboss.job`; active rows with
      projectId/clipId/attempt/started; join titles for display (bounded).
- [ ] B2 Service `ops/failures.ts`: list failed projects + clips (keyset, limit 50) with owner
      email, stage, error snippet, `failedAt`; filter `q` (substring), `stage`, `since`.
      `retryFailures(svc, filter, { limit })` calls existing lifecycle helpers; returns
      `{ retried, skipped, nextCursor? }`; writes `admin_events` `failures.retried`.
- [ ] B3 Prefer **per-item admission / fair enqueue** over one giant transaction so a bulk retry
      cannot jump the live-job caps (document in code). Cap 50 per call.
- [ ] B4 tRPC `admin.queue.summary`, `admin.failures.list`, `admin.failures.retry`; MCP
      `get_queue`, `list_failures`, `retry_failures`; CLI `reelsaw queue`,
      `reelsaw retry-failures --stage render --q "disk"`.
- [ ] B5 Web: System section **Queue** (`#queue`) — depth table, active list, failed table with
      Retry and "Retry all matching". Plain-language empty states.
- [ ] B6 Tests: list filters; retry invokes lifecycle (harness); batch cap; non-admin denied;
      admin event written.

## Done when
- Split deploy: API System → Workers lists each worker replica with GPU/CPU/render slots.
- After fixing a platform limit, admin can filter failed work by reason and retry the set from
  the UI, MCP, or CLI without SSH.
- Owner-facing project/clip Retry behaviour unchanged.

## Not in this plan
- Alerts, longer pg-boss retention, concurrency knobs in the UI (see spec "Out of scope").
