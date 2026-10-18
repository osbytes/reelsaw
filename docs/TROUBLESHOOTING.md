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
| Clip "stuck rendering" | `reelsaw status` → live jobs, `retries` | Container restarted mid-job; it resumes after heartbeat expiry (~15 s) + retry backoff. Each restart burns a retry. |
| Word removed in transcript but still heard | ✂ badge / `reelsaw clip` → SKIPPED reason; then `reelsaw cuts <clipId>` | Verifier refused every candidate (see §3). Safe default: audio kept, captions still drop it. |
| Fewer clips than expected | `reelsaw events` → `stage.completed` payload `dropped` | Small model returned few candidates, wrong timestamps (see §4), or scores under 45. |
| Face off-centre | Editor layout track; `reelsaw clip` → layout segments `cx` | Old render (pre-settle tracker) or detector found no face (`fit`). Drag the picture to re-centre. |
| Split crop pans to the other speaker and back | `reelsaw faces <clipId> <range>` → extra boxes, `b` column jumping | Old render (pre-continuity pairing): re-render. |
| Captions from two lines drawn on top of each other | Re-render | Old render (pre-ordered caption timing): re-render. |
| Boot exits with code 78 | First stderr lines | Fail-fast config/self-check: message names the step and the fix. |

Reading runs: the `runs` block of `reelsaw status` lists one line per run (`#3 re-render … done 0:41 clips 1 [render 0:41]`):
sequence, why it started (new project, retry, re-render, refine, re-analyze, clip added; blank reason means
the log predates explicit runs), outcome, total time and per-stage seconds. "How long did that re-render take"
is that line, not the gap between events. A run still `running` with no live job is stuck; see the reconciler notes below.

## 2. Tools

- **`reelsaw` CLI** (`apps/server/src/cli.ts`, also `pnpm --filter @reelsaw/server cli`): same composition root as
  the server with HTTP/workers off, so it sees the exact config, models and storage. Commands: `status`, `events`,
  `clip`, `rerender <clipId…>`, `cuts` (dry-run the cut search, prints every candidate verdict; `--save` writes the removed
  and context audio; `--fixture` exports a regression case), `align` (raw word timestamps for any source window),
  `hear` (transcribe a range of the *rendered* clip: what viewers actually hear), `flags`.
  Intro/outro: `bumpers list|usage <id>|default <intro|outro> <id|none>|remove <id>|restore <id> [--user <email>]`,
  `project-bumpers <projectId> [--intro default|none|<id>] [--outro …] [--rerender]`, `clip-bumpers <projectId>
  <clipId…> [--intro inherit|none|<id>] [--outro …] [--rerender]`. They run the same tRPC procedures as the web app
  and the MCP tools, as the project's owner (`--user` for library commands when the install has several accounts).
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
- **Docker Desktop disk** fills on rebuilds: `docker builder prune -f --keep-storage 3GB && docker image prune -f`.
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
- **Dependencies down:** boot fail-fast (exit 78) on an unreachable model server is intended; on a host where
  Ollama is started by hand, check `curl localhost:11434/api/version` first.

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

Every fixed bug should leave a case behind: `pnpm eval` runs all suites (selection, framing, overlays,
cuts, transcription, selection-model) against committed fixtures and baselines and exits non-zero on a
regression. How to run, add a case (reproduce → export → label → run → fix → `--update`) and where to
pull more data from: [EVALS.md](EVALS.md).
