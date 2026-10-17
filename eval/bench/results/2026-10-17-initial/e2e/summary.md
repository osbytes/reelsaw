# End-to-end bench 2026-10-17

Source: https://www.youtube.com/watch?v=9hSfOfgrl1I  
Clips requested: 3  
Machine: darwin 25.6.0 arm64, 12 cores, 36 GB, node v24.7.0  
Stack: compose project `reelsaw-bench` (eval/bench/compose.bench.yml), LLM_TRACE=logs, ASR cache cleared only when the transcription model changes between profiles (or with `--fresh-stt`)

Stage seconds are wall clock between `stage.started` and the last `stage.completed` of that stage (render: analyze done → project done). Ingest includes the download. Refine steps run in parallel with analyze, so stages do not add up to the total. Step rows (`refine`, `analyze`) re-ran only that step on the base project's transcript; their `total` is that step plus the re-render of its clips (refine re-renders clips whose words changed; analyze renders the clips it picked).

## Profiles

| profile | overrides |
|---|---|
| local-qwen14 | `AI_MODEL=compat:qwen2.5:14b` `OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1` `OPENAI_COMPATIBLE_API_KEY=ollama` `TRANSCRIPTION_MODEL=openai:Systran/faster-whisper-small` `OPENAI_BASE_URL=http://localhost:8000/v1` `OPENAI_API_KEY=local` |
| local-gemma3 | `AI_MODEL=compat:gemma3:latest` `OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1` `OPENAI_COMPATIBLE_API_KEY=ollama` `TRANSCRIPTION_MODEL=openai:Systran/faster-whisper-small` `OPENAI_BASE_URL=http://localhost:8000/v1` `OPENAI_API_KEY=local` |

## Timings

| profile | step | run | status | total | ingest | transcribe | refine | analyze | render | clips | llm calls | llm total | llm p50 | tokens in/out | language | transcription |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| local-qwen14 | full | 1 | done | 1193s | 15.5s | 291s | 602s | 237s | 46.7s | 3/3 | 46 | 2119s | 42.5s | 32k/7.5k | compat:qwen2.5:14b | openai:Systran/faster-whisper-small |
| local-gemma3 | full | 1 | done | 2366s | 444s | 3.7s | 1800s | 98.5s | 15.7s | 2/2 | 52 (31 failed) | 5531s | 18.6s | 24k/5.4k | compat:gemma3:latest | openai:Systran/faster-whisper-small |

## LLM calls by stage

| profile | run | stage | calls | total |
|---|---|---|---|---|
| local-qwen14 | 1 | refine.disfluency | 38 | 1740s |
| local-qwen14 | 1 | refine.entities | 2 | 142s |
| local-qwen14 | 1 | analyze | 6 | 236s |
| local-gemma3 | 1 | refine.disfluency | 44 | 5384s |
| local-gemma3 | 1 | refine.entities | 2 | 49.1s |
| local-gemma3 | 1 | analyze | 6 | 98.6s |

## Clips picked

### local-qwen14 · full #1 (done)

| # | range | len | score | layout | status | title | hook |
|---|---|---|---|---|---|---|---|
| 0 | 0:11–1:00 | 49s | 68 | mixed | done | Teacher's Lesson on Revenge | Success is the only revenge |
| 1 | 8:42–9:41 | 59s | 68 | face | done | Exceptional vs Average | Be Different |
| 2 | 14:46–15:41 | 55s | 67 | mixed | done | Risk vs Reward | Nothing to Lose |

### local-gemma3 · full #1 (done)

| # | range | len | score | layout | status | title | hook |
|---|---|---|---|---|---|---|---|
| 0 | 0:00–0:24 | 25s | 68 | face | done | Revenge Fantasy | Don't let them win. |
| 1 | 0:34–0:57 | 23s | 44 | mixed | done | Don't Just Fit In | Be exceptional, not average. |
