# Local CPU vs GPU, 2026-10-19

Same 20-minute source as the initial set
([Hormozi × Williamson](https://www.youtube.com/watch?v=9hSfOfgrl1I), 3 clips), same language model
(`qwen2.5:14b` via host Ollama) and same STT id (`Systran/faster-whisper-small`). The only
intentional differences:

| | `local-qwen14-cpu` | `local-qwen14-gpu` |
|---|---|---|
| Speaches image | `latest-cpu` with `CUDA_VISIBLE_DEVICES=` | `latest-cuda` (ctranslate2 saw 1 device) |
| Bench app | no GPU reservation | `bench:e2e --gpu` → NVENC (`FFMPEG_ENCODER=h264_nvenc`) |
| Encode | `FFMPEG_ENCODER=libx264` | `FFMPEG_ENCODER=h264_nvenc` |

Machine: Windows 11, Docker Desktop WSL2, NVIDIA GeForce RTX 3070 (8 GB), host Ollama
`qwen2.5:14b`. Speaches published on host port 18000 (8000 is reserved by Hyper-V on this box).
Driver: `pnpm bench:e2e` with the profiles in `eval/bench/models.json`.

| file | what |
|---|---|
| `local-qwen14-gpu-full-1.json` | full pipeline, CUDA Speaches + NVENC |
| `local-qwen14-cpu-full-1.json` | full pipeline, CPU Speaches + libx264 |
| `summary.{md,json}` | merged table |

## Headline numbers

Stage seconds are wall clock from project events. Refine runs alongside analyze, so stages do not
sum to the total. Both rows hit the refine disfluency job's 30-minute expiry (same local-14B
behaviour as the 2026-10-17 set).

| profile | total | ingest | **transcribe** | refine | analyze | render |
|---|---|---|---|---|---|---|
| local-qwen14-gpu | 4916 s | 1214 | **83.5 s** | 1801 | 1091 | 88.5 |
| local-qwen14-cpu | 3588 s | 1214 | **495 s** | 1802 | 1185 | 88.5 |

Realtime factors vs the 20:13 source (excluding the shared ~20 min YouTube ingest):

| profile | pipeline − ingest | × realtime |
|---|---|---|
| local-qwen14-gpu | 3702 s | 3.05× |
| local-qwen14-cpu | 2374 s | 1.95× |

(GPU total is higher because analyze LLM variance / retries; see caveats.)

## What the GPU changed

- **Transcription is the clear win.** `faster-whisper-small` on CUDA finished in **83.5 s** vs
  **495 s** on CPU (~**6×**). On a 20-minute source that is 0.07× realtime vs 0.41×.
- **Render wall clock looked the same (88.5 s)** for three short clips. Encode is a small slice of
  the render stage (face/layout, alignment, filters dominate). NVENC was selected on the GPU row
  (`FFMPEG_ENCODER=h264_nvenc`); a dedicated encode microbench would show the encoder gap more
  clearly than this full pipeline.
- **Refine still dies at 30 minutes** on local 14B either way (disfluency verifier). GPU does not
  help the language-model path when Ollama already uses the host GPU.
- **Ingest was ~20 minutes both times** (yt-dlp / YouTube), so it is not part of the acceleration
  story.

## Compared with the 2026-10-17 Mac CPU row

Initial set, `local-qwen14` on Apple silicon Speaches CPU: transcribe **291 s**. This Windows box on
CPU Speaches was slower (495 s, fewer Docker CPUs). The CUDA row (83.5 s) beats both.

## Caveats

- One run per profile (no `--repeat`); analyze LLM time swung (1091 s vs 1185 s) with failed calls
  (20 on GPU, 16 on CPU).
- Refine = queue expiry (1800 s), not a completed verifier pass.
- Speaches CPU leg forced `CUDA_VISIBLE_DEVICES=` because `docker-compose.gpu.yml` still attaches the
  device to Speaches when `COMPOSE_FILE` includes it; the CPU image will otherwise still see CUDA.
- Host Speaches port was 18000; profiles in git still say `:8000` (override with
  `BENCH_OPENAI_BASE_URL` / a local matrix when needed).
