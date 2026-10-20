# Evals & regression tests

One runner, many suites. Every bug we fix should leave a case behind so it can't come back.

```sh
pnpm eval                                  # all suites (host; uses the repo .env, compose hosts → localhost)
pnpm eval selection framing overlays       # just these
pnpm eval --offline                        # skip suites that need models/network
pnpm eval cuts --update                    # accept current results as the new baseline (refused while there are regressions)
pnpm eval cuts --update --accept-regressions "why this is fine"   # record them anyway; the reason is stored in the baseline
pnpm eval disfluency --split heldout       # one split of a suite that has them (never updates baselines)
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

`--update` writes the baseline only when the run has no regressions. With regressions it prints them,
leaves the file alone and exits 1; `--accept-regressions "<reason>"` overrides that and appends
`{ id | metric, reason, at }` to `acceptedRegressions` in the baseline JSON, so `git log` shows who
accepted a worse number and why. An `--offline` run of a suite whose result depends on the model
(`disfluency`: rules only) compares with and updates `baselines/<suite>.offline.json` instead.
A suite whose every case was skipped reports no metrics (nothing ran, so nothing regressed).

## Reading the numbers

- **Intervals.** A metric that is a ratio of counts (disfluency precision / recall) prints a Wilson 95%
  interval and its `n` next to the value, e.g. `precision 0.89  95% CI [0.67, 0.97] n=18`. Suites
  return it as `ratio: { k, n }` on the `SummaryMetric`; add it to any new count-based metric.
- **N < 10 is a smoke test.** Suites or splits with fewer than 10 trials behind a metric say "(n<10:
  smoke test)": they catch a crash or an obvious break, not a quality difference. Most suites here
  have 3 to 50 cases; treat their pass/fail as a tripwire rather than a measurement.
- **Overlapping intervals are not a ranking.** In a matrix run, two profiles whose intervals overlap
  are not ordered by their point estimates; with 50 cases the interval on a 0.9 rate is roughly
  +/- 0.1. Only claim "A beats B" when the intervals are disjoint, or after adding cases / repeats.
- **Dev vs heldout.** `disfluency` cases carry `split: "dev" | "heldout"` (assigned alternately within
  `cut` and `keep`, so both splits stay balanced) and the summary reports `dev.*` and `heldout.*` next
  to the overall numbers. **Rule: never read heldout cases while editing `disfluency.ts` or
  `pipeline/disfluency.ts`** (rules, prompt, thresholds). Tune on `--split dev`, run the full set once
  to check, and treat the heldout numbers as the honest ones; a dev score far above the heldout score
  means the rules were fitted to the cases. Once a heldout case has informed a change, move it to `dev`
  and add fresh heldout cases.
- **Uncertain labels.** A disfluency case whose label the text alone does not settle (a tag "right?",
  a hedge "sort of") carries `uncertain: true`: it runs and prints with its outcome marked `TP?` /
  `FP?` etc., but never counts in precision / recall and never fails as a regression. Prefer that to
  guessing a label.
- **Provenance.** Cases may carry `source: { url?, projectId?, userId?, decidedAt? }` (the video, the
  project and reviewer the label came from). The first 50 disfluency windows predate it and record
  none of these yet, so fill them in from the project when you touch a case; leave unknown fields out.
  Caption-diff cases (51 onwards) record the video url with `&t=` and a `note` saying how the label
  was made.

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
# Local CPU vs GPU (NVENC + Speaches CUDA): two runs, switch Speaches image between them
pnpm --filter @reelsaw/server bench:e2e -- --gpu --matrix eval/bench/models.json --profiles local-qwen14-gpu \
  --source "https://www.youtube.com/watch?v=9hSfOfgrl1I" --max-clips 3 --out eval/bench/results/<name>
# then: SPEACHES_IMAGE=…:latest-cpu docker compose --profile local-ai up -d speaches
pnpm --filter @reelsaw/server bench:e2e -- --matrix eval/bench/models.json --profiles local-qwen14-cpu \
  --source "https://www.youtube.com/watch?v=9hSfOfgrl1I" --max-clips 3 --fresh-stt --out eval/bench/results/<name>
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

Generated from the registry in `apps/server/src/eval/suites/index.ts` (`pnpm docs:gen`); `pnpm eval --list` prints the same.

<!-- generated:suites -->
| Suite | Needs | What it checks |
| --- | --- | --- |
| `selection` | nothing (runs offline) | chunking, timestamp repair and sentence snapping invariants on a real transcript; recall of creators' own short picks |
| `framing` | nothing (runs offline) | speaker crops centre faces and avoid burned-in text; tripod camera settles on the face |
| `scenes` | media | shot-cut detection on real footage (dark/low-contrast included): precision and recall vs hand-verified cuts |
| `pauses` | nothing (runs offline) | voice activity detection + pause trimming: inserted silences found and shortened to the target pause |
| `alignment` | nothing (runs offline) | wav2vec2 forced alignment: deleted words land inside cuts verified clean by ear; spans ordered and in bounds |
| `speakers` | media | active speaker detection (mouth motion × audio envelope synchrony) vs known talkers, incl. a drinking listener |
| `overlays` | media | burned-in captions/watermarks: per-frame detection recall and whole-video aggregation (no scene text) |
| `cuts` | models | disfluency jump cuts on real audio: removed cleanly, refused safely, or broken |
| `transcription` | models, media | WER + entity recall through the configured STT, bias and correction: synthetic `say` audio, and real speech graded against human captions |
| `disfluency` | nothing (runs offline) | disfluency detection precision/recall on reviewed real-transcript cases (rules + model) |
| `selection-model` | models | one real map call per sampled chunk: candidates inside the chunk, parseable, snappable |
<!-- /generated -->

### Notes on the older suites (hand-written)

| suite | needs | what it checks |
|---|---|---|
| `selection` | nothing | transcript chunking (coverage, overlap, size), `05:28 → 528` timestamp repair, candidates snapping to sentence boundaries; clips ending on a complete thought on word-level fixtures (`lonely-chapter`, see docs/SELECTION.md); the auto-mode score gate on synthetic stingy / generous / bimodal judges (`gate/*`: leader kept, sane share, affine invariance, absolute 45 shown collapsing a stingy judge) and PRP-Sliding-K placement with a fake judge (`pairwise/passes-*`); whether the picker finds the moments creators cut their own shorts from (`creator-picks/*`, below) |
| `framing` | nothing (committed face samples) | split crops centre each speaker and stay clear of burned-in caption bands; tripod camera settles on the face, no fast pans; a speaker beside an app screen or title card is a `stack` with the panel on top (`panel` cases commit face boxes, text boxes and a divider probe per frame); `shots` cases segment non-podcast sources (multi-camera talk show, screencast with a corner webcam, 4:3 interview, hands-only POV, 9:16 short) the way a render does and score them against hand-labelled windows |

Framing track tolerances are fractions of the source width (`maxErrFrac`, `maxPanFracPerSec` in `case.json`; 0.015625 and 0.625 equal 30 px and 1200 px/s on a 1920 px source), so a case means the same on any source size. The legacy `maxErrPx` / `maxPanPxPerSec` keys (1920 px pixels) still load and are converted. Face-size thresholds in the layout code are relative to the shorter source side, which is identical to the old height fractions for landscape input.

Framing `shots` cases (`kind: "shots"`) label time windows with the layout(s) a human editor would accept and, where a crop should follow people, their x positions (`faces`, left to right). The suite drops static faces, passes the source aspect and the case's `sceneCuts` (the cuts `media.detectScenes` finds on the clip, checked on contact sheets) to `segmentLayouts`, then requires `minAgreement` of the labelled time to agree and every crop within `faceTol` of its face. Windows marked `uncertain` (a wide three-person couch shot: fit the couch or split the talkers?) are shown with a `?` and never scored. `maxFaceFrames` bounds the share of sampled frames with any face box (for footage with no face), and `minCropWidth` the face crop's share of the width (a 9:16 source should stay near the identity). The summary's `worstShotAgreement` is the lowest agreement over these cases. Two cases fail on purpose and are recorded failing in the baseline, because the failures are real detector limits, not label problems: `shots-pov-hands-no-face` (UltraFace boxes round pans seen from above in 38% of the frames of a face-free POV clip) and `shots-screencast-corner-webcam` (a smaller on-screen copy of the streamer's face, right at the 0.08 second-face floor, turns the corner-webcam stack into a split). Frames (`t<sec>.jpg`, seconds in the materialised media) are committed only for CC BY sources; the vertical short is standard licence and is referenced by url and time only.

Scene-cut defaults (`SCENE_FLOOR`, `SCENE_RATIO` in `pipeline/scenes.ts`) were tuned on one dark podcast. The `scenes` suite now also covers bright footage, labelled by eye (4 fps contact sheet of the graded window, then frames at -0.3/-0.1/+0.1/+0.3 s around each candidate; never from detector output): `bradford-highlights-bright` (football highlights, CC BY; 9 hard cuts graded, motion-graphic ident and 6 dissolves excluded), `voa-news-package` (news b-roll and interviews, standard licence so url + time only; 37 hard cuts) and `sister-circle-studio` (multi-camera studio talk show, CC BY; 28 hard cuts in 0-120 s). Result with the current constants: recall 1.00 on all three; precision 1.00 on the football and studio cases and 0.93 on the news package, whose three false positives (104.0 s, 107.4 s, 125.0 s) are fast in-shot motion (a sweeping arm, a gimbal move, a hand covering the lens). So the constants held up on these three clips; they are still unvalidated on dark or very low-contrast footage other than apollo, and on cuts hidden inside a dissolve. A case may list `gradual: [[from, to], ...]` windows (dissolves, wipes, graphic transitions): a detection inside one is neither a hit nor a false positive and is shown as `inGradual`.
| `overlays` | text model file + media | PP-OCR finds burned-in captions/handles on labelled frames; whole-video aggregation finds the overlays and does **not** flag scene text or people |
| `cuts` | align model (Speaches) | real hard disfluency cuts: result graded clean / kept / broken by transcribing the cut audio |
| `transcription` | STT + LLM; macOS `say` for the synthetic audio; media for the real cases | WER, entity recall and false insertions through the configured STT, vocabulary bias and correction. 5 **synthetic** cases (`say`, one voice, fabricated name-dense text: they measure bias + correction, not recognition; the unprefixed summary metrics) and **real** cases (`source` set: 2-minute slices of real videos graded against the video's human caption track; `real.*` metrics: raw WER, WER after filler/repeat normalisation, names-only error rate, and `misheard`, how many of YouTube's own ASR misspellings the output repeats). See "Real-speech transcription cases" below |
| `selection-model` | LLM | one real map call per sampled chunk: candidates parse, land inside the chunk and snap; model-free quality proxies (in-range, overlapping, weak-hook rates) for comparing models |
| `disfluency` | nothing (`--offline`: rules only); LLM for the full pipeline | precision / recall / auto-applied false positives of disfluency detection on 98 real-transcript windows: 50 around the app's own proposals (user-accepted = cut, user-rejected = keep, plus hand-labelled emphasis and stutters) and 48 from caption diffs of two other videos, which are **not** drawn from the detector's proposals (see "Disfluency cases from caption diffs"). LLM calls are cached by prompt |

Known issues recorded in the baselines today:
- `disfluency`: discourse "like" fillers ("and like throwing a ball") and optional "that" are missed
  (recall 0.70); the verifier keeps them, which is the safe direction. One comma-separated quotative
  repeat ("he's like, he's like, son") is still proposed, for review only.
- `disfluency` (caption-diff cases 51-98, rules only): the repetition rule **auto-applies** cuts to
  grammatical or literal repeats the human captioner kept: "had had llamas", "thresholds that that
  allows for", "you'll see that that was", "dot dot" (the directory) and "run which which" (5 auto
  false positives, the costliest kind). Misses: "your way way around", "configures configuring", "why
  doesn't why don't", the false start "I think we I don't know" and "like, you know,". On these 44
  scored cases alone the rules reach precision 0.80 (20/25) and recall 0.80 (20/25); with the model
  (qwen2.5:14b) "like, you know," is caught, giving precision 0.81 (21/26) and recall 0.84 (21/25), and
  the five auto-applied false positives remain (the rule fires before the model sees them).
- `transcription` real cases (faster-whisper-small + qwen2.5:14b correction, 2026-10-18): Whisper
  writes the Tlaxcalans as "Lashkarlands" and the Totonacs as "Totonax"; with only the real title as
  metadata, entity recall is 0.36 (`real-dwarkesh-tlaxcalans` fails) and the project vocabulary lifts
  it to 0.64. `real-dwarkesh-conquistadors` fails at WER 0.29 because Whisper skipped about 25 s of
  speech near the start of the slice. Raw and normalised WER are almost equal (0.140 vs 0.139):
  Whisper itself writes nearly clean verbatim, so the disfluency gap shows only against YouTube's ASR.
  Names-only error rate 0.24 (27/114 proper-noun tokens).
- `selection/apollo/snapping`: segment-level only; apollo has no word timings, so its candidates can still end mid-sentence (word-level fixtures like `lonely-chapter` are covered by `finishThought`).
- `overlays/frame-640s`: the "YT/APOLLO" handle is occluded by a mic.
- `overlays/aggregate-apollo-100-220`: with no scene cuts detected, a small text-like patch on a
  speaker's shirt becomes an "overlay" (blurring it would smudge the person).
- `selection/creator-picks/*`: see "Creator picks" below for what the picker misses.

### Creator picks (`selection/creator-picks/*`)

Real "which moments" labels. Some podcasts publish the full episode and also vertical shorts cut
from it; the creator has already chosen the moments worth a short. Each fixture is one episode and
every short of it we could locate:

| fixture | episode | shorts → creator spans (s) | transcript | split |
|---|---|---|---|---|
| `dwarkesh-sheppard` | `LwQQ7nBCGSs` (Si Sheppard, 5843 s) | `B6FAMw8FgX4` 5630.5-5675.6, 5689.7-5731.6; `hjhJQXlQ6HQ` 3866.2-3990.2; `_hH7vnTWnq8` 4075.7-4095.5, 4157.4-4217.1, 4258.0-4299.6 | manual `en` track | dev |
| `huberman-kanoski` | `PXHRYbr3mp4` (7327 s) | `xZAsG5MShnk` 6375.8-6414.3 | auto `en-orig` | heldout |
| `lex-dhh` | `vagyIcmIGOQ` (#474 DHH, 2025, 22128 s) | `upeawiM1Sag` (a montage) 13623.0-13644.4, 13667.2-13683.0, 13803.6-13822.7, 13834.7-13877.0, 13904.6-14005.0, 14032.2-14088.3 | auto `en-orig` | dev |

**Labels.** `pnpm --filter @reelsaw/server creator-spans <episodeId> <shortId>… --fixture <name>`
(`apps/server/src/eval/tools/creator-spans.ts`) fetches the json3 auto-captions of the short and the
episode with yt-dlp, indexes every 5-gram of episode words, clusters the short's matching 5-grams by
offset, keeps clusters with ≥ 10 hits (real pieces have 11-305, coincidences 1-3) and snaps them to
word boundaries. Pieces ≤ 10 s apart in the episode are one moment with its pauses tightened; a small
piece joins a neighbour only if it also continues it seamlessly in the short (a sentence trimmed
mid-way). It writes `transcript.json` (segments from the manual track when the episode has one,
else from the auto track, pause-split because it has little punctuation) and `picks.json`
(`{shortId, hook: the short's title, spans}`; the title is a human reference for a later
hook-quality eval). Only ±10 min around the spans plus one 15 min stretch far from them (never the
first 5 min: cold opens replay the best moments) is kept, so the committed caption text stays small.

Traps:
- **Pick the episode by upload date.** DHH was on Lex twice; the 2026 episode `NYFGCESmikA` shares
  2 coincidental 5-grams with this short, the 2025 #474 `vagyIcmIGOQ` shares 502 (the 2026 count is from the sourcing check; this tool was not run against `NYFGCESmikA`).
- **Not every short of a channel aligns.** `RUoY5GCdONY` ("… - Si Sheppard", the plague) matches
  nothing in `LwQQ7nBCGSs` (zero 5-grams at any threshold): it is not cut from this episode despite
  the title. The tool prints a warning and leaves such a short out of `picks.json`. Voice-over or
  text-to-speech shorts fail the same way.
- **YouTube rate-limits caption fetches** (HTTP 429 after ~6 quick calls). The tool waits `--sleep`
  (default 12 s) before every fetch after the first and caches json3 + info under
  `eval/.cache/captions`, so reruns are free. It needs a current yt-dlp with `--js-runtimes node`
  (set `YTDLP_PATH`).

**Metrics** (per fixture, all creator spans of all its shorts):
- `recallAtN`: share of creator spans that one of our top N candidates matches with IoU ≥ 0.3,
  N = number of creator spans + 2. IoU is loose on purpose: a creator span can be 124 s while our
  clips are at most 60 s (best possible IoU 0.48).
- `bestRank`: rank of our best-placed candidate that matches any creator span (-1: none does).
- `matching` / `matchingKept`: candidates that match a creator span, and how many of them the
  relative score gate (`scoreGate`, analyze.ts, with the `.env` `ANALYZE_*` settings) keeps.
- `picksFound`: shorts with at least one span recalled.
- Summary: `creatorRecallAtN`, `creatorPicksFound`, `creatorGateKeepsMatches` as k/n ratios with
  Wilson intervals (n is tiny: read them as a smoke test).

A case passes when at least one creator span is in our top N and the gate keeps every candidate that
matches one. A miss is a finding about the picker, recorded as failing in the baseline, never fixed
by loosening the IoU. `passRate` covers only the invariant cases.

**Two ways to run.**
- `creator-picks/<name>`: model-free, on `candidates.json`, the real picker's ranked pool recorded
  from one run (model, judge, samples and date are in the file). Rank and gate are recomputed with the
  current code, so a gate change shows up offline.
- `creator-picks/<name>/live`: the real picker (chunk each window, map, second look when a window's picks leave a long uncovered tail,
  snap, pool, rubric scores, pairwise if the config enables it), mirroring `analyze()` without the
  database. Every model call goes through `ctx.cached` (the map key is shared with `selection-model`),
  so `--offline` replays a recorded run. It calls the model only with `--creator-picks live`, or
  `--creator-picks save`, which also rewrites `candidates.json`; otherwise a cache miss is a skip.

```bash
(cd apps/server && npx tsx src/eval/run.ts selection --creator-picks save)   # once, with Ollama up
(cd apps/server && npx tsx src/eval/run.ts selection --offline)              # replays / uses candidates.json
```

Recorded run (2026-10-18, `compat:qwen2.5:14b` on local Ollama, 1 score sample, no pairwise, as the
pipeline runs a self-hosted judge; 44 LLM calls, 51 min; `candidates.json` in each fixture):

| fixture | recall@N | N | best rank | gate keeps matches | our top N from the negative stretch |
|---|---|---|---|---|---|
| `dwarkesh-sheppard` | 1/6 (`_hH7vnTWnq8` 4076-4096 at rank 5) | 8 | 5 | 1/2 (fails) | 4 |
| `huberman-kanoski` | 0/1 | 3 | none | n/a | 1 |
| `lex-dhh` | 1/6 (13835-13877 at rank 5) | 8 | 5 | 1/1 | 2 |

Summary: recall@N 2/13 = 0.15 (95% CI 0.04-0.42), shorts with a span found 2/5. What it says:
- **The right moment, the wrong bounds.** Huberman: our rank-1 candidate (6397-6449, "Rewiring
  Cravings") is the creator's moment, but starts 21 s late and runs 35 s past it (IoU 0.23).
- **The judge cannot separate candidates.** One sample from a 14B model gives most candidates the same
  total (68); ties keep pool order, so rank among them is noise, and moments from the negative stretch
  (which the creator did not cut) fill a quarter to a half of the top N.
- **The relative gate collapses on ties.** With most totals equal, MAD = 0 and the threshold is the
  median: on Dwarkesh it drops a candidate matching the creator's "How Spain Got Rich" span (total
  39 against a threshold of 68).
- Long creator spans (the 124 s Spain short, the 100 s Lex piece) can only be matched loosely by a
  60 s clip; that is the length setting, not the picker.

Rerun with a cloud judge (`--set ANALYZE_JUDGE_MODEL=…`, 3 samples, pairwise) before drawing
conclusions about the prompt; these numbers describe the default local setup.
- `overlays/aggregate-sistercircle-0-300`: in a heavily cut talk show (about 80 shots in 300 s) the
  guest's name lower third is on screen in 8 close-ups and is still dropped, because the multi-shot rule
  asks for text in 20% of the sampled shots. The set screen ("Sister Circle LIVE") that is in every
  wide shot becomes a `caption` region: scene text that repeats in place across shots looks like an overlay.
- `overlays/aggregate-bradford-0-120`: the main camera is fixed, so stadium ad boards sit in the same
  place across shots and become regions; the "SBK"/"BANTAMS TV" bug is found by the aggregation but
  missed on single frames (`frame-bradford-*`).
- `overlays/aggregate-rpodcast-900-960`: a full-width title line at mid-height over a still image is
  never found: with no cuts, only the top 15% and bottom 40% of the frame are trusted.
- `overlays/aggregate-voa-ships-0-150`: news lower thirds (2 of about 40 shots) are not found; the VOA
  bug is.
- `speakers/oxford-*`: an off-camera interviewer cannot be attributed: with one face on screen the
  timeline stays on the visible person (agreement equals her share of the talking).
- `speakers/sistercircle-couch-smiling-listener` passes with confidence 0: no frame had a clear
  leader, so it is the initial pick that is right, not evidence.

Fixtures from other sources than the Apollo podcast (October 2026; CC BY, frames committed at 960 px
under `overlays/frames/<video>/`, except the VOA package, which is referenced by URL and time only):
Sister Circle `uYFjIHelrH0` (talk show: lower thirds, round corner bug, a sweatshirt print and a set
screen as scene text), MrUniverse Oxford `jd5bCpWWBXA` (street interview, captions centred low at
y 0.89-0.95, not bottom-right as first reported), Valsorda `YNzgRNsB9UA` (live-coding: title strip is
the overlay, the code is content, presentation expected), Bradford City `F_FQy5Syc3A` (bug plus ad
boards), R Podcast `GzCeABCU3Gk` (title band over a still), VOA `AK0A6L6-agU` (news package). Frame
labels may carry `video` (their source) and the `lower-third` kind; only frames without `video` feed
the original Apollo metrics and the mask-residual check, while `overlayRecall` (required burned-in
labels found) and `rawPrecision` (share of detected boxes on burned-in text; scene text lowers it by
design) cover every frame. Aggregate `expectOverlays` entries can name the expected `kind`.
Speaker cases can set `expectUnsure` (three people in the shot: pass only when the detector returns
no runs); truth only covers confident turns of 3 s or more, so hand-overs are not scored. Turns come
from auto-caption word timings (and `>>` speaker marks) checked against lip motion in face crops.

## What CI runs

`.github/workflows/ci.yml` (job `check`) runs, on every PR and on main:

1. `pnpm --filter @reelsaw/server test:unit`: every file in `apps/server/test` that does **not** import
   `./helpers.js` (`scripts/unit-tests.mjs` filters by that import; today 21 of 31 files). Files that
   import it need the app at `REELSAW_URL` and Postgres on 127.0.0.1:5432, and drive `docker compose
   exec`. A new test that needs no stack should simply not import helpers.
2. `pnpm --filter @reelsaw/server models:download` (cached by `actions/cache`, keyed on
   `scripts/download-models.sh`), then `pnpm --filter @reelsaw/server eval:offline`: all suites
   with `--offline`. Suites that need an LLM/STT (`cuts`, `selection-model`, `transcription`) are
   skipped; suites whose source video is not in git (`scenes`, `speakers`, the overlay aggregates) skip
   those cases; the rest (selection, framing, pauses, alignment, overlay frames, disfluency rules)
   run and are compared with the baselines, and a regression fails the build.

### Stack tests in CI

Not enabled; a commented `stack` job sits at the bottom of `ci.yml`. The 10 stack test files
(accounts, hosted, import, mcp, project-settings, render-completion-deadlock, report,
sampling-concurrency, settings, search) are only run by hand against a local deploy. What blocks
turning it on, none of which could be verified without running Docker:

- **Never run in CI.** `docker compose up --build` of the root `docker-compose.yml` needs a throwaway
  `.env` (`BETTER_AUTH_SECRET`, `APP_URL`, `PORT=3100`) and a ~10 minute image build; it has not been
  confirmed that the app starts and passes `/api/health` with no AI provider configured (the local
  setup refuses to start without an Ollama endpoint by design, so check the startup gate first).
- **Helpers assume the author's host.** `test/helpers.ts` reads the Postgres password from `.env`, uses
  `docker compose exec -T app reelsaw …` and `docker compose cp` from the repo root, and BASE defaults
  to `localhost:3100`. In CI the compose project name, published ports and `.env` must match.
- **Tests that call models** (anything that creates a project from a real URL) cannot run without
  provider keys; they would need to be split out or given the mock in `scripts/mock-ai.mjs`.

When it works locally in a clean checkout with only that throwaway `.env`, uncomment the job.

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
informational for suites whose labels tolerate a re-encode (a mismatch is logged); suites with
sub-second labels (`scenes` cut times, `speakers` turns) pass `strictSha: true` to `materialize()`; with `EVAL_STRICT_MEDIA=1` a mismatch then fails the case instead of warning (default: warn, because yt-dlp's encode differs per machine and version: two runs on one laptop gave two hashes for the same section), and
a mismatch there **fails the case** (`MediaDriftError`) instead of producing numbers against shifted
labels. (`alignment`, `cuts` and `pauses` commit their WAVs, so there is no download to drift.) Derived data that is cheap to commit
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

## Disfluency cases from caption diffs

The first 50 disfluency cases are windows around candidates the detector itself proposed, so they
cannot show a disfluency the detector never proposes (recall is measured only over what it already
finds). Cases 51+ come from somewhere else: YouTube videos that have both an ASR caption track
(`en-orig`: verbatim, word timings, every um and restart) and a human track (`en`: clean verbatim).
The words a human editor dropped are disfluency **candidates**; the words the editor kept although
they look like disfluencies ("very, very", "had had", "dot dot") are `keep` candidates.

```bash
cd apps/server
npx tsx src/eval/tools/caption-diff.ts <videoId> --dir /tmp/caps --out cands.json          # dropped words
npx tsx src/eval/tools/caption-diff.ts <videoId> --dir /tmp/caps --kept --out kept.json    # kept look-alikes
```

The tool fetches both tracks with yt-dlp (`YTDLP_PATH`; the human track with `--write-subs` only, so a
video without one fails instead of diffing ASR against ASR; it sleeps 10 s between fetches because
YouTube rate-limits captions), aligns them with a word-level LCS over normalised words, and writes
each candidate as a ±30-word ASR window with timings and a `target`, the shape of a fixture.

A candidate is not a label. Read each one with the human track's text next to it and decide:
`cut` for a filler, a repeat or a false start; `keep` when the editor dropped a real word for brevity
(a sentence-initial "And", "to go capture" → "to capture") or kept emphasis; `uncertain: true` when
the text alone cannot say (a tag "right?", a hedge "sort of"). Target the earlier copy of a repeat,
as the older cases do. Keep `cut` and `keep` roughly balanced and assign `split` alternately within
each. Commit only the window words, never the whole track. Sources so far: Dwarkesh Patel × Si
Sheppard `LwQQ7nBCGSs` (host and guest) and Missing Semester lecture 1 `MSgoeuMqUmU` (lecturers and a
student).

## Real-speech transcription cases

The synthetic `transcription` cases are one TTS voice reading text written for the test, so they say
nothing about recognising real speech. Real cases are 120 s slices of videos with a human English
caption track: `source` (url + start/end, materialised by the framework like any media case), `text`
= the human track's words inside the window (`caption-diff.ts <id> --ref <start>-<end>`), real
`meta` (title, uploader, tags) and, where YouTube's own ASR misspelled names in the window,
`corrections: [{ heard, expected }]`. Human tracks are clean verbatim, so the suite reports both the
raw WER and the WER after dropping um/uh/er and collapsing immediate 1-3 word repeats on both sides;
the gap between them is the share of the error that is disfluency, not mis-recognition. The
names-only error rate takes the proper nouns from the reference (capitalised words that do not start
a sentence) and counts how many the aligned output got wrong. A `vocabulary` field on a case is
passed to entity extraction like a project's vocabulary, so a pair of cases on the same audio (with
and without it) measures what the vocabulary step buys.

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
