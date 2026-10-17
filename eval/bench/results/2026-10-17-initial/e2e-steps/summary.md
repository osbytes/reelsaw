# End-to-end bench 2026-10-17

Source: https://www.youtube.com/watch?v=9hSfOfgrl1I  
Clips requested: 3  
Machine: darwin 25.6.0 arm64, 12 cores, 36 GB, node v24.7.0  
Stack: compose project `reelsaw-bench` (eval/bench/compose.bench.yml), LLM_TRACE=logs, ASR cache cleared only when the transcription model changes between profiles (or with `--fresh-stt`)

Stage seconds are wall clock between `stage.started` and the last `stage.completed` of that stage (render: analyze done → project done). Ingest includes the download. Refine steps run in parallel with analyze, so stages do not add up to the total. Step rows (`refine`, `analyze`) re-ran only that step on the base project's transcript; their `total` is that step plus the re-render of its clips (refine re-renders clips whose words changed; analyze renders the clips it picked).

## Profiles

| profile | overrides |
|---|---|
| cloud-cheap | `AI_MODEL=gateway:openai/gpt-4o-mini` `TRANSCRIPTION_MODEL=gateway:openai/whisper-1` |
| cloud-haiku | `AI_MODEL=gateway:anthropic/claude-haiku-4.5` `TRANSCRIPTION_MODEL=gateway:openai/whisper-1` |
| cloud-gemini-flash | `AI_MODEL=gateway:google/gemini-2.5-flash` `TRANSCRIPTION_MODEL=gateway:openai/whisper-1` |
| cloud-best | `AI_MODEL=gateway:anthropic/claude-sonnet-4.5` `TRANSCRIPTION_MODEL=gateway:openai/whisper-1` |
| local-qwen14 | `AI_MODEL=compat:qwen2.5:14b` `OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1` `OPENAI_COMPATIBLE_API_KEY=ollama` `TRANSCRIPTION_MODEL=openai:Systran/faster-whisper-small` `OPENAI_BASE_URL=http://localhost:8000/v1` `OPENAI_API_KEY=local` |
| local-gemma3 | `AI_MODEL=compat:gemma3:latest` `OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1` `OPENAI_COMPATIBLE_API_KEY=ollama` `TRANSCRIPTION_MODEL=openai:Systran/faster-whisper-small` `OPENAI_BASE_URL=http://localhost:8000/v1` `OPENAI_API_KEY=local` |

## Timings

| profile | step | run | status | total | ingest | transcribe | refine | analyze | render | clips | llm calls | llm total | llm p50 | tokens in/out | language | transcription |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cloud-cheap | full | 1 | done | 304s | 12.7s | 75.4s | 30.6s | 9.7s | 173s | 3/3 | 50 | 86.1s | 1.6s | 30k/6.7k | gateway:openai/gpt-4o-mini | gateway:openai/whisper-1 |
| cloud-haiku | refine | 1 | done | 300s |  |  | 31.7s |  | 268s | 3/3 | 36 | 46.9s | 1.2s | 20k/5.0k | gateway:anthropic/claude-haiku-4.5 | gateway:openai/whisper-1 |
| cloud-haiku | analyze | 1 | done | 534s |  |  |  | 19.3s | 514s | 3/3 | 17 | 59.7s | 1.8s | 29k/5.1k | gateway:anthropic/claude-haiku-4.5 | gateway:openai/whisper-1 |
| cloud-gemini-flash | refine | 1 | done | 299s |  |  | 52.5s |  | 247s | 3/3 | 35 | 159s | 3.6s | 14k/29k | gateway:google/gemini-2.5-flash | gateway:openai/whisper-1 |
| cloud-gemini-flash | analyze | 1 | done | 130s |  |  |  | 109s | 21.3s | 3/3 | 17 | 296s | 13.0s | 22k/54k | gateway:google/gemini-2.5-flash | gateway:openai/whisper-1 |
| cloud-best | refine | 1 | done | 299s |  |  | 31.6s |  | 268s | 3/3 | 36 | 78.6s | 2.0s | 20k/4.9k | gateway:anthropic/claude-sonnet-4.5 | gateway:openai/whisper-1 |
| cloud-best | analyze | 1 | done | 77.4s |  |  |  | 48.2s | 29.2s | 3/3 | 17 | 136s | 4.1s | 28k/5.5k | gateway:anthropic/claude-sonnet-4.5 | gateway:openai/whisper-1 |
| local-qwen14 | refine | 1 | done | 599s |  |  | 481s |  | 118s | 3/3 | 36 | 1464s | 36.0s | 13k/5.0k | compat:qwen2.5:14b | openai:Systran/faster-whisper-small |
| local-qwen14 | analyze | 1 | done | 725s |  |  |  | 207s | 519s | 3/3 | 6 | 206s | 32.4s | 13k/1.7k | compat:qwen2.5:14b | openai:Systran/faster-whisper-small |
| local-gemma3 | refine | 1 | done | 1561s |  |  | 1324s |  | 237s | 3/3 | 14 (14 failed) | 5279s | 302.3s | 0/0 | compat:gemma3:latest | openai:Systran/faster-whisper-small |
| local-gemma3 | analyze | 1 | done | 102s |  |  |  | 80.5s | 21.0s | 3/3 | 6 | 78.7s | 11.7s | 12k/2.4k | compat:gemma3:latest | openai:Systran/faster-whisper-small |

## LLM calls by stage

| profile | run | stage | calls | total |
|---|---|---|---|---|
| cloud-cheap | 1 | refine.entities | 2 | 4.8s |
| cloud-cheap | 1 | refine.disfluency | 34 | 54.0s |
| cloud-cheap | 1 | analyze | 14 | 27.4s |
| cloud-haiku | 1 | refine.entities | 2 | 3.7s |
| cloud-haiku | 1 | refine.disfluency | 34 | 43.0s |
| cloud-haiku | 1 | analyze | 17 | 59.6s |
| cloud-gemini-flash | 1 | refine.disfluency | 33 | 135s |
| cloud-gemini-flash | 1 | refine.entities | 2 | 24.6s |
| cloud-gemini-flash | 1 | analyze | 17 | 296s |
| cloud-best | 1 | refine.entities | 2 | 6.8s |
| cloud-best | 1 | refine.disfluency | 34 | 71.9s |
| cloud-best | 1 | analyze | 17 | 136s |
| local-qwen14 | 1 | refine.entities | 2 | 97.4s |
| local-qwen14 | 1 | refine.disfluency | 34 | 1367s |
| local-qwen14 | 1 | analyze | 6 | 206s |
| local-gemma3 | 1 | refine.disfluency | 11 | 3959s |
| local-gemma3 | 1 | refine.entities | 3 | 1319s |
| local-gemma3 | 1 | analyze | 6 | 78.7s |

## Clips picked

### cloud-cheap · full #1 (done)

| # | range | len | score | layout | status | title | hook |
|---|---|---|---|---|---|---|---|
| 0 | 1:32–2:00 | 28s | 68 | face | done | The Power of Having Nothing to Lose | Nothing to lose? You're dangerous! |
| 1 | 2:48–3:25 | 37s | 81 | face | done | Persistence Over Time | The secret to big achievements |
| 2 | 2:20–2:55 | 35s | 68 | face | done | Finding Strength in Solitude | Embrace your solitude |

### cloud-haiku · refine #1 (done)

| # | range | len | score | layout | status | title | hook |
|---|---|---|---|---|---|---|---|
| 0 | 1:32–2:00 | 28s | 68 | face | done | The Power of Having Nothing to Lose | Nothing to lose? You're dangerous! |
| 1 | 2:48–3:25 | 37s | 81 | face | done | Persistence Over Time | The secret to big achievements |
| 2 | 2:20–2:55 | 35s | 68 | face | done | Finding Strength in Solitude | Embrace your solitude |

### cloud-haiku · analyze #1 (done)

| # | range | len | score | layout | status | title | hook |
|---|---|---|---|---|---|---|---|
| 0 | 9:54–10:43 | 49s | 86 | face | done | Hard Is the Moat | If it's hard, no one else will |
| 1 | 0:00–0:49 | 50s | 86 | mixed | done | Teacher Stops Student's Revenge Fantasy Cold | Win so big they forget you exist |
| 2 | 9:11–10:05 | 54s | 85 | face | done | Having Nothing to Lose Makes You Dangerous | No resources equals infinite shots |

### cloud-gemini-flash · refine #1 (done)

| # | range | len | score | layout | status | title | hook |
|---|---|---|---|---|---|---|---|
| 0 | 9:54–10:43 | 49s | 86 | face | done | Hard Is the Moat | If it's hard, no one else will |
| 1 | 0:00–0:49 | 50s | 86 | mixed | done | Teacher Stops Student's Revenge Fantasy Cold | Win so big they forget you exist |
| 2 | 9:11–10:05 | 54s | 85 | face | done | Having Nothing to Lose Makes You Dangerous | No resources equals infinite shots |

### cloud-gemini-flash · analyze #1 (done)

| # | range | len | score | layout | status | title | hook |
|---|---|---|---|---|---|---|---|
| 0 | 9:46–10:15 | 30s | 92 | face | done | If It's Hard, Good. | This is what hard feels like. |
| 1 | 5:35–5:59 | 24s | 86 | face | done | Why You Must Master the Boring Middle | Master the boring middle |
| 2 | 19:02–19:33 | 31s | 80 | face | done | Define Your Story: Hero or Victim? | Winners make it happen |

### cloud-best · refine #1 (done)

| # | range | len | score | layout | status | title | hook |
|---|---|---|---|---|---|---|---|
| 0 | 9:46–10:15 | 30s | 92 | face | done | If It's Hard, Good. | This is what hard feels like. |
| 1 | 5:35–5:59 | 24s | 86 | face | done | Why You Must Master the Boring Middle | Master the boring middle |
| 2 | 19:02–19:33 | 31s | 80 | face | done | Define Your Story: Hero or Victim? | Winners make it happen |

### cloud-best · analyze #1 (done)

| # | range | len | score | layout | status | title | hook |
|---|---|---|---|---|---|---|---|
| 0 | 19:10–19:50 | 41s | 90 | face | done | The lonely chapter lasts 5 years not 90 seconds | Rocky montage: 90 seconds vs 5 years |
| 1 | 5:35–6:04 | 29s | 86 | face | done | Why people only cheer at the wrong times | They cheer when you don't need it |
| 2 | 9:01–9:45 | 45s | 80 | face | done | Nothing to lose makes you dangerous | Having nothing makes you incredibly dangerous |

### local-qwen14 · refine #1 (done)

| # | range | len | score | layout | status | title | hook |
|---|---|---|---|---|---|---|---|
| 0 | 19:10–19:50 | 41s | 90 | face | done | The lonely chapter lasts 5 years not 90 seconds | Rocky montage: 90 seconds vs 5 years |
| 1 | 5:35–6:04 | 29s | 86 | face | done | Why people only cheer at the wrong times | They cheer when you don't need it |
| 2 | 9:01–9:45 | 45s | 80 | face | done | Nothing to lose makes you dangerous | Having nothing makes you incredibly dangerous |

### local-qwen14 · analyze #1 (done)

| # | range | len | score | layout | status | title | hook |
|---|---|---|---|---|---|---|---|
| 0 | 9:11–10:05 | 54s | 78 | face | done | The Boring Middle | Winning happens alone in the boring middle |
| 1 | 0:00–0:53 | 54s | 72 | face | done | Teacher's Advice on Revenge | Success is the only revenge |
| 2 | 18:10–19:10 | 60s | 68 | mixed | done | Apology from Father | Middle Eastern father apologizes |

### local-gemma3 · refine #1 (done)

| # | range | len | score | layout | status | title | hook |
|---|---|---|---|---|---|---|---|
| 0 | 9:11–10:05 | 54s | 78 | face | done | The Boring Middle | Winning happens alone in the boring middle |
| 1 | 0:00–0:53 | 54s | 72 | face | done | Teacher's Advice on Revenge | Success is the only revenge |
| 2 | 18:10–19:10 | 60s | 68 | mixed | done | Apology from Father | Middle Eastern father apologizes |

### local-gemma3 · analyze #1 (done)

| # | range | len | score | layout | status | title | hook |
|---|---|---|---|---|---|---|---|
| 0 | 3:19–3:49 | 30s | 86 | mixed | done | The Lonely Chapter | Let them go. |
| 1 | 3:54–4:20 | 26s | 83 | face | done | Root for Yourself | Root for yourself first. |
| 2 | 1:53–2:13 | 20s | 82 | mixed | done | Success is the Revenge | Success is the only revenge. |
