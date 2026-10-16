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

## Suites

| suite | needs | what it checks |
|---|---|---|
| `selection` | nothing | transcript chunking (coverage, overlap, size), `05:28 → 528` timestamp repair, candidates snapping to sentence boundaries |
| `framing` | nothing (committed face samples) | split crops centre each speaker and stay clear of burned-in caption bands; tripod camera settles on the face, no fast pans |
| `overlays` | text model file + media | PP-OCR finds burned-in captions/handles on labelled frames; whole-video aggregation finds the overlays and does **not** flag scene text or people |
| `cuts` | align model (Speaches) | real hard disfluency cuts: result graded clean / kept / broken by transcribing the cut audio |
| `transcription` | STT + LLM, macOS `say` for audio | WER, entity recall and false insertions through the configured STT, vocabulary bias and correction |
| `selection-model` | LLM | one real map call per sampled chunk: candidates parse, land inside the chunk and snap |
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
