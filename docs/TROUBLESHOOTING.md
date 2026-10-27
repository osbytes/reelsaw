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
| Shot changes missing (layout, snapping, text filter act as if one shot) | `reelsaw scenes <projectId>` | Project analysed before cuts were detected for every project, or dark footage under the old fixed threshold; `--store` the adaptive result |
| Clip "stuck rendering" | `reelsaw status` → live jobs, `retries` | Container restarted mid-job; it resumes once pg-boss notices the missed heartbeat (heartbeat every 15 s, supervisor pass every 60 s) and the retry delay passes (15 s, doubling per retry): expect a minute or two, not seconds. Each restart burns a retry. |
| Upload stuck on "Downloading…" then fails after ~15 min | worker log `Not enough disk` / older `Gave up waiting 900s for resources before ingest` | Worker volume smaller than `MIN_FREE_DISK_MB` plus the file (a ~4.6 GB disk cannot hold a 2 GB upload and still keep 2 GB free). Ingest used to wait the full 900 s, then retry, and the UI labelled every ingest "Downloading". With an S3 store the worker first evicts scratch copies the bucket has (`evicted scratch for a job short of disk`), then hands the job to a worker with room (`handing the job to a worker with disk`) before it fails. |
| Worker volume fills up over weeks with an S3 store | `reelsaw storage` → "scratch copies of stored files"; `du -sh /data/projects` | Every source and render ever processed also sat on the worker as a cache the sweep never evicted. Now `SCRATCH_CACHE_HOURS` (24) evicts the copies of finished projects once idle; `reelsaw storage sweep` does it at once, `reelsaw storage reclaim <MB>` frees a given amount least-recently-used first. |
| Two large ingests started together, one (or both) failed with `ENOSPC` / "No space left on device" mid-download | `reelsaw storage` → "leased to jobs in flight"; worker log `leased disk` (debug), `waiting for resources` with `leased to N jobs in flight` | Before disk leases both passed the free-space check on the same bytes. Now a job claims its scratch against the volume's live leases (`disk_leases`, one advisory lock per volume) before it writes: the second job waits for the first to finish (progress says "Waiting for resources: … leased to 1 job in flight") and gives up only after `RESOURCE_WAIT_MAX_SECONDS`, when pg-boss retries it. Seeing this on a current version means a process outside Reelsaw is filling the volume. |
| A worker shows "disk full" under Settings → System → Workers and takes no media jobs | worker log `paused disk queues on this worker` | Free disk fell under `MIN_FREE_DISK_MB`, nothing was left to evict (the local store, every copy in use, or the sweep already ran) and another worker had room. That worker takes ingest, transcribe, scene refinement, analyze, prepare and render; this one keeps the transcript-only refine queues (entities, disfluency) and resumes on its own 1 GB above the floor (`resumed disk queues`), or sooner when no other worker has room any more (the peer crashed, stopped or filled up: a stuck queue is worse than a failing job). Free space (retention, `reelsaw storage sweep`, a bigger volume) or add a worker. A single box never pauses: its jobs fail fast with `Not enough disk`. |
| Word removed in transcript but still heard | ✂ badge / `reelsaw clip` → SKIPPED reason; then `reelsaw cuts <clipId>` | Verifier refused every candidate (see §3). Safe default: audio kept, captions still drop it. |
| Transcript filled with one looping word or the show's name list ("no no no…", "Chafing Dream Swag Bags…") | `reelsaw status` words around that time; many copies share one timestamp | Whisper decoder loop on a 10-minute chunk (often after a real short repeat, or the vocabulary `prompt` leaking at a chunk cut). Collapse keeps a short run; a repetitive chunk is retried without the prompt. Re-transcribe to recover the missing minutes. |
| Fewer clips than expected | `reelsaw events` → `stage.completed` payload `dropped` | Small model returned few candidates, wrong timestamps (see §4), or scores under the run's gate (`candidates` artifact → `settings.gate`: rule, threshold, median, MAD). |
| Face off-centre | Editor layout track; `reelsaw clip` → layout segments `cx` | Old render (pre-settle tracker) or detector found no face (`fit`). Drag the picture to re-centre. |
| Split crop pans to the other speaker and back | `reelsaw faces <clipId> <range>` → extra boxes, `b` column jumping | Old render (pre-continuity pairing): re-render. |
| Captions from two lines drawn on top of each other | Re-render | Old render (pre-ordered caption timing): re-render. |
| A project or clip setting has no effect | Is the matching gate on? `TRANSCRIPT_BIAS=false` ignores vocabulary hints (`.env` only). Refine toggles (`refineEntities`, `refineDisfluency`, …) also need the instance Pipeline setting / `.env` on (`TRANSCRIPT_CORRECTION`, `DISFLUENCY_REMOVAL`, `DISFLUENCY_LLM`, `REFINE_SCENES`); see "Settings and precedence" in the README | Instance/env refine gates are ceilings. Check Settings → System → Pipeline or `reelsaw settings`, and `docker compose exec app env \| grep -E 'TRANSCRIPT_|DISFLUENCY_|REFINE_|FACE_|VAD|ALIGNER|TEXT_DETECTION'`, then re-run refine. |
| Boot exits with code 78 | First stderr lines | Fail-fast config/self-check: message names the step and the fix. |
| Boot fails at `data dir` with `EACCES … mkdir '/data/…'` | Volume mount ownership | A root-owned volume (common on Railway) hid the image's `node`-owned `/data`. Current images fix this in the entrypoint (`chown` then `gosu node`). On an older image: upgrade, or set `DATA_DIR=/tmp/reelsaw` temporarily (ephemeral; OK with `STORAGE_DRIVER=s3`). |
| `tsx` / `stripe:setup` fails: `@reelsaw/shared` has no export named `billingPath` (or similar) | Stale `packages/shared/dist` | `dist` is gitignored; rebuild with `pnpm --filter @reelsaw/shared build`. `pnpm stripe:setup` does that first. |

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
| `reelsaw releases [--json] [--limit n]` | published versions from GitHub (reelsaw.com/releases / list_releases) |
| `reelsaw users` | list accounts: role, status, sign-up date |
| `reelsaw approve <email>` | approve a waiting account (when email is off or the admin is locked out) |
| `reelsaw make-admin <email>` | promote an account to admin (approves it first if needed) |
| `reelsaw set-password <email> [--must-change]` | set an account's password from a prompt (or two stdin lines); `--must-change` requires a new one at next sign-in. Do not put the secret on the command line |
| `reelsaw retention` | run the retention sweep now (SOURCE_RETENTION_DAYS / CLIP_RETENTION_DAYS) |
| `reelsaw deleted [email]` | restorable deletes as one list with their purge date. No email: projects across the install. With email: that account (the Deleted page / list_deleted) |
| `reelsaw restore <projectId>` | undo a project delete (same as projects.restore and the restore_project tool) |
| `reelsaw restore-clip <clipId>` | bring back a deleted clip or one a re-analyze replaced |
| `reelsaw delete-clip <clipId>` | delete one clip, restorable like a project (same as clips.delete and delete_clip) |
| `reelsaw delete-clips <projectId> <clipId…>` | delete several clips of one project at once (same as the selection bar, clips.deleteMany and delete_clips) |
| `reelsaw purge-clip <clipId>` | delete one already-deleted clip forever (same as clips.purge and purge_clip) |
| `reelsaw captions <clipId> [--format srt\|vtt] [--words]` | print a clip's rendered captions as an SRT or VTT file (same as clips.captions and get_clip_captions) |
| `reelsaw transcript-file <projectId> [--format srt\|vtt] [--words]` | print a project's transcript as an SRT or VTT file (same as projects.transcriptFile and get_project_transcript_file) |
| `reelsaw import-transcript <projectId> <file.srt\|file.vtt> [--language xx]` | use a subtitle file as the transcript instead of transcribing (same as projects.importTranscript and import_transcript) |
| `reelsaw update-project <projectId> [--title t] [--set key=value]… [--clear key]…` | rename a project or change its settings without re-running anything (same as projects.update and update_project); values are JSON or text |
| `reelsaw create-project <url> [--user <email\|id>] [--title t] [--set key=value]…` | start a project from a link for an account (the given user, else the only account); same as projects.create and create_project; takes the same settings as update-project |
| `reelsaw retry <projectId>` | resume a failed or stuck project from its furthest completed stage (same as the Retry button, projects.retry and retry_project) |
| `reelsaw reanalyze <projectId> [--set key=value]…` | pick clips again from the existing transcript, optionally with new selection settings; clips made or edited by hand stay (same as projects.reanalyze and reanalyze_project) |
| `reelsaw refine <projectId> [--steps entities,disfluency,scenes] [--vocabulary text]` | re-run refine steps on the existing transcript, then re-render (same as projects.refine and refine_project) |
| `reelsaw delete-project <projectId>` | delete a project, restorable like a clip (same as projects.delete and delete_project) |
| `reelsaw export <projectId> [clipId…] --out <file.zip>` | write the zip of rendered clips with YouTube / TikTok metadata; the same conditions as the Export button and export_project (every picked clip must belong to the project, at least one rendered) |
| `reelsaw create-clip <projectId> <startSec> <endSec> [--mode exact\|ai]` | add a clip from a time range of the source: exact keeps the bounds, ai picks the best moment inside them (same as clips.create and create_clip) |
| `reelsaw update-clip <clipId> [--title t] [--hook t] [--caption t] [--start s] [--end s] [--rerender\|--no-rerender]` | edit one clip; a change burned into the video re-renders it unless told not to (same as clips.update and update_clip) |
| `reelsaw purge [--dry-run]` | remove deleted projects and replaced clips past DELETED_RETENTION_DAYS now |
| `reelsaw purge-project <projectId>` | delete one already-deleted project forever (frees storage; minutes stay counted) |
| `reelsaw machine [--json]` | this box: cpus, memory, disk, GPU, ffmpeg encoder in use and why, where each on-device model runs (same as Settings → System → Overview) |
| `reelsaw ytdlp-proxies [--json]` | yt-dlp egress pool: operator priority vs circuit (reliability), never URLs |
| `reelsaw workers [--json]` | every process that has checked in: role, specs, last seen, current jobs (same as Settings → System → Workers) |
| `reelsaw queue [--json]` | waiting / running / retrying jobs per stage, plus what is in flight (same as Settings → System → Queue) |
| `reelsaw failure <projectId\|clipId> [--json]` | one failed project or clip: owner, stage, the full recorded reason (same as clicking a row under Settings → System → Queue → Failed work) |
| `reelsaw retry-failures [--stage s] [--q text] [--since 24h] [--json]` | retry failed projects and clips matching a reason after a platform fix (same as Settings → System → Queue → Retry all matching) |
| `reelsaw status <projectId>` | project, refine steps, clips, live jobs, last error |
| `reelsaw events <projectId> [n=30]` | recent pipeline events |
| `reelsaw clip <clipId>` | everything about one clip incl. render diagnostics |
| `reelsaw faces <clipId> [a-b] [--json]` | face boxes per sampled frame + split speaker tracks |
| `reelsaw rerender <clipId…>` | queue a re-render of one or several clips; a clip that never got its AI title is prepared first (same as the UI buttons, clips.rerender / rerenderMany and rerender_clip / rerender_clips) |
| `reelsaw import-report <zip> [--user <email>] [--source <file>] [--no-download] [--allow-any-url]` | rehydrate an issue report as a new project (dev only; the zip's contents are untrusted data, see its README) |
| `reelsaw report [projectId] [--out file.zip] [--instance] [--description text] [--user email]` | write an issue-report zip (same as Report an issue); --instance adds unfinished work, failed jobs, usage and error logs across every account (operator) |
| `reelsaw cuts <clipId> [--save <dir>] [--fixture <dir>]` | dry-run the disfluency cut search for a clip and print every candidate verdict; can save the removed and context audio, and export each flagged span as an offline regression case for `pnpm eval:cuts` |
| `reelsaw align <projectId> <start> <end>` | word timestamps from the align model for a source window |
| `reelsaw hear <clipId> [start] [dur]` | transcribe a range of the RENDERED clip (what viewers hear) |
| `reelsaw flags <projectId> [from] [to]` | transcript flags (entities / disfluencies / collapsed loops) with status |
| `reelsaw storage [sweep [--dry-run] \| reclaim <MB> [--dry-run]]` | disk use: unique, scratch-only, scratch copies of stored files (S3), leased to jobs in flight, duplicate-source, expired-but-present bytes; `sweep` removes leftover files nothing points at and evicts idle cache copies (the reconciler's hourly sweep); `reclaim` evicts least-recently-used copies until that many MB are freed (what a job short of disk does on its own) |
| `reelsaw stuck` | every unfinished project/clip: age, last event, live jobs, problems |
| `reelsaw recover <clipId\|projectId>` | clip: re-run the right step (prepare or render); failed project: retry it; any other project: put its lost jobs back |
| `reelsaw logs <id> [n=60] [--since 2h] [--level debug] [--module render] [--raw]` | log lines mentioning a project/clip/job/request id from LOG_FILE (survives redeploys) |
| `reelsaw log-level [<level\|module=level,...>\|reset] [--for 15m]` | show the log levels in force, or set them for a while (e.g. render=debug); all processes follow within ~5 s |
| `reelsaw scenes <projectId> [--store]` | re-detect shot cuts (adaptive); --store saves them for layout/snapping/overlays |
| `reelsaw library list\|search\|add\|update\|rename\|delete\|restore\|purge\|usage\|default\|reindex [--user <email>]` | the library: intro/outro videos and images, logos, stickers, GIFs, SVGs, music and sound effects. `list` shows your files, `search` looks in your library, the Reelsaw catalog (default) or an enabled provider (pexels, pixabay, freesound, iconify, openverse, giphy, klipy); `add` takes a file, a link or a search hit (license and credit are recorded); `update` sets tags, `rename` the name, `default` the intro or outro for new projects. Acts as the given user, else the only account on this install. `reindex` rebuilds the asset reference table ("used by", purge safety) for every project, to completion |
| `reelsaw catalog status\|refresh` | the Reelsaw catalog manifest in force (version, source, last check); refresh asks CATALOG_URL now |
| `reelsaw project-bumpers <projectId> [--intro default\|none\|<id>] [--outro …] [--intro-sec n] [--outro-sec n] [--rerender]` | a project's intro/outro: the library default, none or a specific item |
| `reelsaw clip-bumpers <projectId> <clipId…> [--intro inherit\|none\|<id>] [--outro …] [--intro-sec n] [--outro-sec n] [--rerender]` | a clip's own choice (inherit the project's, none or an item); both act as the project's owner; --rerender re-renders only the affected clips |
| `reelsaw clip-layers <projectId> <clipId> [--set '<json array>' \| --add <assetId> --from <sec> --to <sec> [--x f] [--y f] [--w f] [--opacity f] [--loop\|--no-loop] \| --add-text <text> --from <sec> --to <sec> [--x f] [--y f] [--size f] [--color #RRGGBB] [--font <family>] [--box] [--opacity f] \| --add-sound <assetId> --from <sec> [--to <sec>] [--volume 0-1] [--offset <sec>] [--fade <sec>] [--duck\|--no-duck] [--loop\|--no-loop] \| --remove <layerId> \| --clear] [--rerender]` | everything laid over or played under a clip, one list (source seconds, x/y/w/size as fractions of the 9:16 frame); a sound of 8 s or less, is a one-shot at full level, anything else music (ducked, faded, looped); with no change flag it lists them |
| `reelsaw apply-framing <clipId> [--at <sec>] [--keep-overrides] [--no-rerender]` | make one clip's framing (its section at --at, else its first framed one: mode plus nudge / subject / crop) the project's default for every clip, clearing the others' own sections and re-rendering the finished ones (same as the editor's "Use for all clips" and apply_framing) |
| `reelsaw templates list \| show <id> \| save <projectId> <clipId> <name…> \| rename <id> <name…> \| set <id> --layers '<json array>' \| delete <id> \| restore <id> \| purge <id> \| apply <templateId> <projectId> [clipId…] [--add] [--rerender]` | layer templates: layers whose timing fits any clip length (head / tail / fill / relative); `save` builds one from a clip's layers, `apply` writes them onto the clips of a project (all of them without clip ids; --add keeps the clip's own layers, default replaces); --rerender re-renders the finished ones. Same procedures as the Templates page and the MCP tools |
| `reelsaw overlays <projectId> [--store]` | scan the source for burned-in captions / watermarks; --store saves them (renders then hide them) |
| `reelsaw usage [--days 30]` | per account: projects, source minutes, clips, model calls / tokens / reported cost, minutes transcribed, stored bytes (same numbers as Users → Usage) |
| `reelsaw limits <email> [--watermark always\|never\|follow]` | an account's quotas: instance value, plan, override, in force, in use now; --watermark sets the per-user override (same as Users → Limits) |
| `reelsaw abuse [--run]` | accounts the hourly abuse pass flagged (shared sign-up address, bursts, temporary domains); --run recomputes the flags now |
| `reelsaw billing <email> \| sync [<email>] \| set-plan <email> <plan\|none>` | hosted (REELSAW_EE): an account's plan, subscription, Stripe's view and its last webhook events; `sync` re-reads Stripe for one account or every subscription (the daily reconcile, by hand); `set-plan` grants a plan without Stripe (none removes it) |
| `reelsaw settings [KEY=value…] [--clear KEY…]` | instance settings in force (sign-up mode, quotas, retention, …): .env default, admin override, effective; KEY=value changes one without a restart, --clear KEY goes back to .env (same as Settings → System and set_instance_settings) |
| `reelsaw mcp` | the MCP server over stdio for clients that launch a command: same tools as /api/mcp, forwarded to REELSAW_URL with REELSAW_API_KEY (needs no database; see src/mcp-stdio.ts) |
<!-- /generated -->

- **Clip diagnostics** (`clips.diagnostics`): every render stores cuts applied/skipped with reasons, layout summary,
  output length and render time.
- **Structured logs** (pino, `src/log.ts`): JSON lines; children carry `module`, `projectId`, `clipId`, `jobId`,
  `runSeq`, `userId`, `requestId`; errors under `err` with stack. See "Reading the logs" below. With
  `OTEL_ENABLED=true` each line gets `trace_id`/`span_id` and is exported to the collector's `/v1/logs` (Sentry shows them under Logs, on the same trace). Prompt, transcript and address fields are not exported.
- **Evals** (no DB, no render):
  - `eval:transcription`: model × bias × correction comparison matrix (`eval/fixtures/transcription/cases.json`).
  - `eval:cuts`: real problem cuts as fixtures (`reelsaw cuts <clipId> --fixture /data/fixtures`), graded clean /
    kept / broken by transcribing the cut result independently of the search's own verifier.
    Run: `pnpm eval cuts` (see [EVALS.md](EVALS.md)).
- **Browser checks** (agent sessions): the Chrome extension runs in a background tab, where timers and media are
  throttled; responsive layouts were checked by loading the page into a 390 px iframe and measuring
  `scrollWidth` / elements wider than the viewport. That width check (and desktop Chrome device
  mode) does **not** simulate the mobile URL bar: `100vh` equals the iframe height there, so a
  bottom bar can look fine and still sit below the fold on a phone. Full-height shells use
  `h-dvh`; confirm bottom-anchored UI on a real device ([UI.md](UI.md)).

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

`logs` reads `LOG_FILE` (daily files, seven kept, so it survives redeploys). Each process (the app and every
scaled worker) writes its own `reelsaw.<worker id>.<date>.<n>.log` in that directory, so rotation in one
never prunes another's; `logs` and issue reports read every `reelsaw.*.log*` file and merge the lines by
timestamp (with `cat`/`grep` on the directory, sort on `time` yourself). Files not written to for seven days
are removed at boot. Without `LOG_FILE` use
`docker compose logs app | grep <id>`. Fields to filter on: `projectId`, `clipId`, `jobId`, `runSeq`
(which run), `module`, `level` (10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal), `event`
(the project event name on `msg: "project event"` lines), `requestId`, `userId`, `err`.
The story of a run is: `project event` lines (`run.started` ... `stage.completed` ... `project.done`),
the stage's own lines between them, and `job retry` / `job failed` lines with the previous attempt's
reason.

**Stalls (`job.stalled`).** After `STALL_MINUTES` without a project event the watchdog posts `job.stalled` once, and the
project page shows it. Its `message` names the stage and what is done, for example "Finding moments has made no progress
for 15 min: 13 of 43 parts done, last part finished 16 min ago." The payload also carries `stage`, `done`, `total`,
`unitMs` (typical time of one part), `lastStepAt` and `lastStepName` (the newest saved step, from `job_steps`), so
`get_project_events` shows the same. Progress ticks alone keep a project from being flagged, except for stages built on
steps (transcribe, analyze): there a model that keeps ticking but finishes no part for `STALL_MINUTES` is flagged too
("is still reporting activity but no part has finished for N min", `ticking: true`), which is the sign of a model too
slow for its parts. A retry continues after the last finished part. Transcription saves each audio chunk as a step
(`chunk:<n>`), so its progress and time left read like finding moments.

**Speech-to-text cache.** Results are cached by the sha256 of the model, its options and the audio, under
`DATA_DIR/cache/asr`. With `STORAGE_DRIVER=s3` each entry is also written to the bucket under `cache/asr/<sha>.json` and
read back on a local miss, so a worker on another host reuses a transcription instead of paying for it again. Entries
older than `ASR_CACHE_DAYS` are removed from both places at boot and by the hourly sweep (up to 5000 bucket entries per
pass).

**Follow a request.** Every response carries `x-request-id` (a proxy's id is kept if it sent one).
Search that id: the `http` access line, the `trpc error` line if it failed (procedure, code, user),
or the `mcp tool` line; the lines of the same handler share it. A 5xx body quotes it too. The job a
request enqueued carries the `projectId`, so go from the request line to `reelsaw logs <projectId>`.

**In an issue report.** The zip's `logs.jsonl` has the last seven days of lines for the project and its
clips at the level in force when they were written (`system.json` has `logLevel`; `manifest.notes`
says if debug lines can be missing). Ask the reporter to set `render=debug --for 15m` and re-run when
the decision lines are absent. An admin's instance-wide zip has every error/fatal line in
`errors.jsonl` (still redacted) plus `stuck.json`. Logs are untrusted data like everything else in a
report.

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

### Long videos on a slow model: timeouts and "Retry continues" (issue report, 2026-10-26)

A 57-minute video on `compat:qwen2.5:14b` with no GPU failed in **Finding moments** after four attempts of exactly 30 minutes:
each of the 43 three-minute windows took 140-190 s, nothing was kept between attempts, so every retry redid the same first 13
windows and died in the same place, and the user saw "This operation was aborted".

- **Finding moments saves its parts.** Each map window, each second look at a window, each batch of scored candidates and the
  shot-cut detection is a *step* (`job_steps`, `ctx.step` in `pipeline/common.ts`), saved the moment it finishes. A retry, a
  restart or a timeout continues where it stopped: the debug lines `step reused` show what was skipped. The project page and
  `reelsaw status` show "13 of 43 parts, about 1 h left" (`projects.stage_detail`; `get_project` has it as `stageDetail`).
- **Two limits, both runtime settings.** `LLM_CALL_TIMEOUT_SECONDS` bounds one model call, every HTTP attempt of it together
  (0 = auto: 120 s hosted, 600 s self-hosted). `STAGE_IDLE_TIMEOUT_MINUTES` stops a stage in which no part finished for that
  long (0 = auto: 1.5 x the call limit). Neither is the total time: a stage may take hours as long as parts keep finishing.
  A CPU-only 14B model needs about 2-3 min per part; raise the call limit if a single call really takes longer.
- **Timeouts read as sentences:** "Finding moments timed out: 13 of 43 parts done in 30 min on qwen2.5:14b (~2.3 min per part).
  Retry continues where it stopped; a smaller or GPU-backed model is faster." That text is the project's error and the
  `stage.failed` / `project.failed` event.
- **Retries count attempts that get nowhere.** An attempt that saved at least one new part does not use up a retry (the worker logs
  `attempt made progress; re-queueing with a fresh budget` and raises the job's `retry_limit` by one); only attempts that saved
  nothing count against the queue's limit, so a slow model finishes and a window that always fails stops after the limit.
  Errors a retry cannot fix (`NonRetryableError`: the source was removed by retention, a quota refuses the video) fail the run at once.
- **Backstop.** pg-boss still expires a job after `clamp(30 min, 30 min + duration x factor, 24 h)`, factor 4 when the language
  model is self-hosted at enqueue time, else 1. It only stops a runaway; the limits above are the budget. Disk leases live 24 h.
- **Checkpoints are dropped** `STEP_RETENTION_DAYS` (14) after a finished project last changed (hourly sweep), or with the project
  when it is deleted forever. They are keyed on content, model, prompt version and settings, so changing the model, the clip lengths
  or the focus asks again only what changed (docs/SELECTION.md).
- Still not checkpointed (a timeout redoes them): the refine steps (name fixes, disfluencies, on-screen text scan), prepare of a manual
  clip and the pairwise re-rank. Each model call in them has the call limit now.

### Whisper decoder loops (issue report 218, 2026-10-24)

whisper-1 on a 10-minute chunk looped `"no"` 2,270 times after a spoken "No, no, no, no", and the previous chunk transcribed the vocabulary prompt (`Chafing Dream Swag Bags Flying Pig Project`) for ten minutes. OpenAI's local Whisper retries a window when zlib compression ratio > 2.4; the API does not. We collapse consecutive unigram runs longer than four copies and n-gram runs of three-plus copies with piled timestamps (`pipeline/asr-loops.ts`), and retry a repetitive chunk once without the prompt. Each collapse is an auto-applied transcript flag (↻ looping speech) over the as-heard words, so it shows up in review like a name fix; rejecting it puts the repeated copies back. Captions stay empty across the hole unless you type replacement text on that flag. Short emphasis (`no no no no`, `I think I think`) is kept. Re-transcribe to recover the minutes the loop replaced. Eval: `pnpm eval asr-loops`.

## 5. Lessons: operations

- **Deploys interrupt jobs.** Rebuilding the app container kills in-flight renders; pg-boss retries them, and each
  interruption consumes a retry (render limit is 4 for this reason; `updateQueue` syncs limits on boot). Check
  `reelsaw status` for live jobs before deploying while someone is watching a project.
- **YouTube bot-check from a datacentre / `YTDLP_PROXY`.** yt-dlp takes one `--proxy`; Reelsaw walks an
  operator-ranked pool in the same variable (one URL still works). **Priority** is yours and never
  changes at runtime (put the cheap home Pi first). **Reliability** is a circuit breaker per candidate
  (cockatiel): consecutive faults skip that one, then the ranking applies again among whoever is healthy.
  A paid proxy that is 99% successful cannot overtake a Pi that is 80% successful. `reelsaw ytdlp-proxies`
  shows id, priority and circuit — never the URL.

  Plug in a Pi or a cheap VPS as an exit, not as a Tailscale exit node (that would route the whole
  app through it, including model API calls). YouTube must see the **exit machine's public IP** (the
  Pi's home ISP). Tailscale is only the path from the Reelsaw host to that machine:

  1. Install Tailscale on the Reelsaw host, the Pi, and the Racknerd box. `tailscale ip -4` on each.
  2. Run a SOCKS5 proxy **on the exit**, bound to its Tailscale IP so it is not on the public
     internet. [`microsocks`](https://github.com/rofl0r/microsocks) is enough:
     `microsocks -i 100.x.x.x -p 1080`. Use `socks5h://` so DNS happens on the Pi, not in the
     datacentre. A Tailscale **exit node** is the wrong tool.
  3. Set something like
     `YTDLP_PROXY=pi=socks5h://100.64.1.10:1080;priority=20;concurrency=1,racknerd=socks5h://100.64.1.20:1080;priority=10,paid=http://user:pass@gate.example:7000;priority=1`.
     `concurrency=1` keeps the Pi's upload from stacking. Racknerd is still a datacentre IP, so
     YouTube may bot-check it; it is overflow when the Pi is down or busy. `direct` (this server's
     IP) is only useful if Reelsaw itself is on a residential connection.
  4. From inside Docker the container must be able to reach `100.64.0.0/10`. Docker Desktop often
     can; on Linux the host's Tailscale route is not always forwarded. Easiest: SSH SOCKS on the
     host that lands on the Pi (`ssh -N -D 1080 pi@100.64.1.10`) and point the pool at
     `socks5h://host.docker.internal:1080` (the installer already adds `extra_hosts:
     host.docker.internal:host-gateway`). MagicDNS names (`pi.tailnet.ts.net`) usually do **not**
     resolve inside the app container; use the `100.x` address. Test with
     `docker compose exec app wget -qO- http://100.x.x.x:1080` (connection refused from microsocks
     is fine; timeout means the route is missing).
  5. `reelsaw ytdlp-proxies` after a failed ingest: `circuit=open` on `pi` means it was skipped
     and the next priority was used; it comes back after the cooldown without you changing
     `priority`. Circuits are in-process (each worker has its own); they reset on restart.

  **Paid residential gateway (DataImpulse and similar).** YouTube needs one exit IP for the
  whole download, then a *different* IP for the next video. Plan-wide / dashboard sticky pins
  every ingest to one IP until YouTube flags it — that is the "site blocked the download" / bot-check
  failure. Targeting belongs in the proxy **username**, not headers (`yt-dlp --proxy` cannot send
  them). Put `{session}` in the URL; Reelsaw replaces it with a new id on every yt-dlp process
  (including ingest retries). Quote the value: it contains semicolons.

  DataImpulse HTTP (port 823), plan sticky **off**:
  `YTDLP_PROXY='di=http://LOGIN__cr.us;sessid.{session};sessttl.60:PASSWORD@gw.dataimpulse.com:823;priority=1'`.
  SOCKS5 is port 10000 and `socks5h://`. `sessttl.60` is minutes; keep it as long as a long download.
  Each download already has its own IP, so a modest `concurrency` (2–4) is safe; `concurrency=1`
  is only required on a single home Pi.

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
  younger than an hour and any project with a live job or an unfinished status. The same sweep purges library intros/outros deleted over 30 days ago that no `asset_refs` row points at (row, its storage folder `bumpers/<id>/` or `assets/<id>/`, and the local cache; waits until the asset refs backfill has finished), and prunes the speech-to-text cache (`ASR_CACHE_DAYS`).  The upload object (`uploads/<id>`) is kept after ingest so Retry can restore an expired source; deleting the
  project deletes it.
- **Scratch is a cache of the S3 store** (`storage/sweep.ts`, `queue/disk-gate.ts`). With `STORAGE_DRIVER=s3` the
  worker's `projects/<id>/source.*` and `clips/<clip>.<gen>.mp4|jpg` are copies of bucket objects that `ensureLocal`
  pulls back on demand (a cache hit bumps the file's mtime, so "idle" means unused). The hourly sweep evicts the
  copies of finished projects with no live job idle longer than `SCRATCH_CACHE_HOURS` (`evicted a scratch copy the
  store still has`), and `reelsaw storage` lists them as "scratch copies of stored files". A job short of disk
  (`MIN_FREE_DISK_MB` plus its scratch) does not fail at once any more: the governor asks `reclaimScratch` to evict
  least-recently-active finished projects (`projects.updated_at` order, 5 minutes idle is enough under pressure) until
  the job fits, then re-measures. Still short, the stage job looks at the last heartbeats (`worker_instances`): if
  another live worker listening on that queue reported the room, the job is thrown back for pg-boss to retry there
  (`stage.failed` says "another worker will pick it up") and this worker pauses its media queues (ingest, transcribe,
  refine.scenes, analyze, prepare, render; `offWork` with `wait: false`, because it runs inside the job) so the retry cannot land on it; if nobody has the room the run fails with the
  reason, as before. Every 30 s the gate re-measures: below the floor plus 1 GB it evicts proactively, so room is made
  before a job arrives; under the floor with another worker that has room it pauses; back above the floor plus 1 GB it
  registers the queues again, and so does a paused worker whose peer is gone (no other live worker has room for the
  smallest disk requirement: `resumed disk queues on this worker: no other worker can take the work`). A worker never pauses when no other worker could take the jobs (a single box, or every
  worker full): there a job fails fast with the disk message rather than sit on "queued". The heartbeat's `queues`
  (Workers page, MCP `list_workers`, `reelsaw workers`) shows what a paused worker still takes. With the local store
  nothing is evictable (scratch and store are one hardlinked file): `SOURCE_RETENTION_DAYS` / `CLIP_RETENTION_DAYS`
  are what free disk.
- **A job leases its scratch before it writes it** (`disk-leases.ts`). `statfs` sees only bytes already on disk,
  so two ingests of large videos that both passed the free-space check on the same box used to both run out
  mid-download. Now `acquire` checks the job's need (`MIN_FREE_DISK_MB` plus its scratch) against the volume's
  live leases and records its own claim in the same transaction, under `pg_advisory_xact_lock` per volume
  (`disk_leases`): the second job sees the first job's claim and waits for it (progress: "Waiting for resources:
  5000 MB free but 2048 MB leased to 1 job in flight, needs 4096 MB"), evicting idle cache copies once first; it
  gives up after `RESOURCE_WAIT_MAX_SECONDS` like a CPU or memory wait, and pg-boss retries. The stage releases
  the lease when it ends (ingest as soon as the source is on disk, where `statfs` counts it); a transcribe,
  analyze, refine or render that has to pull the source from the S3 store leases that pull the same way (the
  local store hardlinks and writes nothing). A lease counts while its worker has heartbeated within 10 minutes
  (longer than the 45 s hand-off staleness: a database hiccup must not let others over-commit the disk) and until
  it expires after the longest a stage job may run (3 h), so a crash leaks nothing for long; a process drops its
  own leases at boot (a restarted container keeps its id) and at shutdown once its jobs have stopped (not before:
  a job still writing during the grace keeps its claim), and the hourly sweep deletes dead rows. A volume is the
  filesystem `DATA_DIR` is on: every process mounting it (the app and the worker replicas
  of one host sharing the compose `data` volume) reads the same id from the `DATA_DIR/.volume-id` marker, written
  once at first boot; a worker on another host has its own volume and never contends. The heartbeat carries the
  volume's leased total (`diskLeasedMB`; Workers page "(2.0 GB leased)", `reelsaw workers`, `list_workers`), and a
  hand-off counts it as used when it looks for a worker with room. `reelsaw storage` shows "leased to jobs in
  flight on this volume".
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
  deletes the rows and only then the files. Storage still counts until then, or until the owner deletes it forever
  (Deleted, `projects.purge`, MCP `purge_project` / `list_deleted`, `reelsaw purge-project`). Minutes, hourly creates and
  first-video-free are written to `source_usage` at create/ingest and kept for the life of the account (never pruned), so
  deleting cannot reset them; admin usage charts read that ledger. `reelsaw deleted` lists them with the purge date;
  `reelsaw restore <projectId>` (UI Undo toast, `projects.restore`, MCP `restore_project`) brings one back, failed if
  it was stopped, so Retry resumes it (restore re-checks the live project cap). Deleting a user account still deletes
  its projects at once.
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
- **Deleting one clip** (`clips.delete`, MCP `delete_clip`, `reelsaw delete-clip <clipId>`, all `deleteClip`; the
  clip card ⋯, clip editor, and ⌘K) is the same soft delete: `deleted_at`, a newer render generation, its
  render/prepare jobs cancelled, a `clip.deleted` event, and the project finalized if it was only waiting for that
  clip. Several clips of one project use `clips.deleteMany` / `deleteClips` (the selection bar). It shows up on
  Deleted (one list with a compact bar: Restore, and Delete forever in ⋯: `deleted.restore` / `deleted.purge`) and in `replacedClips`
  and comes back with `restore_clip`. The delete toast always offers Undo, Delete forever, and See deletions.
  `projects.update` / MCP `update_project` / `reelsaw update-project` only save the title
  and settings (event `project.updated`): nothing re-runs until a re-analyze or re-render.
- **Fair share between users.** Every job carries its owner (`data.userId`) and a pg-boss `priority` of minus the
  owner's live jobs (all queues) when it was queued; pg-boss fetches `priority desc, created_on`, so someone with
  nothing in flight goes ahead of another user's backlog, and one user's jobs stay first-come first-served. The
  priority is fixed at enqueue: a backlog queued before a second user arrived keeps its place only for the jobs
  already ahead. Jobs a person asked for (create, retry, re-render, new clip, from the UI, MCP or `--user` CLI calls)
  also carry `data.by = "user"` and are refused past `MAX_LIVE_JOBS_PER_USER` ("You have 12 jobs queued or
  running…") or `MAX_RERENDERS_PER_HOUR` (renders, new clips and re-analyze / refine runs); pipeline hand-offs and the reconciler are never refused. Both are
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
- "My edit did not take" after a re-render, while the file on disk is right: the clip's mp4 and jpg live at a URL
  that never changes (`/media/clips/<project>/<clip>.mp4`), so a cached copy replays the previous render. Clip
  media is served `no-cache` with an ETag (`send-file.ts`): the browser asks every time and gets a 304 unless the
  file changed. Any new route that serves a file whose content changes under one URL must do the same.
- The editor's "unsaved" count compares every field of `layoutSectionSchema` (`SECTION_FIELDS` in `ClipEditor`);
  a field listed by hand was how a new one (the fixed crop) was neither counted nor saved.

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
- **Overlay skipped.** `clip.overlay_skipped` (payload `clipId`, `overlayId`, `reason`, sometimes `error`) means a
  clip overlay was left out and the clip still rendered (never failed). Reasons: its whole time range was removed
  by cuts; the library file is gone (deleted and purged); the file could not be read; or the render with overlays
  failed and was retried without any (no `overlayId`, `error` holds the ffmpeg lines). Fix the asset or the range
  in the editor's Overlays lane (or `reelsaw clip-layers`) and re-render. `ClipDiagnostics.overlays` lists what
  was applied and skipped.

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
   An admin report with instance-wide diagnostics also has `stuck.json` (unfinished work across
   the instance) and a `projects.json` of every account's recent and in-progress projects.

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
  compose `stop_grace_period: ${STOP_GRACE_PERIOD:-330s}` (set `STOP_GRACE_PERIOD` to at least `SHUTDOWN_GRACE_SECONDS` + 30s if you raise it), so a rebuild waits for running renders instead of burning a retry. On SIGTERM the app also stops accepting, ends open SSE streams and waits up to 10 s for open requests before the drain.
- **Health:** `GET /api/health` returns 503 with a `checks` map (`db`, `events`, `queue`, `workers`; each answers
  within 2 s or is reported as `timed out`) when the process is up but cannot work: Postgres unreachable, the LISTEN
  connection for live updates down (it reconnects on its own with a 2 s to 30 s backoff and logs each failed attempt as
  `listener reconnect failed`), pg-boss not started, or, in a process that runs workers, its worker heartbeat stale. The
  Docker `HEALTHCHECK` treats any non-2xx as unhealthy. The `worker` compose service has no HTTP server and so no check.
- **Lost jobs do not loop forever:** the reconciler re-enqueues a project or clip whose job vanished (worker crash, OOM
  kill, heartbeat timeout), but counts each re-enqueue (`reconcile_requeues`). The fourth time it fails the project or
  clip with "Processing was interrupted 4 times (the worker crashed, ran out of memory, or was stopped). Retry to try
  again." and logs `gave up re-enqueueing`. Retry (or a new render) resets the count. Only one process runs the
  reconciler tick at a time (an advisory lock); the others log `another process holds the reconciler lock` at debug.
- **No worker:** a process with `RUN_WORKERS=false` logs `this process runs no workers` at boot. Projects then stay
  `queued` until a `worker` container runs; after `STALL_MINUTES` the watchdog posts `job.stalled` with the reason
  "No worker is running" when no worker heartbeat is fresh.
- **Boot checks follow the role:** a process with `RUN_WORKERS=false` only warns when free disk is under
  `MIN_FREE_DISK_MB` (a full disk must not lock out the admin UI that can free it) and skips the face, text and voice
  detectors; with `RUN_HTTP=false` the mail server is not checked. The language model check stays fail-fast in every role.
- **A pinned `WORKER_ID` shared by replicas** (`docker compose --scale worker=N`): the later processes append
  `-<4 hex>` and log `WORKER_ID is already in use by a live process`, so they keep their own heartbeat row and leases.
- **Triagability:** retried jobs log `previousAttempt` (our error or pg-boss "job heartbeat timeout" =
  interrupted) and post a `clip.retrying` event; the reconciler's watchdog posts `job.stalled` after
  `STALL_MINUTES` without events; the cut search reports progress per cut and attempt; logs also go to
  `LOG_FILE` (`/data/logs/reelsaw.<worker id>.log`, one file set per process, daily rotation, 7 kept) so `reelsaw logs <id>` works after redeploys.
- **Job expiry:** every job has a hard expiry after which pg-boss retries it from the start (a crashed worker is
  caught much sooner by the 15 s heartbeat). Defaults: ingest/transcribe 3 h, render 1 h, prepare 15 min, analyze and
  refine 30 min, but analyze and the refine stages are sized per job from the project's duration:
  `clamp(30 min, 30 min + duration x factor, 24 h)`, factor 4 for a self-hosted language model and 1 otherwise
  (`expireInSecondsFor` in `queue/boss.ts`). It is a backstop; the real budget is the per-call and idle timeouts
  (section 4, "Long videos on a slow model"). An expired attempt of Finding moments keeps its saved parts, so Retry continues.
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

Every fixed bug should leave a case behind: `pnpm eval` runs all suites (<!-- generated:suite-names -->`selection`, `framing`, `asr-loops`, `scenes`, `pauses`, `alignment`, `speakers`, `overlays`, `cuts`, `transcription`, `disfluency`, `selection-model`<!-- /generated -->) against committed fixtures and baselines and exits non-zero on a
regression. How to run, add a case (reproduce → export → label → run → fix → `--update`) and where to
pull more data from: [EVALS.md](EVALS.md).
