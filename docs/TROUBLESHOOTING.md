# Troubleshooting & debugging playbook

What we learned building Reelsaw, the tools that exist because of it, and the order to reach for them.
Everything here runs against the live stack; nothing needs a rebuild.

## 1. First five minutes

```sh
docker compose exec app reelsaw stuck                  # everything unfinished: age, last event, live jobs, problems
docker compose exec app reelsaw recover <clipId|projectId>  # re-run the right step (prepare vs render) / reconcile
docker compose exec app reelsaw logs <id> [n]          # log lines for a project/clip/job, from the log file (survives redeploys)
docker compose exec app reelsaw status <projectId>     # stage, refine steps, every clip, runs, live jobs, errors
docker compose exec app reelsaw events <projectId> 50  # what the pipeline emitted, in order
docker compose exec app reelsaw clip <clipId>          # one clip: bounds, layout segments, last render's cuts + reasons
docker compose exec app reelsaw faces <clipId> [a-b]   # face boxes per frame (clip-relative range) + split speaker tracks; --json = the exact samples a render uses (faces, text boxes, divider strength `divider.s`) for eval fixtures; --votes = per-frame content-region vote, runs and decisions
docker compose logs -f app | pnpm dlx pino-pretty      # structured logs, readable
docker compose logs app | grep '"clipId":"<id>"'       # every line for one clip (logs carry projectId/clipId/jobId)
```

The UI shows the same facts: the clip card's ✂ badge lists applied and refused cuts with the verifier's reason,
the score popover shows the rubric, and the Activity log mirrors `reelsaw events`.

| Symptom | Look at | Usual cause |
|---|---|---|
| Shot changes missing (layout, snapping, text filter act as if one shot) | `reelsaw scenes <projectId>` | Old fixed-threshold detector on dark footage; `--store` the adaptive result |
| Clip "stuck rendering" | `reelsaw status` → live jobs, `retries` | Container restarted mid-job; it resumes once pg-boss notices the missed heartbeat (heartbeat every 15 s, supervisor pass every 60 s) and the retry delay passes (15 s, doubling per retry): expect a minute or two, not seconds. Each restart burns a retry. |
| Word removed in transcript but still heard | ✂ badge / `reelsaw clip` → SKIPPED reason; then `reelsaw cuts <clipId>` | Verifier refused every candidate (see §3). Safe default: audio kept, captions still drop it. |
| Fewer clips than expected | `reelsaw events` → `stage.completed` payload `dropped` | Small model returned few candidates, wrong timestamps (see §4), or scores under the run's gate (`candidates` artifact → `settings.gate`: rule, threshold, median, MAD). |
| Face off-centre | Editor layout track; `reelsaw clip` → layout segments `cx` | Old render (pre-settle tracker) or detector found no face (`fit`). Drag the picture to re-centre. |
| Split crop pans to the other speaker and back | `reelsaw faces <clipId> <range>` → extra boxes, `b` column jumping | Old render (pre-continuity pairing): re-render. |
| Captions from two lines drawn on top of each other | Re-render | Old render (pre-ordered caption timing): re-render. |
| A project or clip setting has no effect | Is the matching gate on? `TRANSCRIPT_BIAS=false` ignores vocabulary hints (`.env` only). Refine toggles (`refineEntities`, `refineDisfluency`, …) also need the instance Pipeline setting / `.env` on (`TRANSCRIPT_CORRECTION`, `DISFLUENCY_REMOVAL`, `DISFLUENCY_LLM`, `REFINE_SCENES`); see "Settings and precedence" in the README | Instance/env refine gates are ceilings. Check Settings → System → Pipeline or `reelsaw settings`, and `docker compose exec app env \| grep -E 'TRANSCRIPT_|DISFLUENCY_|REFINE_|FACE_|VAD|ALIGNER|TEXT_DETECTION'`, then re-run refine. |
| Boot exits with code 78 | First stderr lines | Fail-fast config/self-check: message names the step and the fix. |

Reading runs: the `runs` block of `reelsaw status` lists one line per run (`#3 re-render … done 0:41 clips 1 [render 0:41]`):
sequence, why it started (new project, retry, re-render, refine, re-analyze, clip added; blank reason means
the log predates explicit runs), outcome, total time and per-stage seconds. "How long did that re-render take"
is that line, not the gap between events. A run still `running` with no live job is stuck; see the reconciler notes below.

## 2. Tools

- **`reelsaw` CLI** (`apps/server/src/cli.ts`, also `pnpm --filter @reelsaw/server cli`): same composition root as
  the server with HTTP/workers off, so it sees the exact config, models and storage. The intro/outro commands run
  the same tRPC procedures as the web app and the MCP tools, as the project's owner (`--user` for library commands
  when the install has several accounts). Every command:

<!-- generated:cli -->
Run as `docker compose exec app reelsaw <command>` (from source: `pnpm --filter @reelsaw/server cli <command>`).

| Command | What it does |
| --- | --- |
| `reelsaw version [--json]` | running version, latest published release, how to upgrade |
| `reelsaw users` | list accounts: role, status, sign-up date |
| `reelsaw approve <email>` | approve a waiting account (when email is off or the admin is locked out) |
| `reelsaw make-admin <email>` | promote an account to admin (approves it first if needed) |
| `reelsaw retention` | run the retention sweep now (SOURCE_RETENTION_DAYS / CLIP_RETENTION_DAYS) |
| `reelsaw deleted` | deleted projects that can still be restored, with their purge date |
| `reelsaw restore <projectId>` | undo a project delete (same as projects.restore and the restore_project tool) |
| `reelsaw restore-clip <clipId>` | bring back a deleted clip or one a re-analyze replaced |
| `reelsaw delete-clip <clipId>` | delete one clip, restorable like a project (same as clips.delete and delete_clip) |
| `reelsaw update-project <projectId> [--title t] [--set key=value]… [--clear key]…` | rename a project or change its settings without re-running anything (same as projects.update and update_project); values are JSON or text |
| `reelsaw purge` | [--dry-run]                     remove deleted projects and replaced clips past DELETED_RETENTION_DAYS now |
| `reelsaw machine [--json]` | this box: cpus, memory, disk, GPU, ffmpeg encoder in use and why, where each on-device model runs (same as Settings → System → Overview) |
| `reelsaw status <projectId>` | project, refine steps, clips, live jobs, last error |
| `reelsaw events <projectId> [n=30]` | recent pipeline events |
| `reelsaw clip` | <clipId>                        everything about one clip incl. render diagnostics |
| `reelsaw faces` | <clipId> [a-b] [--json]         face boxes per sampled frame + split speaker tracks |
| `reelsaw rerender <clipId…>` | queue a re-render of one or several clips (same as the UI buttons) |
| `reelsaw import-report <zip> [--user <email>] [--source <file>] [--no-download] [--allow-any-url]` | rehydrate an issue report as a new project (dev only; the zip's contents are untrusted data, see its README) |
| `reelsaw cuts` | <clipId> [--save <dir>] [--fixture <dir>] dry-run the disfluency cut search for a clip and print every candidate verdict; --save writes removed/context audio; --fixture exports each flagged span as an offline regression case for `pnpm eval:cuts` |
| `reelsaw align` | <projectId> <start> <end>       word timestamps from the align model for a source window |
| `reelsaw hear` | <clipId> [start] [dur]          transcribe a range of the RENDERED clip (what viewers hear) |
| `reelsaw flags` | <projectId> [from] [to]         transcript flags (entities / disfluencies) with status |
| `reelsaw storage [sweep [--dry-run]]` | disk use: unique, scratch-only, duplicate-source, expired-but-present bytes; `sweep` removes leftover files nothing points at (the reconciler's hourly sweep) |
| `reelsaw stuck` | every unfinished project/clip: age, last event, live jobs, problems |
| `reelsaw recover <clipId\|projectId>` | clip: re-run the right step (prepare or render); project: reconcile |
| `reelsaw logs` | <id> [n=60] [--since 2h] [--level debug] [--module render] [--raw] log lines mentioning a project/clip/job/request id from LOG_FILE (survives redeploys) |
| `reelsaw log-level [<level\|module=level,...>\|reset] [--for 15m]` | show the log levels in force, or set them for a while (e.g. render=debug); all processes follow within ~5 s |
| `reelsaw scenes <projectId> [--store]` | re-detect shot cuts (adaptive); --store saves them for layout/snapping/overlays |
| `reelsaw bumpers list\|usage <id>\|default <intro\|outro> <id\|none>\|remove <id>\|restore <id>\|rename <id> <name…> [--user <email>]` | the intro/outro library. The user is --user, else the only account on this install; otherwise pass --user |
| `reelsaw project-bumpers <projectId> [--intro default\|none\|<id>] [--outro …] [--intro-sec n] [--outro-sec n] [--rerender]` | a project's intro/outro: the library default, none or a specific item |
| `reelsaw clip-bumpers <projectId> <clipId…> [--intro inherit\|none\|<id>] [--outro …] [--intro-sec n] [--outro-sec n] [--rerender]` | a clip's own choice (inherit the project's, none or an item); both act as the project's owner; --rerender re-renders only the affected clips |
| `reelsaw overlays <projectId> [--store]` | scan the source for burned-in captions / watermarks; --store saves them (renders then hide them) |
| `reelsaw usage` | [--days 30]                     per account: projects, source minutes, clips, model calls / tokens / reported cost, minutes transcribed, stored bytes (same numbers as Users → Usage) |
| `reelsaw limits <email>` | an account's quotas: instance value, plan, override, in force, in use now |
| `reelsaw abuse` | [--run]                         accounts the hourly abuse pass flagged (shared sign-up address, bursts, temporary domains); --run recomputes the flags now |
| `reelsaw billing <email> \| sync [<email>] \| set-plan <email> <plan\|none>` | hosted (REELSAW_EE): an account's plan, subscription, Stripe's view and its last webhook events; `sync` re-reads Stripe for one account or every subscription (the daily reconcile, by hand); `set-plan` grants a plan without Stripe (none removes it) |
| `reelsaw settings [KEY=value…] [--clear KEY…]` | instance settings in force (sign-up mode, quotas, retention, …): .env default, admin override, effective; KEY=value changes one without a restart, --clear KEY goes back to .env (same as Settings → System and set_instance_settings) |
| `reelsaw mcp` | the MCP server over stdio for clients that launch a command: same tools as /api/mcp, forwarded to REELSAW_URL with REELSAW_API_KEY (needs no database; see src/mcp-stdio.ts) |
<!-- /generated -->

- **Clip diagnostics** (`clips.diagnostics`): every render stores cuts applied/skipped with reasons, layout summary,
  output length and render time.
- **Structured logs** (pino, `src/log.ts`): JSON lines; children carry `module`, `projectId`, `clipId`, `jobId`,
  `runSeq`, `userId`, `requestId`; errors under `err` with stack. See "Reading the logs" below. With
  `OTEL_ENABLED=true` each line gets `trace_id`/`span_id`, so a log line jumps straight to its trace.
- **Evals** (no DB, no render):
  - `eval:transcription`: model × bias × correction comparison matrix (`eval/fixtures/transcription/cases.json`).
  - `eval:cuts`: real problem cuts as fixtures (`reelsaw cuts <clipId> --fixture /data/fixtures`), graded clean /
    kept / broken by transcribing the cut result independently of the search's own verifier.
    Run: `pnpm eval cuts` (see [EVALS.md](EVALS.md)).
- **Browser checks** (agent sessions): the Chrome extension runs in a background tab, where timers and media are
  throttled; responsive layouts were checked by loading the page into a 390 px iframe and measuring
  `scrollWidth` / elements wider than the viewport.

## Reading the logs

Logs say what the pipeline decided and why. Timings and counts are in the OpenTelemetry spans, the
`llm_usage` table and the event payloads (`durationSec`), not repeated in the logs.

**Levels.** `error` = something failed and a person must act (clip failed, 5xx, project failed);
`warn` = degraded or recovered (retry, skipped bumper, quota hit, slow request, truncated model answer);
`info` = one line per milestone (every project event, API request, sign-in, admin action, MCP tool
call); `debug` = decisions and inputs (moments with scores, layout per section and why, each cut
verdict, ffmpeg argv, framing, bumpers); `trace` = per-candidate loops. The default is `info`.

**Turn the detail up for one thing.** `LOG_LEVEL` is `<global>,<module>=<level>,...`
(`info,render=debug,http=warn`). Modules: `render`, `analyze`, `transcribe`, `ingest`, `refine`
(entities / disfluency / scenes), `http`, `mcp`, `worker`, `uow` (project events), `storage`,
`media` (ffmpeg / yt-dlp argv), `llm`, `accounts`, `auth`, `web` (browser errors). Without a restart:

    docker compose exec -T app reelsaw log-level                 # what is in force, and any override
    docker compose exec -T app reelsaw log-level render=debug --for 15m
    docker compose exec -T app reelsaw log-level debug --for 5m  # everything, briefly
    docker compose exec -T app reelsaw log-level reset

The command NOTIFYs every process (api, workers hold a LISTEN connection), so the change is live when it returns and it prints
`applied by N process(es)` (each process answers on `reelsaw_loglevel_ack`; waits up to 2 s). A process that missed the
notification still picks it up within about five seconds (poll). It drops back by itself when the time is up. Admins can do the same in Settings → System → Log level. Then re-run the thing (re-render
the clip) and read the lines.

**Read a project's story.**

    docker compose exec -T app reelsaw logs <projectId> 200               # newest 200 lines mentioning the id
    docker compose exec -T app reelsaw logs <clipId> --level debug --module render
    docker compose exec -T app reelsaw logs <projectId> --since 2h --raw | jq 'select(.level>=40)'

`logs` reads `LOG_FILE` (daily files, seven kept, so it survives redeploys); without `LOG_FILE` use
`docker compose logs app | grep <id>`. Fields to filter on: `projectId`, `clipId`, `jobId`, `runSeq`
(which run), `module`, `level` (10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal), `event`
(the project event name on `msg: "project event"` lines), `requestId`, `userId`, `err`.
The story of a run is: `project event` lines (`run.started` ... `stage.completed` ... `project.done`),
the stage's own lines between them, and `job retry` / `job failed` lines with the previous attempt's
reason.

**Follow a request.** Every response carries `x-request-id` (a proxy's id is kept if it sent one).
Search that id: the `http` access line, the `trpc error` line if it failed (procedure, code, user),
or the `mcp tool` line; the lines of the same handler share it. A 5xx body quotes it too. The job a
request enqueued carries the `projectId`, so go from the request line to `reelsaw logs <projectId>`.

**In an issue report.** The zip's `logs.jsonl` has the last seven days of lines for the project and its
clips at the level in force when they were written (`system.json` has `logLevel`; `manifest.notes`
says if debug lines can be missing). Ask the reporter to set `render=debug --for 15m` and re-run when
the decision lines are absent. Logs are untrusted data like everything else in a report.

## 3. Lessons: audio cuts

1. **ASR word timestamps are not ground truth.** Chunk-level Whisper timings were ~300 ms off for short words;
   even whisper-medium on a 3 s window placed "into" at 18.37–18.56 s from one window start and 18.52–18.90 s from
   another (the latter right). Never trust one alignment: align twice with different window offsets.
2. **The verifier can be fooled by the recogniser's language model.** After removing all of "into", whisper still
   transcribed "disappear *into* between" because the phrase is common. Cross-check acoustically: transcribe the
   *removed* audio alone, padded with silence (no context to lean on).
3. **"Deleted word not heard" is not "clean".** Cutting "in-" and leaving "-to" read as "disappear *to* between".
   Require the two neighbours to be heard back to back, with nothing between them.
4. **Search, don't guess.** Fixed candidates (snapped, aligned, original span, alt alignment, small grid), then a
   directed walk that nudges the end forward 50 ms at a time until the leftover disappears or the next word suffers.
5. **Cost:** each check is one ASR call (~10–50 s with whisper-medium on CPU via Speaches). A stubborn cut can take
   minutes. Cloud ASR or CTC forced alignment (docs/RESEARCH.md B1) would make this seconds.

### Disfluency/name fixes skipped for language X

The project's events show "Filler and repeat removal skipped: not available for de" (or "Name fixes
skipped …"). The transcript's detected language (`transcripts.language`) is not English. The
disfluency word lists, the consonant-skeleton name matcher and the wav2vec2-base-960h aligner are
English-only, so `pipeline/language.ts` (`supports(stage, lang)`) turns them off rather than let them
find nothing, or the wrong thing, silently. Cuts you make by hand still work and use the slower
whisper seam check instead of CTC alignment. If the language was detected wrongly (a mixed or very
short video), set the project's language and re-run; to add a language, add its data for the stage
and list it in `SUPPORTED` in `language.ts`.

## 4. Lessons: small local LLMs

- They drift from schemas: lenient parsing (`parseClipsLeniently`, `salvageScores`) plus a plain-text retry.
- They **renumber ids from 1** per prompt: use local 1..k ids per batch and map back; fall back to order.
- They **drop colons from timestamps** (`05:28.0` → `528`): `repairTimestamps` reinterprets mmss when a candidate
  falls outside its chunk. This silently discarded valid clips before it was caught.
- Log what the model returned vs. what survived (`modelPicks`, `usable`, `dropped`): "the AI found nothing" was
  twice "the AI found three things we threw away".

## 5. Lessons: operations

- **Deploys interrupt jobs.** Rebuilding the app container kills in-flight renders; pg-boss retries them, and each
  interruption consumes a retry (render limit is 4 for this reason; `updateQueue` syncs limits on boot). Check
  `reelsaw status` for live jobs before deploying while someone is watching a project.
- **"That address points inside this server's network."** Link sources must be public http(s) URLs: ingest resolves
  the host and refuses loopback, private (RFC1918), CGNAT, link-local, unique-local and multicast addresses, plus
  `localhost`, `host.docker.internal` and `*.internal`. To ingest from a LAN NAS, set `ALLOW_PRIVATE_SOURCE_URLS=true`.
  Residual risk: the check runs before the download, so a public host that redirects to a private address is not
  caught. Downloads are capped by `MAX_SOURCE_FILE_MB` (default 8192); uploads by `MAX_UPLOAD_MB`, counted as bytes
  arrive so chunked bodies are capped too.
- **Docker Desktop disk** fills on rebuilds: `docker builder prune -f --keep-storage 3GB && docker image prune -f`.
- **"The GPU is not used."** `reelsaw machine` (or Settings → System → Overview) says what the app process sees.
  `gpu: none` inside Docker means the container was started without the device: `.env` needs
  `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml` (on Windows use a semicolon,
  `docker-compose.yml;docker-compose.gpu.yml` — a colon is the drive-letter separator and Compose
  treats the value as one broken path) and the host the NVIDIA Container Toolkit. On Linux,
  `docker compose exec app nvidia-smi -L` should list the card; on Docker Desktop (Windows/WSL2)
  the GPU shows up as `/dev/dxg` and the published image usually has no `nvidia-smi` — check
  `video encoder: h264_nvenc` instead. `video encoder: libx264 … no hardware encoder
  available (h264_nvenc: …)` quotes ffmpeg's reason; the usual ones are the missing device or
  `NVIDIA_DRIVER_CAPABILITIES` without `video` (the override sets it). Speaches on the GPU is a separate matter:
  it needs `SPEACHES_IMAGE=ghcr.io/speaches-ai/speaches:latest-cuda`, and `docker compose logs speaches` says which device it loaded the
  model on. The boot log line `video encoder` and the `resources` line (`gpu`) record the same decision.
  `ONNX_EXECUTION_PROVIDER=cuda` without the CUDA libraries logs `onnx execution provider unavailable; using
  the cpu` once per model and carries on.
- **Disk use: `reelsaw storage`** prints unique bytes under `/data` (hardlinks counted once), scratch-only leftovers,
  duplicate sources (same YouTube id or URL in several projects) and sources marked expired but still on disk.
  `reelsaw storage sweep [--dry-run]` removes the leftovers: older render generations, files of deleted clips or
  projects, and `tmp/hear-*` older than a day. The reconciler runs the same sweep about hourly; it skips files
  younger than an hour and any project with a live job or an unfinished status. The same sweep purges library intros/outros removed over 30 days ago that no project setting or clip uses (row, `bumpers/<id>/…` and local cache).  The upload object (`uploads/<id>`) is kept after ingest so Retry can restore an expired source; deleting the
  project deletes it.
- **Background work is bounded and resumable.** The hourly sweep reads project directories in name order, 1,000 per
  database lookup, `stat`s 16 files at a time and stops after 60 s (10 s per directory); the rest continues next
  hour from a cursor in `instance_settings` (`sweep_state`; `reelsaw storage` shows it and the last run time). A
  manual `reelsaw storage sweep` has no budget. Retention and the bumper purge walk `(updated_at|deleted_at, id)`
  in batches of 200 for up to 30 s per tick. History pruning (`prune_state`) deletes 5,000 rows per statement for up
  to 60 s per tick, once a day per table; the first run on a big `project_events` table takes several ticks. Progress
  ticks are persisted at most once per 10 s per stage and deleted when the stage completes or fails
  (`reelsaw status <id>` shows event counts).
- **Live job lookups use `singleton_key`** (project id for stage jobs, clip id for render/prepare), which the
  exclusive queues index, instead of `data->>'projectId'`. Jobs enqueued before this change already carry the key
  (it was set at enqueue), so nothing is missed; if a lookup ever looks empty for a job you can see in `pgboss.job`,
  check its `singleton_key` and wait one reconciler cycle (5 min), which re-enqueues anything truly orphaned.
- **Deleting is reversible** (`projects/service.ts`). Deleting a project sets `projects.deleted_at`, cancels its jobs,
  turns a project that was still working into `failed` ("Stopped because the project was deleted") and emits
  `project.deleted`; every list, search, export, media route and the reconciler leave it out, and pipeline jobs that
  were already running exit (`ProjectGoneError`). Its rows and files stay for `DELETED_RETENTION_DAYS` (default 7;
  0 keeps them), then the hourly sweep (`purgeDeleted`, also `reelsaw purge [--dry-run]` and `reelsaw storage sweep`)
  deletes the rows and only then the files. `reelsaw deleted` lists them with the purge date; `reelsaw restore
  <projectId>` (UI Undo toast, `projects.restore`, MCP `restore_project`) brings one back, failed if it was
  stopped, so Retry resumes it. Removing a user account still deletes its projects at once.
- **Re-analyze keeps the user's clips.** Clips with `origin` manual / manual-ai, or that the user changed
  (`clips.edited_at`, set by every `clips.update`; a framing override or sections, a style override, an intro/outro
  choice) stay and keep rendering; untouched AI picks get `deleted_at` (and a newer render generation, so a render
  still running discards its output). The analyze stage drops candidates overlapping a kept clip by more than 30%
  (`kept-overlap` in the candidates artifact) and numbers new picks after the kept ones. The counts are in the
  `stage.started` event (`kept`, `replaced`) and the `analyze` / `kept` artifact. Replaced clips are listed as
  `replacedClips` on `projects.get`; `clips.restore` / MCP `restore_clip` / `reelsaw restore-clip <clipId>` brings
  one back. Clips edited before `edited_at` existed are only recognised by their framing, style or intro/outro.
  A project finishes (`finalizeProjectIfDone`) only from `rendering`, so a kept clip that finishes while the
  re-analyze is still picking does not end the run early.
- **Deleting one clip** (`clips.delete`, MCP `delete_clip`, `reelsaw delete-clip <clipId>`, all `deleteClip`) is the
  same soft delete: `deleted_at`, a newer render generation, its render/prepare jobs cancelled, a `clip.deleted`
  event, and the project finalized if it was only waiting for that clip. It shows up in `replacedClips` and comes
  back with `restore_clip`. `projects.update` / MCP `update_project` / `reelsaw update-project` only save the title
  and settings (event `project.updated`): nothing re-runs until a re-analyze or re-render.
- **Fair share between users.** Every job carries its owner (`data.userId`) and a pg-boss `priority` of minus the
  owner's live jobs (all queues) when it was queued; pg-boss fetches `priority desc, created_on`, so someone with
  nothing in flight goes ahead of another user's backlog, and one user's jobs stay first-come first-served. The
  priority is fixed at enqueue: a backlog queued before a second user arrived keeps its place only for the jobs
  already ahead. Jobs a person asked for (create, retry, re-render, new clip, from the UI, MCP or `--user` CLI calls)
  also carry `data.by = "user"` and are refused past `MAX_LIVE_JOBS_PER_USER` ("You have 12 jobs queued or
  running…") or `MAX_RERENDERS_PER_HOUR`; pipeline hand-offs and the reconciler are never refused. Both are
  counted from `pgboss.job` under a per-user advisory lock in the same transaction as the enqueue, so replicas
  agree. Jobs queued before this change have no `userId` and are not counted. See one account with
  `reelsaw limits <email>`; inspect the queue with
  `select name, priority, data->>'userId', state from pgboss.job where state in ('created','retry','active') order by priority desc, created_on`.
- **One model server, many jobs: `PROVIDER_CONCURRENCY`.** `ANALYZE_CONCURRENCY` / `TRANSCRIBE_CONCURRENCY` are per
  job; the provider gate (`ai/gate.ts`) caps calls per provider across all jobs and processes (default 2 for a
  self-hosted Ollama / Speaches, unlimited for cloud). Each process has an in-memory semaphore, and the cross-process
  limit is N Postgres session advisory locks per provider (`pg_locks` rows with `locktype = 'advisory'`) held on a
  dedicated connection for the length of the call, so each process holds at most N extra database connections
  per gated provider. A process that dies drops its slot with its connection. Calls waiting for a slot log
  `waiting for a provider slot` at debug after 5 s; their traced latency does not include the wait. Raise the
  number only if the server itself runs requests in parallel (`OLLAMA_NUM_PARALLEL`).
- **Usage per user** (`reelsaw usage [--days 30]`, Users → Usage): model calls and tokens from `llm_usage`, with
  `cost_usd` when the provider reports it (AI Gateway; self-hosted and most direct vendors leave it empty), minutes
  transcribed from `stt_usage` (one row per provider call; cache hits are free and not written; pruned with
  `LLM_USAGE_RETENTION_DAYS`), stored bytes = sources + uploads + rendered clips (`clips.output_bytes`, empty for
  clips rendered before it existed) + intros/outros. `MAX_STORAGE_MB` refuses an upload or a new project once the
  total passes it.
- **Deleted fixes past 200** move to `stage_artifacts` (`stage=review`, `kind=deleted_flags`); Restore still finds them.
- **Compose project name is pinned** (`name: reelsaw`), so volumes don't change when the checkout folder does.
- **Resource governor** is stdlib-only (CPU utilisation from `os.cpus()` deltas, `process.availableMemory()`,
  `fs.statfs`), so it behaves the same on Linux, macOS and Windows; thresholds in Settings.

## 6. Lessons: UI

- Radix ScrollArea wraps content in `display: table`, which stops flex-wrap/truncate from shrinking: the shared
  `ScrollArea` forces it back to block. Symptom: page not responsive on phones.
- Normalising the layout track must not merge equal neighbours, or a fresh split (Auto | Auto) disappears on the
  next drag.
- Inline-block spans swallow trailing spaces (karaoke "howyour"): put the space outside the scaled span.

## Lessons: framing and burned-in text

- **Split crops must be speaker-sized.** A full-height 9:8 crop of a wide two-shot is ~60% of the frame and pins
  edge speakers off-centre; `speakerCrop` (@reelsaw/shared, used by renderer and preview) sizes each crop to
  ~3.2 face-heights and keeps it out of burned-in text bands.
- **Face detectors see posters.** UltraFace returned a wall object as a face (score ~0.88, identical box every
  frame) and split paired it with the real speaker. `dropStaticFaces` removes face clusters that never move.
- **Pair speakers by continuity, not by box size.** Taking the two largest boxes per frame and sorting them
  left/right let a spurious box beside one speaker (a second detection, a hand) outrank the other speaker, so
  that crop panned onto the wrong person and back ("lazy eye"). `assignPair` gives each box to the speaker it's
  nearer to and holds the last position when a speaker has none (eval `framing/split-spurious-box-beside-speaker`).
- **Speakers disappear for seconds** (drinking, turning away). Split holds through short one-face stretches when the
  visible face matches one of the split speakers; otherwise the layout flips for a sip.
- **Burned-in text**: PP-OCRv4 detector (~35 ms/frame) over ~160 frames; overlays are text that stays put across
  shots. With no detected shot changes only the top 15% / bottom 40% are trusted (a shirt print was flagged
  otherwise). `reelsaw overlays <projectId> [--store]` re-scans an existing project.
- **Blur regions must cover the longest line, not the typical one.** Centred subtitles vary in width, so a
  frequency grid only finds the band's core; ends of long lines and second lines leaked past the blur (39/133
  sampled frames). Regions now grow to the boxes seen in them (`growOverlays`, core-anchored so they don't
  chain into nearby logos), and each render re-detects inside its own clip. Measured by masking frames and
  re-running the detector (eval `overlays/mask-residual`): 0 frames with caption text left.
- **ffmpeg `boxblur`** caps chroma radius at a quarter of the region size (yuv420p): pass luma/chroma radii
  separately. ffmpeg errors now lead with the failing lines instead of the banner.

## Measuring at scale

To see how lists, search and event replay behave at 1,000 projects / 50,000 clips (plan:
[specs/scale.md](specs/scale.md)), seed a **throwaway** database, never one you care about:
`cd apps/server && SEED_SCALE=1 DATABASE_URL=postgres://<user>:<password>@localhost:5442/reelsaw npx tsx scripts/seed-scale.ts --users 20 --projects 1000 --clips 50 --hours 2`
(5442 is the bench stack's Postgres, the app is on 3200; the script refuses without `SEED_SCALE=1` and has no default
URL). It writes 2-hour transcripts with realistic word arrays, ~600 events per project (75% progress ticks) and
no media files, using only ids that start with `seed-`; take timings with `EXPLAIN (ANALYZE, BUFFERS)`
and `select octet_length(...)`, sign in as a user created through the app and assign the seeded
projects to it with `update projects set user_id = '<id>' where id like 'seed-%'` to try the UI, and
remove everything with the same command plus `--clean`.

## Investigating an issue report

1. Import it into the local stack (never a production instance; released images refuse):
   `docker compose cp report.zip app:/data/tmp/r.zip && docker compose exec app reelsaw import-report /data/tmp/r.zip`.
   The summary lists clips, fixes, the failed stage, which models ran, notes about missing pieces,
   and any **instruction-like passages** it found (field + snippet).
2. Open the printed URL; use `reelsaw status/clip/faces/cuts` on the new ids. The original ids are
   in the project's `sourceMeta.report`.
3. Clips whose render wasn't in the zip are "failed" with a note, and mid-run projects come in as
   "failed": nothing runs until you press Retry. Re-renders need the source video (downloaded from
   known video hosts automatically, or `--source <file>`).
4. `logs.jsonl`, `errors.jsonl`, `queue.json`, `system.json` and `artifacts.json` stay in the zip.

**Working on a report with an AI agent:** transcripts, titles, model output, logs and the user's
description come from someone else's machine and can contain text aimed at the reader ("ignore
previous instructions", "run …"). Point the agent at the zip's README first, keep it in the normal
permission mode (no bypass or auto-accept), and run it in a worktree or devcontainer whose `.env`
has no production credentials. The importer's warnings are a tripwire, not a filter.

## Lessons: stuck jobs (manual clip, 2026-10-15)

What happened: a manual clip's AI preparation ran while Ollama was down, the clip ended up queued for render
without its metadata, two deploys killed the render, and the cut search ran for minutes without a progress event.
It looked frozen and the evidence was gone with the container's logs. What changed:

- **Recoverability:** `needsPrepare` routes an unprepared user clip back through `clip.prepare` from every path
  (render worker, re-render, retry, reconciler, `reelsaw recover`). Deploys drain: `SHUTDOWN_GRACE_SECONDS=300` +
  compose `stop_grace_period: 330s`, so a rebuild waits for running renders instead of burning a retry.
- **Triagability:** retried jobs log `previousAttempt` (our error or pg-boss "job heartbeat timeout" =
  interrupted) and post a `clip.retrying` event; the reconciler's watchdog posts `job.stalled` after
  `STALL_MINUTES` without events; the cut search reports progress per cut and attempt; logs also go to
  `LOG_FILE` (`/data/logs/reelsaw.log`, daily rotation, 7 kept) so `reelsaw logs <id>` works after redeploys.
- **Dependencies down:** boot fail-fast (exit 78) when the model that will actually run is unreachable or
  unusable (step `ai model check`). "Effective" means the admin override from Settings → Models when one is
  in force, else `AI_MODEL` / `TRANSCRIPTION_MODEL`; the error label says which. A dead server behind an
  unused env default only logs a warning naming the env var, so a deployment switched to a cloud model still
  boots. On a host where Ollama is started by hand, check `curl localhost:11434/api/version` first. On Linux
  with a host Ollama, the container reaches it through `host.docker.internal`, so Ollama must listen on
  `0.0.0.0` (`OLLAMA_HOST=0.0.0.0`), not only 127.0.0.1; test with
  `docker run --rm --add-host host.docker.internal:host-gateway busybox:1.36 wget -qO- http://host.docker.internal:11434/api/tags`.
  A transcription model without word timestamps (for example `openai:gpt-4o-transcribe`) is rejected at boot too.

## 7. Improvements: done and next

Done: dev loop without rebuilds (`docker-compose.dev.yml`), content-addressed ASR cache (`DATA_DIR/cache/asr`),
stall watchdog (`job.stalled`), CTC forced alignment for cut boundaries, adaptive shot-cut detection, VAD pause
trimming.

Also done: LLM call capture (`LLM_TRACE=logs|langfuse`), audio-aligned caption timing, active speaker framing.

Next:
1. **Replay** captured LLM calls (`reelsaw replay analyze <projectId>`) and a selection eval from labelled moments.
2. **More fixtures:** export every refused cut automatically so `eval cuts` grows from real failures.
3. **Speaker cases:** label real back-and-forth conversations for `eval speakers` (one monologue case today).

## 8. Evals and regression cases

Every fixed bug should leave a case behind: `pnpm eval` runs all suites (<!-- generated:suite-names -->`selection`, `framing`, `scenes`, `pauses`, `alignment`, `speakers`, `overlays`, `cuts`, `transcription`, `disfluency`, `selection-model`<!-- /generated -->) against committed fixtures and baselines and exits non-zero on a
regression. How to run, add a case (reproduce → export → label → run → fix → `--update`) and where to
pull more data from: [EVALS.md](EVALS.md).
