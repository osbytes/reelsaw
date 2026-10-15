# Troubleshooting & debugging playbook

What we learned building Reelsaw, the tools that exist because of it, and the order to reach for them.
Everything here runs against the live stack; nothing needs a rebuild.

## 1. First five minutes

```sh
docker compose exec app reelsaw stuck                  # everything unfinished: age, last event, live jobs, problems
docker compose exec app reelsaw recover <clipId|projectId>  # re-run the right step (prepare vs render) / reconcile
docker compose exec app reelsaw logs <id> [n]          # log lines for a project/clip/job, from the log file (survives redeploys)
docker compose exec app reelsaw status <projectId>     # stage, refine steps, every clip, live jobs, errors
docker compose exec app reelsaw events <projectId> 50  # what the pipeline emitted, in order
docker compose exec app reelsaw clip <clipId>          # one clip: bounds, layout segments, last render's cuts + reasons
docker compose logs -f app | pnpm dlx pino-pretty      # structured logs, readable
docker compose logs app | grep '"clipId":"<id>"'       # every line for one clip (logs carry projectId/clipId/jobId)
```

The UI shows the same facts: the clip card's ✂ badge lists applied and refused cuts with the verifier's reason,
the score popover shows the rubric, and the Activity log mirrors `reelsaw events`.

| Symptom | Look at | Usual cause |
|---|---|---|
| Clip "stuck rendering" | `reelsaw status` → live jobs, `retries` | Container restarted mid-job; it resumes after heartbeat expiry (~15 s) + retry backoff. Each restart burns a retry. |
| Word removed in transcript but still heard | ✂ badge / `reelsaw clip` → SKIPPED reason; then `reelsaw cuts <clipId>` | Verifier refused every candidate (see §3). Safe default: audio kept, captions still drop it. |
| Fewer clips than expected | `reelsaw events` → `stage.completed` payload `dropped` | Small model returned few candidates, wrong timestamps (see §4), or scores under 45. |
| Face off-centre | Editor layout track; `reelsaw clip` → layout segments `cx` | Old render (pre-settle tracker) or detector found no face (`fit`). Drag the picture to re-centre. |
| Boot exits with code 78 | First stderr lines | Fail-fast config/self-check: message names the step and the fix. |

## 2. Tools

- **`reelsaw` CLI** (`apps/server/src/cli.ts`, also `pnpm --filter @reelsaw/server cli`): same composition root as
  the server with HTTP/workers off, so it sees the exact config, models and storage. Commands: `status`, `events`,
  `clip`, `rerender`, `cuts` (dry-run the cut search, prints every candidate verdict; `--save` writes the removed
  and context audio; `--fixture` exports a regression case), `align` (raw word timestamps for any source window),
  `hear` (transcribe a range of the *rendered* clip: what viewers actually hear), `flags`.
- **Clip diagnostics** (`clips.diagnostics`): every render stores cuts applied/skipped with reasons, layout summary,
  output length and render time.
- **Structured logs** (pino, `src/log.ts`): JSON lines; children carry `module`, `stage`, `projectId`, `clipId`,
  `jobId`; errors under `err` with stack. `LOG_LEVEL=debug` adds per-cut decisions. With `OTEL_ENABLED=true` each line
  gets `trace_id`/`span_id`, so a log line jumps straight to its trace.
- **Evals** (no DB, no render):
  - `eval:transcription`: model × bias × correction comparison matrix (`eval/fixtures/transcription/cases.json`).
  - `eval:cuts`: real problem cuts as fixtures (`reelsaw cuts <clipId> --fixture /data/fixtures`), graded clean /
    kept / broken by transcribing the cut result independently of the search's own verifier.
    Run: `pnpm eval cuts` (see [EVALS.md](EVALS.md)).
- **Browser checks** (agent sessions): the Chrome extension runs in a background tab, where timers and media are
  throttled; responsive layouts were checked by loading the page into a 390 px iframe and measuring
  `scrollWidth` / elements wider than the viewport.

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
- **Speakers disappear for seconds** (drinking, turning away). Split holds through short one-face stretches when the
  visible face matches one of the split speakers; otherwise the layout flips for a sip.
- **Burned-in text**: PP-OCRv4 detector (~35 ms/frame) over ~160 frames; overlays are text that stays put across
  shots. With no detected shot changes only the top 15% / bottom 40% are trusted (a shirt print was flagged
  otherwise). `reelsaw overlays <projectId> [--store]` re-scans an existing project.
- **ffmpeg `boxblur`** caps chroma radius at a quarter of the region size (yuv420p): pass luma/chroma radii
  separately. ffmpeg errors now lead with the failing lines instead of the banner.

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

## 7. Next improvements (not built yet)

1. **Dev loop without image rebuilds:** a compose `dev` profile that mounts `apps/*/src` and runs `tsx watch`; most
   iterations here cost 1–3 min of rebuild + restart, which also interrupted jobs.
2. **ASR cache keyed by audio hash** in the cut search and evals: repeated verifications of the same seam are free.
3. **LLM I/O capture** (`DEBUG_LLM=1`): store prompt/response per stage call so an analysis run can be replayed and
   diffed (`reelsaw replay analyze <projectId>`), and build a selection eval from human-labelled moments.
4. **Stuck-job detector** in the reconciler: an active job past its expected duration becomes a visible event.
5. **More fixtures:** export every refused cut automatically (with consent) so `eval:cuts` grows from real failures.

## 8. Evals and regression cases

Every fixed bug should leave a case behind: `pnpm eval` runs all suites (selection, framing, overlays,
cuts, transcription, selection-model) against committed fixtures and baselines and exits non-zero on a
regression. How to run, add a case (reproduce → export → label → run → fix → `--update`) and where to
pull more data from: [EVALS.md](EVALS.md).
