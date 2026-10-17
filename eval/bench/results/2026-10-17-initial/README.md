# Initial benchmark set, 2026-10-17

First pass over the model grid in `eval/bench/models.json`: the three model-facing suites per cloud
profile, then the real pipeline on one 20-minute video (https://www.youtube.com/watch?v=9hSfOfgrl1I,
3 clips) per profile, then refine and analyze re-run in isolation on one shared transcript.

Machine: Apple-silicon laptop, 12 cores, 36 GB, Docker Desktop. Local models: Ollama on the host
(`qwen2.5:14b`, `gemma3:latest` = 4B), Speaches on CPU (`faster-whisper-small` for transcription,
`faster-whisper-medium` for alignment). Cloud models through the Vercel AI Gateway (paid tier).

| file | what |
|---|---|
| `suites-cloud.json` | `transcription`, `disfluency`, `selection-model` suites × cloud profiles (`pnpm eval ... --matrix --no-cache --selection-chunks 4`) |
| `suites-cloud-best.json`, `suites-cloud-best-selection.json` | the same for `cloud-best`, re-run after fixing its STT (its first run hit "No access to this model" on the gateway) |
| `e2e/` | round 1: full pipeline, local profiles only |
| `e2e-2/` | round 2: full pipeline, cloud profiles + a clean gemma3 run |
| `e2e-steps/` | refine and analyze re-run per profile on the `cloud-cheap` transcript (`--steps refine,analyze`) |

## Headline numbers

Full pipeline, 20-minute source, 3 clips. Stage seconds are wall clock from the project's events;
refine runs alongside analyze so stages do not sum to the total.

| profile | total | × realtime | ingest | transcribe | refine | analyze | render |
|---|---|---|---|---|---|---|---|
| cloud-haiku | 206 s | 0.17 | 13 | 77 | 31 | 24 | 56 |
| cloud-gemini-flash | 301 s | 0.25 | 13 | 74 | 51 | 79 | 80 |
| cloud-cheap (gpt-4o-mini) | 682 s | 0.56 | 13 | 76 | 36 | 7 | 547¹ |
| local-qwen14 | 1193 s | 0.98 | 16 | 291 | 602 | 237 | 47 |
| local-gemma3 | 2199 s | 1.8 | 12 | 262 | 1801² | 98 | 22 |

¹ Render re-aligns every cut with `TRANSCRIPT_ALIGN_MODEL`, which the cloud profiles inherited from
`.env` (local `faster-whisper-medium` on CPU). With Ollama or Speaches busy that stage took 2–9
minutes in most cloud rows (547 s here; 514 s, 173–268 s in step rows) against ~20–30 s when the CPU
was idle. The grid now pins the align model per profile. ² The refine disfluency job's 30-minute
expiry, not a completion: gemma3 at 120–300 s per verifier call does not finish 44 calls.

Refine and analyze isolated on the same transcript (`e2e-steps/`; the LLM is the only variable).
`render after` is the clip re-render that follows refine (disfluency cuts changed the words), through
the local align model, so it measures the CPU, not the LLM.

| profile | refine stage | refine LLM (calls / total) | render after | analyze stage | analyze LLM (calls / total) |
|---|---|---|---|---|---|
| cloud-cheap (gpt-4o-mini) | 31 s | 36 / 56 s | 173 s | 10 s | 11 / 20 s |
| cloud-haiku | 32 s | 36 / 47 s | 268 s | 19 s | 17 / 60 s |
| cloud-best (sonnet-4.5) | 32 s | 36 / 79 s | 268 s | 48 s | 17 / 136 s |
| cloud-gemini-flash | 53 s | 35 / 159 s | 247 s | 109 s | 17 / 296 s |
| local-qwen14 | 481 s | 36 / 1464 s | 118 s | 207 s | 6 / 206 s |
| local-gemma3 | 1324 s³ | 14 / 5279 s (all failed) | 237 s | 81 s | 6 / 79 s |

³ Every gemma3 verifier call timed out at 300 s (14 calls, 0 tokens back); the step ended when the
disfluency job gave up, so the transcript kept its rule-based flags only.

Refine is bounded by the disfluency verifier: ~34 candidate windows on this video, one call each.
On cloud models the stage is ~30 s whatever the model (the calls are 1–2 s and run a few at a time);
on a local 14B each call is ~40 s and the stage is 8 minutes.

## Quality (suites)

`transcription` (synthesized speech, 5 cases; whisper-1 for every cloud row, so the difference is the
correction model):

| profile | pass | mean WER | entity recall | cost |
|---|---|---|---|---|
| cloud-cheap | 4/5 | 0.031 | 0.91 | $0.011 |
| cloud-haiku | 4/5 | 0.038 | 0.91 | $0.014 |
| cloud-gemini-flash | 4/5 | 0.038 | 0.91 | $0.015 |
| cloud-best | 4/5 | 0.038 | 0.91 | $0.020 |

`disfluency` (50 hand-labelled candidates; the rules pass is the same everywhere, the model decides
the ambiguous ones):

| profile | pass | precision | recall | wall | cost |
|---|---|---|---|---|---|
| cloud-cheap | 42/50 | 0.80 | 0.87 | 89 s | $0.007 |
| cloud-haiku | 41/50 | 0.82 | 0.78 | 87 s | $0.067 |
| cloud-gemini-flash | 44/50 | 0.87 | 0.87 | 271 s | $0.119 |
| cloud-best | 45/50 | 0.91 | 0.87 | 127 s | $0.202 |

`selection-model` (one real map call per 5-minute chunk, 4 chunks; are the proposed moments inside
the chunk, non-overlapping, with a real hook?):

| profile | pass | candidates/chunk | in range | overlapping | weak hooks | p50 call | cost |
|---|---|---|---|---|---|---|---|
| cloud-cheap | 1/4 | 4.5 | 0.17 | 0.72 | 0 | 3.2 s | $0.003 |
| cloud-haiku | 3/4 | 5.3 | 0.67 | 0.10 | 0.05 | 7.7 s | $0.031 |
| cloud-gemini-flash | 4/4 | 8.0 | 1.00 | 0.06 | 0.03 | 33.7 s | $0.069 |
| cloud-best | 4/4 | 5.5 | 0.86 | 0 | 0 | 15.6 s | $0.097 |

## What it says

- **Cloud is 5–10× faster than local CPU on this machine** (0.17–0.25× realtime vs 1–2×), and the
  gap is almost all refine: the disfluency verifier at ~40 s per call on a 14B model.
- **gpt-4o-mini is the wrong default for finding moments.** Cheapest and fastest, but 72% of its
  proposed moments overlap and only 17% land inside the chunk they were asked about; its clips on the
  e2e run were all from the first 90 seconds of the video. Haiku is the best cost/quality point,
  Sonnet the cleanest selector (no overlaps, 86% in range) at 3× Haiku's cost, Gemini Flash the most
  thorough but 4–5× slower per call because of long thinking outputs (26k output tokens on 4 calls).
- **Disfluency quality is close across cloud models** (precision 0.80–0.91, recall 0.78–0.87); the
  rules pass does most of the work. Cost differs 30× (gpt-4o-mini $0.007 vs Sonnet $0.20).
- **Transcription correction barely depends on the LLM**: same WER and entity recall for all four.
- **Local 4B is not viable for refine as shipped**; 14B is viable but slow. Batch the verifier or
  default `DISFLUENCY_LLM=false` on local stacks.
- **Pin every model a profile depends on.** The align-model leak cost more wall time than any LLM
  choice did.

## Caveats

One run per profile (no variance), one source video, 3 clips. Cloud e2e rows ran with the local
align model (see ¹); their render column is a CPU measurement. `cloud-best` in `e2e-2/` failed on
`gpt-4o-transcribe` (no word timestamps) and its suites first ran during a gateway "No access to
this model" window; both fixed and re-run (steps pass and `suites-cloud-best*.json`). Round-1 gemma3
transcribe reads 3.7 s because the stage resumed on cached chunks after a restart.
