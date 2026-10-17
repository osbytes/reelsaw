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
| cloud-best | `AI_MODEL=gateway:anthropic/claude-sonnet-4.5` `TRANSCRIPTION_MODEL=gateway:openai/gpt-4o-transcribe` |
| local-gemma3 | `AI_MODEL=compat:gemma3:latest` `OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1` `OPENAI_COMPATIBLE_API_KEY=ollama` `TRANSCRIPTION_MODEL=openai:Systran/faster-whisper-small` `OPENAI_BASE_URL=http://localhost:8000/v1` `OPENAI_API_KEY=local` |

## Timings

| profile | step | run | status | total | ingest | transcribe | refine | analyze | render | clips | llm calls | llm total | llm p50 | tokens in/out | language | transcription |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cloud-cheap | full | 1 | done | 682s | 13.3s | 75.6s | 36.0s | 7.3s | 547s | 3/3 | 47 | 75.7s | 1.5s | 28k/6.3k | gateway:openai/gpt-4o-mini | gateway:openai/whisper-1 |
| cloud-haiku | full | 1 | done | 206s | 12.7s | 77.4s | 31.2s | 24.0s | 56.2s | 3/3 | 53 | 111s | 1.3s | 48k/9.6k | gateway:anthropic/claude-haiku-4.5 | gateway:openai/whisper-1 |
| cloud-gemini-flash | full | 1 | done | 301s | 13.3s | 74.3s | 50.6s | 78.9s | 80.2s | 3/3 | 53 | 384s | 4.7s | 37k/76k | gateway:google/gemini-2.5-flash | gateway:openai/whisper-1 |
| cloud-best | full | 1 | failed | 234s | 13.3s |  |  |  |  | 0/0 |  |  |  |  | gateway:anthropic/claude-sonnet-4.5 | gateway:openai/gpt-4o-transcribe |
| local-gemma3 | full | 1 | done | 2199s | 12.2s | 262s | 1801s | 98.1s | 22.3s | 3/3 | 53 (31 failed) | 5536s | 19.8s | 24k/5.4k | compat:gemma3:latest | openai:Systran/faster-whisper-small |

## LLM calls by stage

| profile | run | stage | calls | total |
|---|---|---|---|---|
| cloud-cheap | 1 | refine.entities | 2 | 4.7s |
| cloud-cheap | 1 | refine.disfluency | 34 | 50.9s |
| cloud-cheap | 1 | analyze | 11 | 19.5s |
| cloud-haiku | 1 | refine.entities | 2 | 3.4s |
| cloud-haiku | 1 | refine.disfluency | 34 | 42.7s |
| cloud-haiku | 1 | analyze | 17 | 64.6s |
| cloud-gemini-flash | 1 | refine.entities | 2 | 16.8s |
| cloud-gemini-flash | 1 | refine.disfluency | 34 | 134s |
| cloud-gemini-flash | 1 | analyze | 17 | 233s |
| local-gemma3 | 1 | refine.disfluency | 44 | 5384s |
| local-gemma3 | 1 | refine.entities | 2 | 53.8s |
| local-gemma3 | 1 | analyze | 7 | 98.1s |

## Clips picked

### cloud-cheap · full #1 (done)

| # | range | len | score | layout | status | title | hook |
|---|---|---|---|---|---|---|---|
| 0 | 0:00–0:22 | 22s | 58 | mixed | done | Hard Work Equals Worth | If it's hard, it's worth it! |
| 1 | 0:32–0:53 | 22s | 65 | mixed | done | Rooting for Yourself Matters | Be your own biggest fan! |
| 2 | 0:54–1:24 | 30s | 58 | mixed | done | The Lonely Chapter Explained | Ever felt alone in growth? |

### cloud-haiku · full #1 (done)

| # | range | len | score | layout | status | title | hook |
|---|---|---|---|---|---|---|---|
| 0 | 10:04–10:33 | 29s | 88 | mixed | done | Everything Worth Doing Is Hard—That's How You Know It's Worth It | If it's hard, good. No one else will do it. |
| 1 | 2:00–2:43 | 44s | 83 | mixed | done | The lonely chapter explained | Growing means losing your old friends |
| 2 | 15:50–16:48 | 58s | 81 | mixed | done | Extend Your Time Horizon to Access Opportunity | Just extend the time horizon |

### cloud-gemini-flash · full #1 (done)

| # | range | len | score | layout | status | title | hook |
|---|---|---|---|---|---|---|---|
| 0 | 9:46–10:15 | 30s | 75 | face | done | Embrace The Hard: Your Path To Success | If it's hard, that's good. |
| 1 | 5:12–6:04 | 52s | 85 | face | done | Mastering The Soul-Crushing Middle | Embrace the lonely middle |
| 2 | 17:40–18:37 | 57s | 74 | face | done | Why an "Okay" Life is Terrifying | An "okay" life is terrifying. |

### cloud-best · full #1 (failed: Transcription returned no words. Is the audio silent?)

(no clips)

### local-gemma3 · full #1 (done)

| # | range | len | score | layout | status | title | hook |
|---|---|---|---|---|---|---|---|
| 0 | 1:21–1:44 | 23s | 85 | face | done | Thinking for Yourself | Question everything. |
| 1 | 1:56–2:21 | 25s | 80 | mixed | done | Asian Parent Pressure | Breaking generational cycles. |
| 2 | 1:02–1:23 | 21s | 65 | face | done | The Uncomfortable Truth | They’ll stop cheering when you win. |
