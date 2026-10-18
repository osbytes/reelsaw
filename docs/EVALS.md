# Evals & regression tests

One runner, many suites. Every bug we fix should leave a case behind so it can't come back.

```sh
pnpm eval                                  # all suites (host; uses the repo .env, compose hosts → localhost)
pnpm eval selection framing overlays       # just these
pnpm eval --offline                        # skip suites that need models/network
pnpm eval cuts --update                    # accept current results as the new baseline
pnpm eval --list                           # suites and what they need
pnpm eval --json out.json                  # machine-readable report as well

# inside the stack (same models/paths as production; copy fixtures in first)
docker compose cp eval app:/data/eval
docker compose exec -e EVAL_DIR=/data/eval app node /app/server/dist/eval/run.js cuts
```

Each run prints a table per suite, writes `eval/reports/<time>.{md,json}` (gitignored) and compares with
`eval/baselines/<suite>.json` (in git). Exit code 1 means a **regression**: a case that passed in the
baseline fails now, or a summary metric got worse than its tolerance. Cases that fail in the baseline
too are *known issues*: they show as FAIL but don't break the run; fixing one shows up as "✓ improved".

Every model call a suite makes is metered (latency, tokens, cost when the provider reports it,
failures) and printed under the metrics as a `calls` line. Calls served from `eval/.cache` never reach
the meter, so a cached rerun shows `cached` rather than fake latencies.

## Comparing models and settings (matrix runs)

The same suites run once per **profile**, a named set of env overrides on top of the repo `.env`, and
end with one comparison table per suite: pass rate, the suite's quality metrics, wall time, LLM
calls / p50 / p95 / tokens, STT calls / p50 / realtime factor, and cost.

```sh
pnpm eval disfluency selection-model transcription --matrix eval/bench/models.json
pnpm eval selection-model --matrix eval/bench/models.json --profiles cloud-cheap,local-small
pnpm eval disfluency --set AI_MODEL=gateway:anthropic/claude-haiku-4.5      # one ad-hoc profile
pnpm eval transcription --matrix eval/bench/models.json --no-cache          # timing run: real calls
```

`eval/bench/models.json` is the starting grid (`{ "profiles": { "<name>": { "ENV": "value" } } }`):
cloud models through the Vercel AI Gateway (`gateway:<vendor>/<model>`, one `AI_GATEWAY_API_KEY`,
no token markup, per-request cost in the report), STT vendors directly (`deepgram:`, `groq:`,
`assemblyai:`), local models through `compat:` (Ollama) and `openai:` + `OPENAI_BASE_URL` (Speaches).
Keys stay in `.env`; a profile only names models and toggles. Edit the grid rather than growing it:
8–10 profiles (a few named stacks plus one-axis sweeps) answer most questions, a full cartesian product
does not.

Rules of a fair comparison:

- **Quality vs speed are separate runs.** Default runs read the cache, so a model's second run costs
  nothing and reports no latency. `--no-cache` makes every call real (results are still stored).
  Warm a local model once before a timed run (the first Ollama call includes loading the weights),
  run local profiles one at a time, and repeat timing runs 3× (report shows per-run p50/p95; take the
  median across runs by hand or from the JSON).
- **Profiles are not baselines.** Only the default `.env` run is compared with `eval/baselines/`;
  `--update` refuses to run with a matrix. Compare profiles with each other in the table.
- **Record what ran.** Cloud model aliases drift; the report JSON carries the profile env, the date,
  and per-call model ids. For local runs note hardware and `ollama --version` next to the report.
- **Gateway ids keep their vendor's options.** `gateway:openai/whisper-1` still gets OpenAI word
  timestamps and bias prompts (`underlyingProvider` in `ai/registry.ts`), so STT results are
  comparable with the direct `openai:` id apart from the extra hop.

Which suites say what about a model: `selection-model` (candidates per chunk, in-range / overlap /
weak-hook rates; a model that fails structured output shows more LLM calls than chunks, from the
plain-text fallback), `disfluency` (precision, recall, auto-applied false
positives), `transcription` (WER, entity recall, false insertions), `cuts` (clean cut rate with the
align model). `--json` keeps everything for a notebook.

### End-to-end stage timings

`pnpm --filter @reelsaw/server bench:e2e` runs the real pipeline on a whole video once per profile in
a second, isolated compose stack (`reelsaw-bench`: own image tag, volumes and ports, see
`eval/bench/compose.bench.yml`), so the stack you use is never restarted or re-pointed:

```sh
docker compose -p reelsaw-bench -f docker-compose.yml -f eval/bench/compose.bench.yml build app   # once per code change (ports are not needed to build)
pnpm --filter @reelsaw/server bench:e2e -- --matrix eval/bench/models.json --profiles cloud-cheap,local-qwen14 \
  --source "https://www.youtube.com/watch?v=9hSfOfgrl1I" --max-clips 3 [--repeat 3] [--out eval/bench/results/<name>]
```

Per profile it recreates the bench app container with the profile's env on top of `.env`, waits for
`/api/health`, signs up a throwaway user, creates a project from the URL, polls until done, and records:
seconds per stage from `stage.started` → last `stage.completed` (render: analyze done → project done),
the clips picked, the models that actually ran (`stage_artifacts.models`) and every LLM call with its
stage, latency and tokens (`LLM_TRACE=logs` in the bench stack). Output: one JSON per run plus
`summary.{md,json}` under `eval/bench/results/`. The ASR cache is cleared whenever a profile's
transcription model differs from the previous profile's (`--fresh-stt`: always), so each STT is paid
for and timed once; profiles that only change the language model reuse the cached transcript and
their transcribe cell reads `cached`. Ingest includes the download, so compare it across profiles only
loosely. Refine steps run alongside analyze, so stages do not sum to the total.

**Isolating steps.** A full run per profile re-downloads and re-transcribes the video even when only
the language model changed. `--steps refine,analyze` instead finishes one base project with the first
profile (or `--base-profile <name>`), then re-runs just those steps on that transcript under each
profile (`projects.refine`, `projects.reanalyze`; analyze includes rendering the new clips). Rows are
tagged `full` / `refine` / `analyze`; minutes per profile instead of a pipeline each, and the LLM is
the only thing that changes between rows. Transcription is compared with full runs (STT profiles) and
the `transcription` suite.

```sh
pnpm --filter @reelsaw/server bench:e2e -- --matrix eval/bench/models.json --profiles cloud-cheap,cloud-haiku,local-qwen14 \
  --steps refine,analyze --source "https://www.youtube.com/watch?v=9hSfOfgrl1I" --max-clips 3
pnpm --filter @reelsaw/server bench:e2e -- --rescan eval/bench/results/<dir>    # re-read LLM calls from the stack's logs
```

To watch runs in the bench UI (http://localhost:3200), set `BENCH_EMAIL` and `BENCH_PASSWORD` in the
shell before starting the driver: it signs in to that account (created on first use) instead of a
throwaway one, so the projects are yours to open.

Keep `eval/bench/results/<date>-<name>/` for sets worth comparing against later (they are small
JSON/markdown); day-to-day runs can go anywhere with `--out`.

**What the first set taught us** (`eval/bench/results/2026-10-17-initial/README.md` has the numbers):

- *Isolate the variable.* A full run per profile measures download + STT + LLM + ffmpeg together and
  the noise from the first three swamps a language-model change. Use `--steps` for LLM comparisons and
  full runs only for STT profiles; the suites (`disfluency`, `selection-model`) answer quality
  questions far cheaper than a pipeline run does.
- *Every profile must pin every model it depends on.* Cloud profiles that left `TRANSCRIPT_ALIGN_MODEL`
  to `.env` re-aligned each cut on the local Speaches model and render went from ~1 to 5–9 minutes,
  which read as "render is slow" until the LLM trace showed no LLM calls in that window. The grid now
  sets the align model in each profile.
- *Capability, not just speed.* `gpt-4o-transcribe` returns segments without word timestamps and the
  pipeline fails at "Transcription returned no words"; Sonnet was intermittently "No access to this
  model" on the gateway. A failed row is still a result: keep it, note why.
- *Slow local models hit job expiry.* The refine disfluency job expires after 30 minutes
  (`queueDefs` in `queue/boss.ts`); a 4B/14B model at ~40 s per verifier call with 50+ candidates on a
  20-minute video does not finish, so "refine 1800 s" means expired, not done. Either budget the
  verifier (batch candidates, cap calls per project) or treat `DISFLUENCY_LLM=false` as the local
  default; the bench should flag a stage equal to its queue expiry.
- *Rate limits are part of the profile.* The gateway's free tier allows 5 requests/min/model, which
  turns a 30 s refine into 10 minutes of 429 retries. Buy credits (or lower concurrency) before timing
  anything; the eval runner now recognises the credit-card / quota errors as "unavailable" and skips
  instead of failing cases one by one.
- *Cost is a column.* The gateway reports per-request cost in `providerMetadata`; the suite
  comparison shows it. The e2e bench only sees latency and tokens from the trace log, so add the
  gateway's cost to the trace line next.
- *Repeat for variance.* `--repeat` exists; one run per profile was enough to find the above but not
  to rank haiku vs sonnet on a 30 s stage. Three runs on the step rows is the next cheap win.

Not covered yet: a judged comparison of the clips two profiles pick from the same source (pairwise,
blind, fixed judge model), and gold labels from user decisions once the decision log exists.

## Suites

| suite | needs | what it checks |
|---|---|---|
| `selection` | nothing | transcript chunking (coverage, overlap, size), `05:28 → 528` timestamp repair, candidates snapping to sentence boundaries |
| `framing` | nothing (committed face samples) | split crops centre each speaker and stay clear of burned-in caption bands; tripod camera settles on the face, no fast pans; a speaker beside an app screen or title card is a `stack` with the panel on top (`panel` cases commit face boxes, text boxes and a divider probe per frame) |
| `overlays` | text model file + media | PP-OCR finds burned-in captions/handles on labelled frames; whole-video aggregation finds the overlays and does **not** flag scene text or people |
| `cuts` | align model (Speaches) | real hard disfluency cuts: result graded clean / kept / broken by transcribing the cut audio |
| `transcription` | STT + LLM, macOS `say` for audio | WER, entity recall and false insertions through the configured STT, vocabulary bias and correction |
| `selection-model` | LLM | one real map call per sampled chunk: candidates parse, land inside the chunk and snap; model-free quality proxies (in-range, overlapping, weak-hook rates) for comparing models |
| `disfluency` | nothing (`--offline`: rules only); LLM for the full pipeline | precision / recall / auto-applied false positives of disfluency detection on 50 reviewed real-transcript windows (user-accepted = cut, user-rejected = keep, plus hand-labelled emphasis and stutters). LLM calls are cached by prompt |

Known issues recorded in the baselines today:
- `disfluency`: discourse "like" fillers ("and like throwing a ball") and optional "that" are missed
  (recall 0.70); the verifier keeps them, which is the safe direction. One comma-separated quotative
  repeat ("he's like, he's like, son") is still proposed, for review only.
- `selection/apollo/snapping`: candidates whose end has no sentence boundary within 2.5 s keep a
  mid-sentence end (long 6–7 s sentences in podcasts).
- `overlays/frame-640s`: the "YT/APOLLO" handle is occluded by a mic.
- `overlays/aggregate-apollo-100-220`: with no scene cuts detected, a small text-like patch on a
  speaker's shirt becomes an "overlay" (blurring it would smudge the person).

## Fixtures

```
eval/
  fixtures/<suite>/…        case.json + small media (< 1 MB per case), in git
  baselines/<suite>.json    accepted results, in git
  .cache/                   materialised media + cached ASR/model calls (gitignored)
  reports/                  run reports (gitignored)
```

Big media never goes in git. A fixture names it as a **media source**:

```json
{ "id": "apollo-100-220", "url": "https://www.youtube.com/watch?v=9hSfOfgrl1I", "start": 100, "end": 220,
  "sha256": "…", "localPath": "/data/projects/<projectId>/source.mp4" }
```

`materialize()` produces `eval/.cache/media/<id>.mp4` from, in order: the cache, `localPath` (ffmpeg
stream copy, works inside the app container), or `yt-dlp --download-sections`. The sha256 is
informational (encoders drift); a mismatch is logged, not fatal. Derived data that is cheap to commit
and makes a case run offline (face samples, labelled JPEG frames, 6 s WAVs) is committed next to the case.

**Caching.** `ctx.cached(key, fn)` stores JSON results keyed by a hash of their inputs (audio bytes,
model id, options). The `cuts` suite drops from ~190 s to ~1 s on a rerun. Delete `eval/.cache/calls`
to force fresh model calls. LLM correction inside `transcription` and the aggregation in `overlays` are
deliberately not cached (they're what's being tested, or they call the model internally).

## Adding a case when a bug shows up

1. **Reproduce** in the app and find the ids (`reelsaw status <projectId>`, `reelsaw clip <clipId>`).
2. **Export** the smallest input that shows it:
   - bad cut: `reelsaw cuts <clipId> --fixture /data/fixtures` → `docker compose cp app:/data/fixtures/<id> eval/fixtures/cuts/<name>`
   - wrong overlay / framing: add frames to `eval/fixtures/overlays/frames/` (`ffmpeg -ss T -i source.mp4 -frames:v 1 -vf scale=960:-2 tT.jpg`)
     and labels to `labels.json`, or a `framing/<name>/case.json` with a media source + time range
     (face samples are generated on first run; commit `samples.json`)
   - selection: export the transcript (`transcripts.segments`) to `eval/fixtures/selection/<name>/transcript.json`
3. **Label the expectation** in `case.json` (`"expect": "clean"`, boxes that must/must not be covered,
   `maxOffset`, …) and write a one-line `note` saying what went wrong in the app.
4. **Run** `pnpm eval <suite>`: the new case should FAIL. Record it as a known issue with `--update`
   if the fix isn't happening now.
5. **Fix**, rerun until it passes and nothing else regresses, then `--update` and commit fixture +
   baseline together with the fix.

To add a suite: create `apps/server/src/eval/suites/<name>.ts` exporting a `Suite`
(`name`, `description`, `needs`, `run(ctx) → CaseResult[]`, optional `summarize`) and register it in
`suites/index.ts`. Use `materialize`, `ctx.cached`, `transcribeCached` (eval/asr.ts) and
`isUnavailable(err)` (skip, don't fail, when a model/server is down).

## Where to get more cases

No public benchmark covers long-video → shorts end to end (OpenShorts, ClipsAI, FunClip and AutoFlip
ship no eval sets), so our own fixtures stay the backbone. Public data worth pulling slices from:

- **Filler words:** [PodcastFillers](https://arxiv.org/abs/2203.15135) (Adobe, Interspeech 2022): ~35k
  annotated fillers plus breaths/laughter/repetitions in real podcasts, with timestamps. Good source of
  `cuts` cases (pick 6 s windows around "uh"/"um" and repetitions) and of a filler-detection precision /
  recall suite for `disfluency.ts`. [utils](https://github.com/gzhu06/PodcastFillers_Utils)
- **Video cropping / reframing:** [Apostolidis & Mezaris, ICIP 2021](https://rc.signalprocessingsociety.org/conferences/icip-2021/spsicip21vid109)
  publish a video-cropping benchmark with crops from 6 human annotators ([Zenodo](https://zenodo.org/record/5654152)):
  a `framing` suite variant scoring our crop window against human crops (IoU over time).
  [AutoFlip](https://research.google/blog/autoflip-an-open-source-framework-for-intelligent-video-reframing/) has no metrics, but its
  shot-boundary + per-shot camera-mode design is a good checklist for cases (static vs pan vs track).
- **Video text:** the [ICDAR 2013 video text](https://vision.ucsd.edu/node/674) data and the precision-recall protocol from
  Nguyen et al. (WACV 2014) for `overlays` detector recall; subtitle-specific benchmarks don't exist, so
  burned-in captions stay hand-labelled from real clip-channel uploads like this one.
- **Moment selection:** QVHighlights / UniVTG (see docs/RESEARCH.md B3) for query-conditioned highlight
  labels, useful once `focus` selection gets a precision@k suite. A vendor post proposes a manual
  [cross-tool test protocol](https://www.bytecap.io/blog/ai-video-clipper-benchmark-2026) (same sources, varied footage, graded on hook /
  standalone / publishability), a reasonable template for a periodic human-graded review.

Licensing: check each dataset's licence before committing derived media; keep only small slices and
reference the rest by URL.
