# Scale audit

## Job
When Reelsaw holds a lot (one power user with 1,000 projects, or a hosted instance with 100 users,
50,000 clips and years of events), I want every screen, background loop and API to cost what it
shows rather than what the account has ever stored, so that size never turns into slowness,
silently missing data or an out-of-memory worker.

Audited on 2026-10-17 at `origin/main` (543fcc7). Evidence is `file:line`; numbers marked
"bench" were read from the bench database (8 projects, 29 clips, 4 users, 1,183 events), the rest
is arithmetic from those. Nothing here was load-tested: Phase 1 starts by seeding
(`apps/server/scripts/seed-scale.ts`) and measuring.

## Where it stands today
- Every list is a bare `findMany` with a magic `limit` that truncates silently, or no limit.
- Search is "send everything, Fuse in the browser" (`searchIndex`).
- Every non-progress event of a running project re-downloads the whole project, transcript
  included, and the project list re-downloads every 3 s while anything runs.
- No table that grows with time is ever pruned (`project_events`, `llm_usage`, `admin_events`,
  `stage_artifacts`, jsonb arrays inside rows).
- Background loops are "all rows in state X" (cheap today only because few projects are
  active) and two walk the whole data directory.
- Per-tenant limits (quota, rate) live in the database already; concurrency and the Postgres
  pool are per process.

## Measured (bench database)
| What | Value | Extrapolation |
|---|---|---|
| Words per transcript | 3,924 words for a 20 min source: 278 KB `words` + 278 KB `raw_words` (about 70 B/word, 3.3 words/s) | 1 h: 0.8 MB + 0.8 MB; 3 h: **2.5 MB + 2.5 MB** per row, plus segments (36 KB / 20 min, 330 KB / 3 h) |
| `projects.get` payload | words + rawWords + segments + flags + clips: about 0.6 MB for the biggest bench project | 3 h source: **about 5.5 MB per call** |
| `transcripts` table | 1.8 MB for 8 rows | 1,000 projects at 1 h: **about 1.6 GB** of TOASTed jsonb, rewritten whole on every flag edit |
| `project_events` | 1,183 rows, 856 (72%) are `stage.progress`; 148 per project on average (max 470); about 1 KB/row incl. index | 100 users x 30 projects/month x 1,500 events (3 h source, 50 clips) = 4.5 M rows, **about 3 GB per month**, never pruned |
| `clips.diagnostics` | max 2.4 KB | fine; but nothing bounds it (retries append) |
| `flags` / `deleted_flags` | 36 flags = 8.5 KB; 0 deleted | `deleted_flags` capped at 500 (about 120 KB) |
| `searchIndex` row | about 0.8 KB per clip (title, hook, caption, two URLs, project title) | 5,000 clips = **4 MB** and it stops there; 50 k clips would be 40 MB |
| `projects.list` row | about 1.5 KB (full settings 378 B, thumbs, bumper summary) | 200 projects = 300 KB, **polled every 3 s** while any project is active |
| `pgboss.job` | 157 rows, no index on `data->>'projectId'` | sequential scan per active project per reconcile tick |

## Findings
Severity: H = wrong or failing at the target scale, M = slow or wasteful, L = latent.

| # | Area | Where | Bound today | Growth | Failure mode | Sev |
|---|---|---|---|---|---|---|
| 1 | Event-driven refetch | `web/pages/Project.tsx:74-90`, `trpc/router.ts:703-713` | none | every non-progress event refetches `projects.get` (full transcript, 5.5 MB at 3 h) plus `projects.list`; a 50-clip render emits 100+ such events | hundreds of MB of transfer per run, UI jank, server JSON.stringify of MBs per event; MCP `get_project`/`get_transcript` load it too | H |
| 2 | `searchIndex` | `router.ts:657-668` | 500 projects (by `updated_at`), 5,000 clips with **no ORDER BY** | users x projects x clips | past the cap the palette silently cannot find things, and which clips drop is arbitrary; below it, 4 MB per open | H |
| 3 | `projects.list` | `router.ts:672-700`, `web/pages/Projects.tsx:92` | 200 projects by `created_at`; clips unbounded | clips of 200 projects, joined in JS (`filter` per project, O(P x C)) | older projects invisible with no notice ("N projects" counts 200); refetched every 3 s while running, each time loading all clip rows + `bumperAssets` lookup; MCP `list_projects` inherits both | H |
| 4 | Event replay | `router.ts:930-955`, `events.ts:list` | none (pages of 500 until caught up) | all events of the project incl. progress ticks, replayed on every page open and reconnect | opening a finished 1,500-event project streams everything; the client drops progress events and keeps `slice(-499)` of the rest (`Project.tsx:82`), so the log silently loses early runs | M |
| 5 | `project_events` growth | `events.ts` emit, `pipeline/common.ts:66-72` | none; no prune anywhere | progress tick every 1.5 s per running stage, 72% of rows | table and index grow forever (GBs/month hosted); replay (4) and `detectStalls` slow with it | H |
| 6 | Transcript jsonb | `schema.ts` `transcripts.words/rawWords`, `router.ts:145-152` `withTranscript` | none | 5 MB per 3 h row, read **and rewritten whole** under `for update` on every flag add/delete/accept | each edit moves MBs through Postgres and Node, holds the row lock for that time; worker memory per job = whole transcript x copies | M |
| 7 | Unbounded jsonb arrays | `router.ts:161` `deletedFlags.slice(-500)`; `flags`; `clips.diagnostics`; `stage_artifacts.data` (4.6 KB avg) | `deleted_flags` 500 (silently drops oldest = permanent loss of a restorable fix); others none | per edit / per re-render | "restorable" stops being true after 500; others unbounded | M |
| 8 | Reconciler / watchdog | `queue/reconcile.ts:28,105-111` | all projects in a working state, full rows (incl. `settings`), one query per project | active projects (hosted: users x concurrent) | N+1: `last event` query and a `pgboss.job where data->>'projectId'` **seq scan** per project every 5 min; needs `projects.status` index (added) and a pgboss expression index (Phase 1) | M |
| 9 | Directory walks | `storage/sweep.ts:111-140` (hourly), `storage/usage.ts` (`reelsaw storage`) | none | files in DATA_DIR; serial `stat` per file | `inArray(projects.id, ids)` with one id per directory fails above 65,535 parameters (pg limit) so the sweep **throws** on a big DATA_DIR; walk blocks the event loop's IO queue for minutes; S3 listing per sweep not paged | H |
| 10 | Retention / purge batches | `retention.ts:21,42`, `sweep.ts:204` | 200 / 500 / 200 rows per tick, unordered | backlog after enabling retention on an old instance | purge `limit 200` with no `order by` and no cursor: 200 still-referenced assets starve all later ones forever; retention catches up at 200 projects per 5 min (slow, not wrong); predicates had no index (added) | M |
| 11 | Per-user full loads | `bumpers/service.ts:265` `bumperUsageCounts`, `router.ts:315` `bumpers.list`, `quota.ts:82` `usageByUser` | none (`usageByUser` `limit 500` users) | loads **every project and every clip** of the user on each library open; `admin.usage` runs 8 correlated subqueries per user | library open = O(clips of user); admin Usage at 500+ users silently shows 500 | M |
| 12 | jsonb `->>` predicates | `router.ts:340,357` (`bumpers.usage`), `sweep.ts:225` (purge) | `limit 500` / `2000` | all projects/clips of the user, or of the whole instance for purge | no index can serve `settings->>'introAssetId'` (sequential scan of `projects` and `clips` per candidate asset); results silently capped | M |
| 13 | Admin lists | `router.ts:520-539`, `571`; `web/pages/AdminUsers.tsx:54,108` | `limit 500` users, events max 500 | users | search **is** server-side (`LIKE %q%`, no wildcard escaping) but fires per keystroke with no debounce and refetches every 15 s; 2 correlated subqueries per row; 501st user invisible | M |
| 14 | Upload limit | `http.ts:129` | `MAX_UPLOAD_MB` 4096, checked against the `content-length` header only | per upload | chunked requests skip the check; the disk, not the app, is the limit | M |
| 15 | Postgres pool | `db/index.ts:24` (`max: 10`), `queue/workers.ts:62-110` | 10 connections per process, 2 workers per stage + N renders | each SSE catch-up, progress write and emit takes one | at 100 concurrent viewers x per-event `flush` queries, the pool queues; no metric shows it | L |
| 16 | Quotas by UTC day | `quota.ts:44-45,64` | day = UTC midnight | users across time zones | "resets at 00:00 UTC" is correct but hits evening users in the Americas mid-session; documented, not a bug | L |
| 17 | Retries | `queue/boss.ts:92-93` | `retryDelay 15`, `retryBackoff` | a provider outage fails every in-flight job at once | they all retry on the same schedule (check pg-boss version for jitter) | L |
| 18 | Event payload sizes | `pipeline/render.ts:484,568`, `refine.ts:251` | 500-1,500 chars of error text | per failure | bounded and fine; the rule is that payloads carry ids and short strings | L |
| 19 | Media through the app | `http.ts` `/media/*`, `storage.resolve` | local driver streams through Node; S3 driver redirects to a presigned or public URL | clips x views | local: every video byte crosses the app process (Range supported); S3 path is already right | L |
| 20 | SSE per user | `trpc/context.ts:18` (ping 15 s) | none | one stream per open project tab, one LISTEN client per process | no per-user cap; a script can open thousands of streams, each a pool query per notice | L |

Not a finding: `projects.events` filtering is per project in memory (`events.ts` emitter keyed
`project:<id>`), NOTIFY carries ids only (8 KB limit respected), and the stage handoff is
transactional. Ownership is checked in every list (`userId` in `where`), so search endpoints are
tenant-scoped; the risk is volume, not leakage.

## Plan

### Phase 1: cheap, safe, this week
Each item is independent and ships alone. Order is by payoff.

1. **Indexes (done in this change).** Migration `0027_scale_indexes`: `projects (user_id,
   updated_at)`, `projects (status)`, partial retention indexes on `projects` and `clips`,
   `uploads (user_id)`, partial `bumper_assets (deleted_at)`. Risk: build time on a big table
   (all are small today); use `CREATE INDEX CONCURRENTLY` by hand on a hosted instance.
2. **Stop refetching the world (finding 1).** Split `projects.get` into `projects.get` (project,
   clips, estimates, bumpers; no transcript) and `transcripts.get` (words/segments/flags, fetched
   once and invalidated only by transcript changes (refine-stage events and flag
   mutations). Client: event handler invalidates only the query the event concerns
   (`clip.*` -> clips; `stage.*` -> project). MCP: `get_project` and `get_transcript` stop calling
   the full query (`get_transcript` reads segments only). No migration. Risk: screens that read
   `p.transcript` need the second query; use `placeholderData: keepPreviousData` to avoid flashes.
3. **Bounded, resumable event replay (finding 4).** `projects.events` replays only the last 200
   non-progress events from `lastEventId`, then live; the response includes `{ truncated, total }`
   as the first item and the activity tab says "Showing the last 200 of 1,204 events" with a
   "Load earlier" cursor query (`projects.eventsPage({ before, limit })`). Progress ticks never
   replay. Server `events.ts:list` gets a `types` filter; client drops the `slice(-499)`.
   Uses the existing `(project_id, id)` index. No migration. Risk: `Project.tsx` `logSettled`
   heuristic must read the new header instead of a 700 ms timer.
4. **Prune events (finding 5).** At `stage.completed`/`project.done`, delete that project's
   `stage.progress` rows older than the run (they carry no history the UI shows). Plus a daily
   reconciler step: delete `stage.progress` older than 24 h in batches of 5,000 by id cursor.
   Keep a retention setting `EVENT_RETENTION_DAYS` (default 365, 0 = keep) for everything else,
   and `llm_usage`/`admin_events` roll-ups later (Phase 2). Needs a partial index
   `project_events (id) where type = 'stage.progress'` (add with this item). Risk: `runsOf`
   must not read progress rows (it does not; verify with the eval/tests).
5. **Server-side palette search (findings 2, 11).** `search({ q, limit: 20 })` returns at most 20
   projects + 20 clips matched in SQL (`ILIKE` on title/hook with `pg_trgm` GIN indexes added in
   Phase 2; until then `title ILIKE` scoped by `user_id` is a per-user scan, fine to ~5 k clips).
   The palette debounces 150 ms, `keepPreviousData`, shows "20 of many, keep typing". Empty query
   returns the 10 most recent. Client Fuse stays only for actions and the library. MCP gets
   `search_clips` with the same service. No migration. Risk: lose typo tolerance until trigram
   `similarity()` lands; keep Fuse over the 20 results to re-rank.
6. **Paginate lists (finding 3, 13).** `projects.list({ cursor, limit: 24, status?, q? })` ordered
   by `(updated_at, id)` desc with keyset cursor; returns `{ items, nextCursor, total }`.
   Per-card clip facts come from one grouped query (`count(*) filter`, first 3 thumbs by
   `row_number`), not all clip rows. Web: `useInfiniteQuery` with a "Load more" button,
   "Showing 24 of 1,204"; the 3 s poll becomes an event-driven refresh of the visible page only
   (or a `projects.status({ ids })` poll of just the active ones). MCP `list_projects` takes
   `limit`/`cursor` and says when more exist. `admin.users.list` gets the same cursor + debounced
   search (150 ms) and escapes `%`/`_`. Clips list in a project is bounded by `maxClips` (50) so
   it stays unpaginated, with the limit shown. No migration (index from item 1). Risk: Projects
   page header counts ("12 processing, 40 clips ready") need a `projects.stats` query.
7. **Cap jsonb growth (finding 7).** `deleted_flags` keeps 500 but now archives the dropped ones
   to `stage_artifacts` (`kind: "deleted_flags"`) and says so in the UI ("older fixes are in the
   issue report"); `diagnostics` keeps the last 5 attempts; error strings stay <= 1,500 chars.
   No migration.
8. **Sweep that cannot throw (finding 9).** Replace `inArray(projects.id, ids)` with
   `= any($1)` in chunks of 5,000 and walk with bounded parallelism (8 `stat` at a time);
   log the number of directories scanned. No migration.
9. **Batches with cursors (finding 10).** `purgeBumperAssets` and retention order by
   `(deleted_at|updated_at, id)` and remember the last id in the tick so unpurgeable rows do not
   starve the rest. No migration.
10. **pg-boss lookup index (finding 8).** Add `CREATE INDEX ... ON pgboss.job ((data->>'projectId'))
    WHERE state < 'completed'` at startup (idempotent, `IF NOT EXISTS`) or replace the lookups
    with `singleton_key` (already `projectId`-based per stage) which pg-boss indexes (`i8`, `i17`).
    Prefer the `singleton_key` route: no change to pg-boss's schema.

### Phase 2: structural
- **Search table / `tsvector`.** `search_documents (user_id, kind, ref_id, project_id, title,
  body, tsv generated, updated_at)` maintained in the same transaction as the writes that change
  titles/hooks/captions (u.tx), GIN on `tsv` + trigram on `title`. One query serves palette, MCP
  and the Library page; reindex command `reelsaw reindex`. Migration + backfill. Risk: another
  row to keep consistent; mitigate by one writer function and a nightly count check.
- **Transcript storage.** Move `raw_words` out of the row (it is a copy of `words` until a flag is
  accepted): store `words` once plus `flags` as the diff, or chunk words into `transcript_chunks`-
  style rows (about 5 min each) so an edit rewrites 30 KB, not 5 MB. `transcripts.get` becomes a
  range query (`fromSec`, `toSec`) and the editor virtualizes. Migration with backfill; the largest
  change here. Risk: every pipeline reader of `t.words` must read ranges; do it behind
  `readWords(projectId, range)`.
- **Per-tenant limits in the database.** Concurrency per user (`running jobs per user`, enforced
  in the enqueue transaction), projects-in-flight cap, SSE streams per user (count in memory
  per process, cap at 20), API rate limit on `searchIndex`/`search` via the apikey plugin's
  limiter. Rules: a user's burst must queue behind others, not ahead of them (fair-share by
  `user_id` when picking the next job; pg-boss `group` concurrency exists: `job_common_i7`).
- **Usage roll-ups.** `usage_daily (user_id, day, projects, minutes, clips, llm_calls, tokens)`
  written when the facts happen; `usageByUser` reads it. Prune `llm_usage` to 90 days.
- **Media via storage URLs.** Local driver: Hono serves with `sendfile`/Range already; hosted
  must use `STORAGE_DRIVER=s3` + `S3_PUBLIC_URL` (CDN) so no video byte crosses the app. Make
  `projects.get` return storage URLs with versioned names (`render_gen`) so they cache forever.
- **Pool and listener sizing.** `DATABASE_POOL_MAX` env, expose waiting count in `reelsaw status`.

### Phase 3: hosted only
- Separate `app` (API, SSE) from `worker` replicas (already supported: `RUN_WORKERS=false`) and
  size the Postgres pool per role; PgBouncer in transaction mode needs LISTEN on a direct
  connection (already a dedicated client, `events.ts`).
- Partition `project_events` by month (`PARTITION BY RANGE (created_at)`) so retention is
  `DROP PARTITION`; same for `llm_usage`.
- Per-user storage quota (`usage_daily` + S3 prefix size) and a lifecycle rule on the bucket
  for expired sources.
- Read replica for `search` and admin usage if they contend with the pipeline.
- Time-zone-aware quota days (store the user's zone; "resets in 3 h" instead of a UTC clock time).

## How to measure
1. Seed: `SEED_SCALE=1 DATABASE_URL=<bench db> npx tsx scripts/seed-scale.ts --users 20
   --projects 1000 --clips 50` (docs/TROUBLESHOOTING.md, "Measuring at scale").
2. Record before/after for each Phase 1 item: payload bytes (`curl -s ... | wc -c`), server time
   (`EXPLAIN (ANALYZE, BUFFERS)` on the query), and browser time to first result in the palette.
3. Targets: palette keystroke -> results < 100 ms server; Projects first paint < 300 KB;
   opening a finished project < 200 KB before the transcript, events replayed <= 200;
   reconcile tick with 100 active projects < 1 s; no query touching more than a page of rows.
4. Clean up with `--clean`; the seed only creates ids starting with `seed-`.
