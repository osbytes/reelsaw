# End-to-end bench 2026-10-19 (local CPU vs GPU)

Source: https://www.youtube.com/watch?v=9hSfOfgrl1I
Clips requested: 3
See README.md in this folder for machine notes and interpretation.

| profile | step | run | status | total | ingest | transcribe | refine | analyze | render | clips | llm calls | language | transcription |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| local-qwen14-gpu | full | 1 | done | 4916s | 1214s | 83.5s | 1801s | 1091s | 88.5s | 3/3 | 59 (20 failed) | compat:qwen2.5:14b | openai:Systran/faster-whisper-small |
| local-qwen14-cpu | full | 1 | done | 3588s | 1214s | 495s | 1802s | 1185s | 88.5s | 3/3 | 54 (16 failed) | compat:qwen2.5:14b | openai:Systran/faster-whisper-small |
