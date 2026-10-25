<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.png">
    <img src="docs/assets/logo-light.png" alt="Reelsaw" width="300">
  </picture>
</p>

# Reelsaw

<p align="center">
  <a href="https://www.osbytes.io" target="_blank" rel="noopener noreferrer" title="osbytes — open source bytes"><img src="https://www.osbytes.io/badge.svg" alt="osbytes — open source bytes" width="24" height="24"></a>
  <a href="https://github.com/osbytes/reelsaw/releases"><img src="https://img.shields.io/github/v/release/osbytes/reelsaw?label=release" alt="Latest release"></a>
  <a href="https://github.com/osbytes/reelsaw/actions/workflows/ci.yml"><img src="https://github.com/osbytes/reelsaw/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/osbytes/reelsaw"><img src="https://api.scorecard.dev/projects/github.com/osbytes/reelsaw/badge" alt="OpenSSF Scorecard"></a>
  <a href="https://github.com/osbytes/reelsaw/pkgs/container/reelsaw"><img src="https://img.shields.io/badge/ghcr.io-osbytes%2Freelsaw-2496ED?logo=docker&logoColor=white" alt="Docker image on GHCR"></a>
  <a href="https://glama.ai/mcp/servers/osbytes/reelsaw"><img src="https://glama.ai/mcp/servers/osbytes/reelsaw/badges/score.svg" alt="Glama MCP server score"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/osbytes/reelsaw" alt="License: AGPL-3.0"></a>
</p>

Self-hosted, AI-powered long-form → short-form video clipper. Paste a YouTube link or upload a video; Reelsaw transcribes it, asks an LLM for the most clippable moments, then renders vertical 9:16 clips with word-highlight captions and a hook overlay. A hosted service at [app.reelsaw.com](https://app.reelsaw.com) runs the same code (Free, then $12 / $29 / $59 a month, metered in source minutes).

Pure TypeScript. Any AI vendor via the [AI SDK](https://ai-sdk.dev). One-step deploy with Docker Compose.

<p align="center">
  <img src="docs/assets/pipeline.gif" alt="Animated walkthrough of the pipeline: a video is ingested, transcribed in parallel chunks, refined by three jobs, its best moments are ranked pairwise, and five vertical clips are rendered; a worker restarts mid-render and resumes from its last checkpoint" width="920">
</p>
<p align="center">
  <sub>One video through the five queues: ingest → transcribe → refine ×3 → pick moments → render. A worker restarts mid-render and resumes from its last save. <a href="docs/assets/pipeline.mp4">Full-quality MP4</a>, or <a href="https://reelsaw.com/#how-it-works">play it on reelsaw.com</a>.</sub>
</p>

<p align="center">
  <img src="docs/assets/workspace.png" alt="Project workspace with source player, transcript, and rendered clips" width="920">
</p>

<p align="center">
  <video src="docs/assets/demo-framing.mp4" poster="docs/assets/demo-framing-poster.jpg" width="280" controls playsinline>
    <a href="docs/assets/demo-framing.mp4">demo-framing.mp4</a>
  </video>
</p>
<p align="center">
  <sub>Auto reframing in one clip: split → face → stack → fit</sub>
</p>

<p align="center">
  <img src="docs/assets/editor.png" alt="Clip editor with 9:16 preview, captions panel, and multi-lane timeline" width="450">
  &nbsp;
  <img src="docs/assets/transcript-fixes.png" alt="Transcript with filler cuts and the fixes list" width="450">
</p>

## Features

**Pipeline**

- **Any AI vendor** – language model, transcription model and caption-alignment model are each a `provider:model` string: OpenAI, Anthropic, Google, Groq, Deepgram, AssemblyAI, Vercel AI Gateway, or any OpenAI-compatible server (Ollama, vLLM, LM Studio, local Whisper servers). Fully local with no API keys is supported.
- **Research-backed clip selection** – map → pool → rank: the transcript is chunked at long pauses with 20% overlap (no "lost in the middle" on long videos), every standalone moment is collected per chunk in parallel, candidates are snapped/deduped, then scored on a rubric (hook / value / flow / shareability, plus relevance with a focus) as the median of k samples, and the top 10 get K sliding pairwise head-to-head passes (PRP-Sliding-K; `ANALYZE_PAIRWISE_PASSES`, default 3 so the top 3 you see first are placed reliably) with positions swapped to cancel judge bias. Cost: at most Σ(n−1−p) pairs × 2 calls, i.e. 48 calls for the top 10 with 3 passes (18 with 1); pairs met twice are judged once. No target count: in auto mode weak picks are dropped by a gate relative to the run, not a fixed number, because pointwise scores do not transfer between judge models: a clip is dropped below max(`ANALYZE_MIN_SCORE_FLOOR` = 25, median − `ANALYZE_SCORE_MAD_K` = 1 × MAD) of the pooled rubric totals, and the best clip is always kept (`ANALYZE_SCORE_RULE=absolute` restores the old fixed 45). The threshold and its median/MAD are in the project's `candidates` artifact. Candidates whose scoring failed are never compared with rubric totals; they only fill in when fewer than 3 scored clips survive. Optional "at most N" cap, and "Find clips about …" keeps only on-topic moments. Click a clip's score for the breakdown. `ANALYZE_JUDGE_MODEL` lets a different model score and compare (less self-preference than judging its own hooks). `ANALYZE_CONCURRENCY`, `ANALYZE_SCORE_SAMPLES`, `ANALYZE_PAIRWISE` tune cost (auto: 1 call at a time, 1 sample, no pairwise for a self-hosted judge; 4 / 3 / on for cloud).
- **Clean transcripts** – names are fixed from vocabulary hints and a constrained LLM correction, and fillers, repetitions and false starts are cut with jump cuts. Every cut is located by forced alignment and checked by listening to the seam, so karaoke highlights land on the syllable. Each fix shows inline in the transcript with accept/reject, and long pauses can be shortened (details below).
- **Smart 9:16 reframing** – UltraFace (1.2 MB ONNX, CPU, ~7 ms/frame via `onnxruntime-node`) samples each clip at 4 fps and picks a layout per segment (clips are split at scene cuts and face-presence changes, so a picture-in-picture intro can be "fit" and the talking head after it "face"; shot cuts are detected on every clip, and a multi-camera edit that alternates a close-up with a wide shot every second or two changes layout at each cut): **face** (crop follows the speaker with "heavy tripod" smoothing: dead zone, capped pan speed, instant snap at scene cuts), **split** (two speakers stacked), **stack** (slides/screen on top, the webcam tile below — the picture-in-picture box of a Zoom, Teams, Meet or OBS recording, not a face-sized crop that reaches into the slides), or **fit** (whole frame over a blurred background when there is no face, e.g. graphics and b-roll, or when three or more people share the frame). With two people in a wide shot the crop follows whoever is talking (mouth motion correlated with the audio envelope, minimum 2.5 s per shot), falling back to a split when detection isn't confident. Override per project, per clip or per section, including a hand-set crop. Reference for every layout, its triggers, caveats and fixtures: [docs/LAYOUTS.md](docs/LAYOUTS.md).
- **Captions** – AI-picked key words per clip coloured and enlarged (editable in the editor), readability limits (≈2 short lines, comma/sentence breaks, a line stays up long enough to read: at least 0.7 s, 0.3 s per word and 20 characters per second), ASS karaoke word highlight (any colour), boxed, or outlined; size, words on screen (1 = one word at a time), uppercase; hook overlay with its own duration. Caption and hook positions are free x/y set by dragging on a live 9:16 preview that uses the renderer's crop math and font metrics, with a platform safe-zone overlay. Project-wide defaults, per-clip overrides. Burned in with ffmpeg + libass.

**Editing**

- **Workspace and clip editor** – source player and clickable transcript on the left, clips streaming in on the right as they render, with score, layout badge, post caption + hashtags copy and download. The editor has a live preview of the source with the clip's framing and captions and a multi-lane timeline (ruler, transcript words, clip range, layout track, layers) with zoom, snapping to words/scene cuts/playhead, nudge buttons, typed timestamps and I/O keys for frame-accurate trims. Split the layout track (⌘/Ctrl+B, the Split button, a double-click or the right-click menu) into sections that are Auto or forced to face/split/stack/fit/centre; drag the picture to re-centre a section; right-click for Set crop… (a box on the source, or `crop` / `crop2` / `contentCrop` on `update_clip`); "Use for all clips…" copies one clip's framing to the project (`apply_framing`). Add, drag and remove transitions; ⌘/Ctrl+Z / ⇧⌘Z undo and redo every edit.
- **Deletes can be undone** – deleting a project stops its work and hides it, with an Undo in the toast; it stays restorable for `DELETED_RETENTION_DAYS` (7) before its files are removed. Re-picking moments keeps every clip you made or edited (text, bounds, framing, style, intro/outro) and only replaces untouched AI picks, which can be restored too. Single clips can be deleted and restored the same way. The same through MCP (`delete_clip`, `restore_project`, `restore_clip`) and the CLI (`reelsaw deleted`, `restore`, `delete-clip`, `restore-clip`, `purge`).
- **Command palette and bulk export** – ⌘K searches projects and clips with status, length and age, opens a row's actions (open, export, resume, retry failed clips, re-run refine, re-render, download, delete), takes pasted links (one project each, or opens the existing one) and offers retry-all shortcuts. "Export all" zips every rendered clip with platform-ready metadata: a paste-ready `.txt` (title, description, tags, caption), a `.youtube.json` (YouTube Data API v3 `videos.insert` body, private by default) and a `.tiktok.json` (Content Posting API `post_info`, `SELF_ONLY`) per clip, plus `manifest.json`, `clips.csv` (with rendered duration) and a README. Descriptions carry a timestamped link to the exact moment in the parent video.
- **SRT / VTT in and out** – every rendered clip's ⋯ menu offers its captions as `.srt` or `.vtt` (the same lines and times as the video, intro included, even when the style has captions off), and "Export all" adds them next to each clip as `clips/NN-title.srt` and `.vtt`; clips rendered before this feature need a re-render first. The project's ⋯ menu ("Transcript files…") downloads the transcript the same way (VTT can carry a timestamp before every word) and imports a subtitle file you already have: right after creating a project (only the video is fetched) or on a done or failed one (it cleans the transcript up and picks clips again). Imported cues become segments and their words are spread over the cue by length; the render re-aligns words to the audio. Also `GET /api/clips/:id/captions.srt|vtt`, `GET /api/projects/:id/transcript.srt|vtt` (`?words=1` for VTT word times), the MCP tools `get_clip_captions`, `get_project_transcript_file` and `import_transcript`, and `reelsaw captions`, `transcript-file` and `import-transcript`.

**Library, layers and templates**

- **Library** – intros and outros, logos, stickers, b-roll, music and sound effects (PNG, JPG, GIF, WebP, SVG, video, audio). Drop many files at once (duplicates are detected), search your items plus a bundled catalog and, with an admin key, Pexels, Pixabay, Freesound, Iconify, Giphy and Klipy. Each clip is rendered as intro + clip + outro in a single encode, fitted to vertical over a blurred background.
- **Per project and per clip** – a project follows the default intro/outro, uses none or a specific item; each clip can follow the project, use none or pick its own. An unusable asset is skipped with a plain-language event instead of failing the clip.
- **Layers** – one timeline lane for image/video overlays, text and sound (`update_clip { layers }`, `reelsaw clip-layers`): position, size, opacity, fonts shipped in the image, several music tracks with fade, loop and sidechain ducking under speech. Right-click a layer on the 9:16 preview to edit, centre, reorder, copy or remove; double-click text to retype it. ⌘C / ⌘V copy and paste layers.
- **Layer templates** – save a look once (a logo pop in the first seconds, a follow card at the end, a watermark or a music bed) with timing from the start, the end, the whole clip or a share of its length, then apply it to selected clips or set it on a project so every new clip gets it (`list_layer_templates`, `apply_layer_template`, `reelsaw templates`).

**Agents and automation**

- **MCP server** – `/api/mcp` (Streamable HTTP) lets Claude Code, Claude Desktop, Cursor or a script create projects, wait for them, read timed transcripts, edit layers and framing, create and re-render clips, manage the library and layer templates, and export the results. On a hosted plan the same tools are available, including Free. Authenticate with an API key from Settings, or with `MCP_OAUTH=true` so claude.ai and Claude Desktop connectors sign in through the browser.
- **Operator CLI** – `docker compose exec app reelsaw …` inspects and fixes a running instance: `status`, `events`, `clip`, `rerender`, `stuck`, `recover`, `logs`, `cuts`, `align`, `hear`, `flags`, `storage`, `retention`, `deleted`, `restore`, `purge`, `users`, `approve`, `make-admin`, `set-password`, `library`, `templates`, `apply-framing`, `import-report` and more (every command is in [Operator CLI](#operator-cli)).

**Hosting and accounts**

- **Accounts, approval and quotas** – the first account is the admin; `SIGNUP_MODE=open|approval|closed` decides who gets in, and admins approve, suspend, promote and remove people on the **Users** page, with usage per account (projects, source minutes, clips, model calls and tokens, stored bytes). Optional per-user quotas, retention of old files, captcha on sign-in, email (approval notices, password reset, verification) and terms/privacy links. Everyone has their own **Project defaults** (vocabulary, instructions, language, clip length, pauses, caption style, intro and outro) and API keys.
- **Models and providers at runtime** – admins switch the language, transcription and alignment models under Settings → System → Models without a restart: pick a provider, enter its key or server URL there (stored encrypted, never shown again), and choose from live model lists; local Ollama and Speaches models download with a progress bar. Keys and models are tested when saved.

**Operations**

- **Reliable, resumable, scalable** – every stage is a [pg-boss](https://github.com/timgit/pg-boss) job in Postgres that checkpoints its output, so a crashed or restarted worker picks up where it left off; a worker that stops heartbeating (every 15 s) has its job re-queued by pg-boss within about a minute or two, and a reconciler re-enqueues anything orphaned. Run extra `worker` containers to scale. Every run (first pass, retry, re-render, re-analyze) is recorded with its own timings, and the UI shows elapsed against expected time per stage, learned from your finished projects. The browser gets live updates over a tRPC SSE subscription with automatic reconnect.
- **Storage and install** – local volume or `s3` (AWS S3, MinIO, Cloudflare R2, Backblaze B2…); superseded renders, expired sources and orphaned files are swept hourly (`reelsaw storage` reports, `reelsaw storage sweep` runs it). One-line installers for macOS/Linux (bash) and Windows (PowerShell), and **Report an issue** saves a zip of a project's data, decisions and logs, with secrets left out.
- **Observable and fail-fast** – every service is built in `main` and self-checks, so the process exits with a readable reason if a model id is wrong, a key is missing, a binary is absent, the bucket is unreachable or the DB is down. `LLM_TRACE=logs` or `langfuse` captures every prompt/response (tokens, latency, project/clip/stage), and `OTEL_ENABLED=true` turns on OTLP traces and metrics for HTTP, Postgres, pg-boss jobs, AI SDK calls, ffmpeg/yt-dlp and each stage.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (principles, tests, sign-off). Roadmap for learning from user decisions: [docs/SELF-IMPROVEMENT.md](docs/SELF-IMPROVEMENT.md).

Read [docs/PRINCIPLES.md](docs/PRINCIPLES.md) first: the consistency, concurrency and UI rules every change follows. Overlay stacking (Select inside a Dialog, z-index, portals) and the mobile viewport (`h-dvh`, not `h-screen`) are [docs/UI.md](docs/UI.md). Agent instructions live in `AGENTS.md` (the only agent file; see the process principles).

## Install (no source needed)

Needs Docker (Docker Desktop on macOS and Windows). One command: it looks at the machine (RAM, GPU,
Docker's memory, free disk, an Ollama already running and the models it has, the port), proposes a
setup, asks three questions in a terminal (local Ollama or a hosted provider, which model, go ahead)
and installs Ollama for you (Homebrew, ollama.com or winget) if you pick local and it is missing:

```bash
curl -fsSL https://raw.githubusercontent.com/osbytes/reelsaw/main/deploy/install.sh | bash
```

On Windows (Docker Desktop), in PowerShell:

```powershell
irm https://raw.githubusercontent.com/osbytes/reelsaw/main/deploy/install.ps1 | iex
```

WSL2 users can run the bash one-liner as is (with Docker Desktop's WSL integration on).

It writes `~/reelsaw` (compose file + `.env` with generated secrets), pulls the published image and
the model, starts everything and waits until http://localhost:3000 answers (or the next free port).
Fully local is the default when the machine can carry a useful model: `qwen2.5:14b` (~9 GB) with
24 GB of RAM or a 12 GB GPU, `qwen2.5:7b` from 12 GB, `gemma3:4b` below that, and a good model that
Ollama already has is reused instead of downloaded; with an NVIDIA GPU and the container toolkit,
Ollama and Speaches run on the GPU (and renders encode with NVENC; see "Using a GPU" below). Hosted
providers (OpenAI, Anthropic, Google, Groq, Vercel AI Gateway) are a choice in the same prompt: the
key is asked for and never echoed, and Anthropic and Google pair with local Speaches for
speech-to-text. Without a terminal, or with `REELSAW_YES=1`, the proposed answers are taken;
`REELSAW_AI`, `REELSAW_LLM`, `REELSAW_PORT` and friends answer in advance and `REELSAW_DRY_RUN=1`
prints the plan and stops (every option is listed at the top of the script).
Manual setup: [deploy/README.md](deploy/README.md).
The scripts are [deploy/install.sh](deploy/install.sh) and [deploy/install.ps1](deploy/install.ps1);
they are served from `main` (see [docs/RELEASING.md](docs/RELEASING.md)).

## Quick start (from source)

```bash
git clone <this repo> reelsaw && cd reelsaw
cp .env.example .env
# edit .env: set BETTER_AUTH_SECRET, APP_URL, and at least one AI provider key
docker compose up -d --build
```

Open http://localhost:3000, create an account (it becomes the admin), start a project. Set `SIGNUP_MODE=closed` or `approval` afterwards if the instance is public.

Scale workers:

```bash
docker compose --profile workers up -d --scale worker=2
```

Use MinIO for local S3 testing:

```bash
docker compose --profile minio up -d
# then in .env: STORAGE_DRIVER=s3 S3_ENDPOINT=http://minio:9000 S3_FORCE_PATH_STYLE=true S3_BUCKET=reelsaw S3_ACCESS_KEY_ID=reelsaw S3_SECRET_ACCESS_KEY=reelsaw123
```

(Create the bucket once via the MinIO console at http://localhost:9001.)

## Model configuration

The language model and the transcription model are independent; mix vendors freely (Anthropic has no speech-to-text, so pair it with Deepgram/OpenAI/AssemblyAI/Groq). Each needs only its own key.

| Env | Example values |
|---|---|
| `AI_MODEL` | `openai:gpt-4o-mini`, `anthropic:claude-sonnet-4-5`, `google:gemini-2.5-flash`, `groq:llama-3.3-70b-versatile`, `gateway:anthropic/claude-sonnet-4-5`, `compat:qwen2.5:14b` |
| `TRANSCRIPTION_MODEL` | `openai:whisper-1`, `deepgram:nova-3`, `assemblyai:best`, `groq:whisper-large-v3-turbo` |

The transcription model must return word timestamps (captions and cuts need them), so `openai:gpt-4o-transcribe`, which returns none, is not supported.

### Fully local (no API keys)

Ollama only serves language models; it has no speech-to-text. So the local stack is Ollama for `AI_MODEL` plus [Speaches](https://github.com/speaches-ai/speaches) (faster-whisper behind an OpenAI-compatible API, word timestamps supported) for `TRANSCRIPTION_MODEL`. Both ship as a compose profile:

```bash
docker compose --profile local-ai up -d            # Speaches; use your native Ollama (macOS: Metal GPU)
docker compose --profile local-ai --profile ollama up -d   # Linux: also run Ollama in a container
ollama pull qwen2.5:14b                            # or: docker compose exec ollama ollama pull qwen2.5:14b
```

`.env`:

```
AI_MODEL=compat:qwen2.5:14b            # qwen2.5:7b or gemma3:4b on less RAM
OPENAI_COMPATIBLE_BASE_URL=http://host.docker.internal:11434/v1   # native Ollama; http://ollama:11434/v1 for the container
OPENAI_COMPATIBLE_API_KEY=ollama
TRANSCRIPTION_MODEL=openai:Systran/faster-whisper-small
OPENAI_BASE_URL=http://speaches:8000/v1
OPENAI_API_KEY=local
```

Notes: the app requests `response_format: json_schema` from the compat server (`OPENAI_COMPATIBLE_STRUCTURED_OUTPUTS=false` to disable) and falls back to lenient parsing when a model ignores it, but small models still pick weak moments and write bland hooks. gemma3 4b works; qwen2.5 14b (the installer's default on 24 GB or more), llama3.1 8b or gemma3 12b are noticeably better. On first boot the app auto-downloads the whisper model into Speaches and verifies the Ollama model is pulled (it exits with `ollama pull <model>` otherwise). Speaches CPU with `faster-whisper-small` runs roughly real-time; use the `latest-cuda` image and `faster-whisper-large-v3` on a GPU. The `OPENAI_*` variables are reused for Speaches because it speaks the OpenAI audio API, which is why the LLM goes through the `compat` provider instead.

### Using a GPU

Three things can use one, each in its own container, so the GPU is a Compose override rather than
a different image: `docker-compose.gpu.yml` reserves every NVIDIA device for `speaches`, `ollama`,
`app` and `worker`. Host side you need the NVIDIA driver (`nvidia-smi` works) and the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
(`sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`; on Windows,
Docker Desktop on WSL2 with the Windows driver only). Then in `.env`:

```
# Linux/macOS (colon). On Windows use a semicolon: docker-compose.yml;docker-compose.gpu.yml
COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml
SPEACHES_IMAGE=ghcr.io/speaches-ai/speaches:latest-cuda
WHISPER_MODEL=Systran/faster-whisper-large-v3      # or deepdml/faster-whisper-large-v3-turbo-ct2
TRANSCRIPTION_MODEL=openai:Systran/faster-whisper-large-v3
```

and `docker compose --profile local-ai up -d` as before. What changes:

- **Transcription** is the big one: faster-whisper on CUDA runs `large-v3` in a fraction of real time,
  where `small` on a CPU was about real time (the transcribe factor in the table below).
- **The language model** uses the card when Ollama runs in the `ollama` container (`--profile ollama`).
  A native Ollama (macOS, or Linux on the host) already uses the GPU on its own.
- **Renders** encode with `h264_nvenc` instead of libx264: `FFMPEG_ENCODER=auto` probes it at boot and
  keeps libx264 when the card is not there. Filters (crops, blur, captions) still run on the CPU, and
  render was already the short stage, so expect seconds, not minutes. A hardware encode that fails
  mid-clip (NVENC session limit, driver reset) is redone with libx264 for that clip.
- **The on-device models** (face, text, alignment) stay on the CPU by default. `ONNX_EXECUTION_PROVIDER=cuda`
  moves them, but the published image carries no CUDA libraries for onnxruntime, and on Apple silicon
  CoreML measured slower than the CPU for all three; see `docs/CONFIG.md`.

**Settings → System → Overview** and `docker compose exec app reelsaw machine` show the GPU the app
process sees, the encoder in use and why, and where each on-device model runs. **Workers** (and
`reelsaw workers`) lists every API and worker replica with its specs and what it is processing —
needed when the HTTP process is not the one doing the work. macOS has no CUDA in
Docker: run Ollama natively for Metal, and leave Speaches on the CPU (or point `OPENAI_BASE_URL` at a
whisper.cpp or MLX server running on the host, which speaks the same API).

### What to expect: processing time

Every stage scales with the length of the video. Expected seconds for a stage ≈ *video seconds × factor*, where the factor depends on the models (local vs vendor) and your machine:

| stage | what sets the factor | local CPU (measured¹) | vendor (measured²) |
|---|---|---|---|
| download | your bandwidth and the site | 0.015 | 0.015 |
| transcribe | whisper size on CPU/GPU, or the STT vendor | 0.25 | 0.065 |
| refine (fillers, names) | LLM latency × number of candidate windows | 0.5 | 0.03 |
| find moments | LLM latency × (video minutes ÷ 5 + 1) calls | 0.2 | 0.02–0.07 |
| render | ffmpeg + face tracking per clip, ÷ render concurrency | 0.04 (3 clips) | 0.05 (3 clips) |

Rule of thumb: **a vendor stack finishes a video in about a fifth of its length; a local CPU stack takes about as long as the video.** Refine runs alongside finding moments, so the stages don't add up exactly.

¹ Apple-silicon laptop, `qwen2.5:14b` on Ollama + `faster-whisper-small` on Speaches (CPU), 20-minute podcast: download 15 s, transcribe 4.9 min, refine 10 min, find moments 4 min, render 47 s; 20 min in all. On a local 14B model the disfluency verifier (one call per candidate, ~40 s each) is the bottleneck, not transcription; a smaller model or `DISFLUENCY_LLM=false` cuts refine to a fraction. ² Same video through the Vercel AI Gateway, `whisper-1` + `claude-haiku-4.5`: download 13 s, transcribe 77 s, refine 31 s, find moments 24 s, render 56 s; 3.4 min in all. Gemini 2.5 Flash took 5 min (long "thinking" outputs), Sonnet 4.5 about 4. Mixing a vendor LLM with a *local* `TRANSCRIPT_ALIGN_MODEL` makes render the slowest stage (5–9 min: every cut is re-aligned on the CPU); keep alignment on the same vendor as transcription. Full numbers in `eval/bench/results/`.

These factors are only the starting point. The app learns from its own finished projects: each stage's expected time is the median over your recent projects that ran with the same models, shown next to the elapsed time on the project page while it runs, in the activity feed when a stage finishes (`Transcribe finished in 4:50 (expected ~4:00)`), and as a per-stage expected vs actual table under Settings → System → Machine. There is no calibration step; the runs are the calibration.

### Switching models without a restart

`.env` names the default models and keys; an admin can change both at any time under **Settings →
System → Models**. Each of the three pickers (language, transcription, alignment) opens provider
first: pick a provider and, if it has no key or server URL yet, enter it right there; its models
then appear. Cloud vendors are asked live, a self-hosted Ollama or Speaches shows what is installed
and downloads anything else with a progress bar, and the search box filters every provider at once.
Saving a key tries it first (the provider's models are listed with it) and a wrong one is refused;
saving a model checks it too (key present, server reachable and model installed, transcription
returns word timestamps). Keys are stored encrypted in the database with a key derived from
`BETTER_AUTH_SECRET` and never shown again (the UI sees the last four characters); rotating that
secret makes stored keys unreadable, and the UI asks for them again. Changes survive restarts and
reach worker processes within seconds; a stage already running finishes with the model it started
with. "Back to .env" / "Remove" drop an override. Over the API: `admin.models.*`, `admin.providers.*`.

## Accounts and roles

The first account created on an instance is the **admin**; everyone else is a **user**. Admins see
the system settings (models, storage, resource meters) and the **Users** page; users see their own
projects and settings only. `SIGNUP_MODE` decides who gets in:

| `SIGNUP_MODE` | Behaviour |
| --- | --- |
| `open` (default) | Anyone can sign up and use the app at once. Right for a single-user box and for a public instance that already confirms email. |
| `approval` | New accounts wait on a "Waiting for approval" page until an admin approves them (Users page, or `reelsaw approve <email>`). Admins get an email when `EMAIL_DRIVER` is set. Right for a private box, not a public product. |
| `closed` | No sign-ups. (The older `ALLOW_SIGNUP=false` is still read as `closed`; use `SIGNUP_MODE`.) |

Every user has **Settings → Project defaults** (vocabulary, instructions, language, clip length,
pauses, caption style…) applied to each new project they or their agents start; the new-project
form starts from them and can save its current values back. Admins also see the **System** section
(models, storage, resource meters) and `/api/health` includes machine numbers only for them (or
with `HEALTH_DETAILS=true`).

Suspending an account (Users page) ends its sessions and refuses its API keys at the next request;
removing one deletes its projects, clips and files. Locked out of the password? Sign-in has Forgot
password when email is on. Without email, an operator sets a new one from the shell (`docker
compose exec app reelsaw set-password you@example.com`); `--must-change` makes them pick their own
at the next sign-in, without asking for the temporary password (the session is the proof they knew
it). To promote an account from the shell: `docker compose exec app reelsaw make-admin
you@example.com`.

Email (`EMAIL_DRIVER=smtp|resend`, `EMAIL_FROM`, `SMTP_URL` or `RESEND_API_KEY`) turns on approval
notices, password reset and, with `REQUIRE_EMAIL_VERIFICATION=true`, verification before the
first sign-in. Confirmation and reset links work for 24 hours and only once; an expired link lands
on a page that sends a new one. Sign-in has **Forgot password?** when email is on; choosing a new
password signs out other devices. Without email everything else works; approvals are handled on
the Users page.

## Hosting for many people

Everything below is off by default and switched on by environment (`deploy/.env.example` lists
them), so a single-user box stays as it is:

- **Quotas**: `MAX_PROJECTS_PER_USER`, `MAX_SOURCE_MINUTES_PER_DAY`, `MAX_SOURCE_MINUTES_PER_MONTH`,
  `MAX_NEW_PROJECTS_PER_HOUR`, `MAX_STORAGE_MB` (0 = unlimited), with per-user overrides on the Users
  page. A refusal is a sentence that says what to do ("Monthly limit of 300 minutes reached (312
  used); resets on 1 November"). The monthly window is the account's billing period when it has a
  plan, else the UTC calendar month. Length is checked once the video is probed, so an over-long
  download fails the project with that reason.
- **Watermark**: `WATERMARK_NON_ADMINS` (default on) burns the logo (`WATERMARK_LOGO_PATH`) with
  `WATERMARK_TEXT` ("reelsaw.com") under it into the clips of accounts that are not admins; a paid plan
  removes it, and an admin can switch it per user on the Users page (Limits). Decided at render time,
  so a re-render after the change applies it.
- **Usage** (Users → Usage): projects, minutes of source, clips rendered, model calls and tokens
  (every model call writes a `llm_usage` row attributed to the project's owner), stored bytes.
- **Retention**: `SOURCE_RETENTION_DAYS` / `CLIP_RETENTION_DAYS` delete stored files from finished
  projects; rows and history stay, the project page offers "fetch again" and clips re-render.
  `reelsaw retention` runs a sweep by hand.
- **History pruning**: `EVENT_RETENTION_DAYS` (90), `LLM_USAGE_RETENTION_DAYS` (180) and
  `ADMIN_EVENT_RETENTION_DAYS` (365) delete old rows in batches once a day (0 keeps everything);
  a project's run skeleton (created, run started, done) is always kept.
- **Bot protection**: `CAPTCHA_PROVIDER` (Cloudflare Turnstile, reCAPTCHA, hCaptcha) with site and
  secret keys puts a widget on sign-up, sign-in and password reset.
- **Free-tier abuse** (all off unless set; `apps/server/src/abuse.ts`): `MAX_SIGNUPS_PER_IP_PER_DAY`
  caps accounts per network address (behind a proxy, `TRUST_PROXY` reads `CF-Connecting-IP`,
  `X-Real-IP`, `X-Forwarded-For`); `BLOCK_DISPOSABLE_EMAILS` refuses temporary-address domains; one
  account per real mailbox (`john.doe+x@gmail.com` is `johndoe@gmail.com`); `MAX_REQUESTS_PER_MINUTE`
  / `_HOUR` cap changes (API mutations, MCP tool calls) per account, with plan and per-user
  overrides like the other quotas. An hourly pass flags accounts that
  share a sign-up address, arrive in bursts or use a temporary domain; the Users page shows the flags ("Flagged only"), `reelsaw abuse` lists them, and nothing is
  suspended automatically. Every refusal is a sentence.
- **yt-dlp from a datacentre**: YouTube refuses many cloud IPs. `YTDLP_PROXY` is one URL
  or an operator-ranked pool (a home Pi, a cheap VPS, a paid proxy). `{session}` in a URL is
  replaced per download so a residential gateway can sticky-session one video and rotate the
  next. Reliability is a circuit breaker on each candidate and never changes the ranking among
  healthy ones. `YTDLP_COOKIES_FILE` helps too; a blocked download fails with "upload the file
  instead". `reelsaw ytdlp-proxies` shows the pool.
- **Legal**: `TERMS_URL` / `PRIVACY_URL` appear on the sign-up form.
- **MCP over OAuth** (`MCP_OAUTH=true`): Reelsaw becomes an OAuth 2.1 authorization server for
  MCP connectors (claude.ai, Claude Desktop): dynamic client registration, sign-in and a consent
  page in the browser, discovery at `/.well-known/oauth-protected-resource/api/mcp` (which names
  the issuer, `<APP_URL>/api/auth`, whose metadata is at
  `/.well-known/oauth-authorization-server/api/auth`). API keys keep working for CLIs.

## Billing (enterprise edition)

The hosted service at app.reelsaw.com adds plans and billing through Stripe. That code lives in
`apps/server/src/ee` and `apps/web/src/ee` under its own licence ([LICENSING.md](LICENSING.md)),
ships in the same image, and runs only with `REELSAW_EE=true` plus `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET`. Nothing else changes for a self-hosted install.

- A plan is a named set of the limits above (`ee/billing/plans.ts`); the account's plan sits between
  the instance setting and the admin's per-user override. Free is a plan too: what an account with
  no, or a lapsed, subscription gets.
- Stripe is the source of truth. A webhook (`POST /api/billing/webhook`) is acknowledged only once
  its event row and a `billing.sync` job have committed together; the job rewrites the account's
  row from Stripe, so events that arrive late, twice or out of order converge. A daily reconcile
  and `reelsaw billing sync` repair anything a lost webhook left behind.
- Settings → Billing shows the plan, the period's usage and the plan grid; Checkout and the
  Billing Portal are Stripe's pages. `get_billing` and `billing_checkout_url` do the same over MCP;
  `reelsaw billing <email>` shows the row, Stripe's view and the last webhook events.
- A failed payment keeps the plan for `BILLING_GRACE_DAYS` (7), then the account is on Free.
  Admins can grant a plan without Stripe (Users → Limits → Plan, or `reelsaw billing set-plan`).
- Setting up a Stripe account: `pnpm --filter @reelsaw/server stripe:setup --webhook --portal` (rebuilds `@reelsaw/shared` first)
  creates the products, prices (by lookup key), webhook endpoint and portal configuration from the
  plan list, idempotently. Developing without a Stripe account: `pnpm --filter @reelsaw/server
  stripe:mock` stands in for api.stripe.com (`STRIPE_API_BASE=http://host.docker.internal:4242`)
  and `test/billing-stack.test.ts` drives the whole lifecycle through signed webhooks.

Design and decisions: [docs/specs/ee.md](docs/specs/ee.md).

## MCP: drive Reelsaw from an agent

Reelsaw is an MCP server (Model Context Protocol, Streamable HTTP) at `/api/mcp`. Create an API key
in **Settings → API keys and MCP** (shown once) and point a client at it:

```bash
claude mcp add --transport http reelsaw https://your-host/api/mcp --header "Authorization: Bearer rs_…"
```

```json
{ "mcpServers": { "reelsaw": { "type": "http", "url": "https://your-host/api/mcp", "headers": { "Authorization": "Bearer rs_…" } } } }
```

Clients that launch a command instead of calling a URL with a header (Claude Desktop without
`MCP_OAUTH`, Cursor's stdio entries) use `reelsaw mcp`: the same tools over stdio, forwarded to a
running instance. It needs no database or models, only `REELSAW_URL` (default: the app in the same
container) and `REELSAW_API_KEY`:

```json
{ "mcpServers": { "reelsaw": { "command": "docker", "args": ["exec", "-i", "-e", "REELSAW_API_KEY=rs_…", "reelsaw-app-1", "reelsaw", "mcp"] } } }
```

Reelsaw is listed on the [MCP registry](https://registry.modelcontextprotocol.io) as
`io.github.osbytes/reelsaw` (`server.json`, published on every release), so registry-aware clients
can install the bridge from the image without a running container to exec into:

```json
{ "mcpServers": { "reelsaw": { "command": "docker", "args": ["run", "-i", "--rm", "-e", "REELSAW_URL=https://your-host", "-e", "REELSAW_API_KEY=rs_…", "ghcr.io/osbytes/reelsaw", "reelsaw", "mcp"] } } }
```

The tools (generated from `apps/server/src/mcp-tools.ts`; each tool's full description and input
schema say what it returns, whether it runs in the background and which neighbour to use instead):

<!-- generated:mcp-tools -->
| Tool | What it does |
| --- | --- |
| `list_projects` | Your projects, most recently updated first. |
| `get_project` | One of your projects: status, settings, effective intro/outro, transcript summary, and every clip (id, title, hook, bounds, score, status, download links); replacedClips lists deleted or replaced clips for restore_clip. |
| `create_project` | Start clipping a video from a URL (YouTube, Vimeo, a direct link; anything yt-dlp fetches). |
| `update_project` | Rename a project and/or change its saved settings (focus, instructions, clip length, maxClips, caption style, framing, pauses, refineEntities, refineDisfluency, disfluencyLlm, refineScenes); only the fields you pass change. |
| `wait_for_project` | Block until the project is done or failed, or timeoutSeconds pass. |
| `get_transcript` | The project's transcript as timed lines "[m:ss] text", optionally only a time range. |
| `get_clip_captions` | The captions of a clip's last render as an SRT or WebVTT file: the same lines and times as the video (intro included), even when the style has captions off. |
| `get_project_transcript_file` | The project transcript as an SRT or WebVTT subtitle file, one cue per transcript segment, in source-video seconds. |
| `import_transcript` | Use an SRT or WebVTT file as the project's transcript instead of transcribing: right after create_project (only the video is fetched) or on a done or failed project (it then re-cleans the transcript and picks clips again). |
| `search_clips` | Find your clips and projects by words in their title, hook or caption (every word must match; case-insensitive, typo-tolerant; best first). |
| `get_project_events` | The project's pipeline history, newest first: stage starts and completions, clip renders, retries, failures with reasons. |
| `get_clip` | Everything about one clip: text, bounds, scores, framing, style, emphasis, own and effective intro/outro, layers (assets, text, sounds), render diagnostics, video/thumbnail/editor links. |
| `update_clip` | Edit one clip: only the fields you pass change; style, layoutSections and layers replace the whole value (null = project's / none). |
| `create_clip` | Add a clip from a time range of the source (needs a transcript). |
| `delete_clip` | Delete one clip of your project; a render in progress stops. |
| `rerender_clip` | Queue one clip for rendering again (after rerender: false edits, a failure, or an intro/outro change). |
| `rerender_clips` | Queue several clips of one project for rendering again in one step (after edits or failures). |
| `export_project` | A download link for a zip of the project's rendered clips with YouTube/TikTok metadata. |
| `report_issue` | A download link for an issue-report zip (the same file Report an issue in the app saves; admins may include instance-wide diagnostics). |
| `retry_project` | Resume a failed or stuck project from its furthest completed stage: re-render unfinished clips if there are clips, else pick clips, refine or transcribe again. |
| `reanalyze_project` | Pick clips again from the existing transcript (needs one), optionally with new settings. |
| `search_assets` | Find assets. |
| `add_asset` | Add from exactly one source: a public url or an uploadId (video, image, GIF, SVG or sound) becomes one of your library uploads; a search_assets catalog / provider hit (provider + externalId) materializes one instance-shared copy (checksum verified, license recorded; not listed in your library). |
| `update_asset` | Rename one of your own library items, replace its tags, or change how long a still image shows (removed items too; shared catalog and provider items cannot be changed). |
| `remove_asset` | Remove one of your uploads from the library and from your defaults. |
| `restore_asset` | Bring one of your removed library items back (the id from remove_asset or `reelsaw library list`); restoring an item that is not removed changes nothing. |
| `asset_usage` | Where a library item is used: as intro, outro, overlay or music on projects and clips (replaced clips left out), and in layer templates. |
| `set_default_bumper` | Make a library item your default intro or outro for projects you create from now on (assetId null clears it). |
| `set_project_bumpers` | Set one project's intro and/or outro: "default" (your current default), "none", or a library asset id; a slot left out is untouched, and introSec/outroSec are saved with the project. |
| `set_clip_bumpers` | Override the intro and/or outro of up to 200 clips of one project: "inherit" (follow the project), "none", or a library asset id; a slot left out is untouched. |
| `list_layer_templates` | Your layer templates (sets of layers that fit any clip length). |
| `save_layer_template` | Create a template from exactly one of clipId (that clip's layers: spanning = fill, touching the start = head, touching the end = tail, else anchored to the nearer edge) or layers (each with a timing, see list_layer_templates). |
| `update_layer_template` | Rename a layer template and/or replace its layers (the whole list, each with a timing); a field left out is untouched. |
| `remove_layer_template` | Remove a template and drop it from your project defaults; clips that already got its layers keep them. |
| `restore_layer_template` | Bring back a layer template removed in the last 30 days (the id from list_layer_templates deleted). |
| `apply_framing` | Make one clip's framing the whole project's, for a recording whose layout never changes (a slide deck with a webcam tile, a fixed camera): the clip's section at `at` (else its first framed section) gives the mode and its nudge / subject / crop, which become the project's reframe and reframeAdjust; every clip's own sections are cleared (unless keepOverrides) and the finished clips re-render. |
| `apply_layer_template` | Write a template's layers onto clips of one project (up to 200 clipIds, or all), fitted to each clip's length. |
| `delete_project` | Delete one of your projects and all its clips; work in progress stops. |
| `restore_project` | Bring back a deleted project with its clips and files (find it with list_projects deleted: true); restoring a project that is not deleted changes nothing. |
| `restore_clip` | Bring back a deleted clip or one a re-analyze replaced (get_project lists them as replacedClips); it goes to the end of the project's clips. |
| `check_for_update` | Admins only: is a newer Reelsaw published? |
| `list_releases` | Published Reelsaw versions from GitHub (reelsaw.com/releases): tag, date, a short summary and the change notes. |
| `get_instance_settings` | Admins only: the instance settings in force (sign-up mode, email verification, captcha, legal links, quotas, upload limits, retention, stall watchdog, update check, health details) and where each comes from. |
| `list_workers` | Admins only: every Reelsaw process that has checked in (API, worker, or a combined app), with CPU, memory, disk (free/total MB; -1 free means unmeasurable), GPU, render slots, the queues it listens on, and the jobs it last reported. |
| `get_failure` | Admins only: one failed project or clip (title, owner email, stage, full recorded reason, when). |
| `get_queue` | Admins only: waiting, running and retrying job counts per pipeline stage, plus the jobs currently in flight (project title, attempt, started). |
| `list_failures` | Admins only: failed projects and clips across the instance (owner email, stage, reason, when). |
| `retry_failures` | Admins only: retry matching failed projects and clips through the same lifecycle as retry_project / rerender_clip (never a raw queue poke). |
| `set_instance_settings` | Admins only: change instance settings without a restart; every process applies them within seconds and the change is audited. |
| `get_billing` | Hosted instances: your plan and subscription, the billing period, the limits in force with where each comes from (instance, plan, an admin's override), what you have used this period, whether renders carry a watermark, and the plans on offer. |
| `billing_checkout_url` | Hosted instances: a Stripe Checkout URL for a plan (or, when the account already pays, the Billing Portal page that confirms the plan change). |
<!-- /generated -->

`get_project` / `get_clip` show each clip's effective intro/outro and where it comes from.
They call the same tRPC procedures as the web app, so ownership checks and
validation are identical (`apps/server/src/mcp.ts`; the catalogue both transports advertise is
`apps/server/src/mcp-tools.ts`). The same key also authenticates tRPC
(`/api/trpc/*`), uploads and media downloads, so an agent can fetch the rendered clips. Keys are
hashed at rest (`@better-auth/api-key`); revoke them from Settings.

## Operator CLI

`docker compose exec app reelsaw <command>` (see [TROUBLESHOOTING](docs/TROUBLESHOOTING.md) for when to reach for which). Generated from the header of `apps/server/src/cli.ts`.

<!-- generated:cli -->
Run as `docker compose exec app reelsaw <command>` (from source: `pnpm --filter @reelsaw/server cli <command>`).

| Command | What it does |
| --- | --- |
| `reelsaw version [--json]` | running version, latest published release, how to upgrade |
| `reelsaw releases [--json] [--limit n]` | published versions from GitHub (reelsaw.com/releases / list_releases) |
| `reelsaw users` | list accounts: role, status, sign-up date |
| `reelsaw approve <email>` | approve a waiting account (when email is off or the admin is locked out) |
| `reelsaw make-admin <email>` | promote an account to admin (approves it first if needed) |
| `reelsaw set-password <email> [--must-change]` | set an account's password from a prompt (or two stdin lines); `--must-change` requires a new one at next sign-in. Do not put the secret on the command line |
| `reelsaw retention` | run the retention sweep now (SOURCE_RETENTION_DAYS / CLIP_RETENTION_DAYS) |
| `reelsaw deleted` | deleted projects that can still be restored, with their purge date |
| `reelsaw restore <projectId>` | undo a project delete (same as projects.restore and the restore_project tool) |
| `reelsaw restore-clip <clipId>` | bring back a deleted clip or one a re-analyze replaced |
| `reelsaw delete-clip <clipId>` | delete one clip, restorable like a project (same as clips.delete and delete_clip) |
| `reelsaw captions <clipId> [--format srt\|vtt] [--words]` | print a clip's rendered captions as an SRT or VTT file (same as clips.captions and get_clip_captions) |
| `reelsaw transcript-file <projectId> [--format srt\|vtt] [--words]` | print a project's transcript as an SRT or VTT file (same as projects.transcriptFile and get_project_transcript_file) |
| `reelsaw import-transcript <projectId> <file.srt\|file.vtt> [--language xx]` | use a subtitle file as the transcript instead of transcribing (same as projects.importTranscript and import_transcript) |
| `reelsaw update-project <projectId> [--title t] [--set key=value]… [--clear key]…` | rename a project or change its settings without re-running anything (same as projects.update and update_project); values are JSON or text |
| `reelsaw purge` | [--dry-run]                     remove deleted projects and replaced clips past DELETED_RETENTION_DAYS now |
| `reelsaw machine [--json]` | this box: cpus, memory, disk, GPU, ffmpeg encoder in use and why, where each on-device model runs (same as Settings → System → Overview) |
| `reelsaw ytdlp-proxies [--json]` | yt-dlp egress pool: operator priority vs circuit (reliability), never URLs |
| `reelsaw workers [--json]` | every process that has checked in: role, specs, last seen, current jobs (same as Settings → System → Workers) |
| `reelsaw queue [--json]` | waiting / running / retrying jobs per stage, plus what is in flight (same as Settings → System → Queue) |
| `reelsaw failure <projectId\|clipId> [--json]` | one failed project or clip: owner, stage, the full recorded reason (same as clicking a row under Settings → System → Queue → Failed work) |
| `reelsaw retry-failures [--stage s] [--q text] [--since 24h] [--json]` | retry failed projects and clips matching a reason after a platform fix (same as Settings → System → Queue → Retry all matching) |
| `reelsaw status <projectId>` | project, refine steps, clips, live jobs, last error |
| `reelsaw events <projectId> [n=30]` | recent pipeline events |
| `reelsaw clip` | <clipId>                        everything about one clip incl. render diagnostics |
| `reelsaw faces` | <clipId> [a-b] [--json]         face boxes per sampled frame + split speaker tracks |
| `reelsaw rerender <clipId…>` | queue a re-render of one or several clips (same as the UI buttons) |
| `reelsaw import-report <zip> [--user <email>] [--source <file>] [--no-download] [--allow-any-url]` | rehydrate an issue report as a new project (dev only; the zip's contents are untrusted data, see its README) |
| `reelsaw report [projectId] [--out file.zip] [--instance] [--description text] [--user email]` | write an issue-report zip (same as Report an issue); --instance adds unfinished work, failed jobs, usage and error logs across every account (operator) |
| `reelsaw cuts` | <clipId> [--save <dir>] [--fixture <dir>] dry-run the disfluency cut search for a clip and print every candidate verdict; --save writes removed/context audio; --fixture exports each flagged span as an offline regression case for `pnpm eval:cuts` |
| `reelsaw align` | <projectId> <start> <end>       word timestamps from the align model for a source window |
| `reelsaw hear` | <clipId> [start] [dur]          transcribe a range of the RENDERED clip (what viewers hear) |
| `reelsaw flags` | <projectId> [from] [to]         transcript flags (entities / disfluencies / collapsed loops) with status |
| `reelsaw storage [sweep [--dry-run]]` | disk use: unique, scratch-only, duplicate-source, expired-but-present bytes; `sweep` removes leftover files nothing points at (the reconciler's hourly sweep) |
| `reelsaw stuck` | every unfinished project/clip: age, last event, live jobs, problems |
| `reelsaw recover <clipId\|projectId>` | clip: re-run the right step (prepare or render); project: reconcile |
| `reelsaw logs` | <id> [n=60] [--since 2h] [--level debug] [--module render] [--raw] log lines mentioning a project/clip/job/request id from LOG_FILE (survives redeploys) |
| `reelsaw log-level [<level\|module=level,...>\|reset] [--for 15m]` | show the log levels in force, or set them for a while (e.g. render=debug); all processes follow within ~5 s |
| `reelsaw scenes <projectId> [--store]` | re-detect shot cuts (adaptive); --store saves them for layout/snapping/overlays |
| `reelsaw library list [--kind video\|image\|audio] [--q text]` | \| search <q…> [--source library\|catalog\|<provider>] [--kind video\|image\|audio] [--license cc0\|by] \| add <file\|url\|provider:externalId> [--name n] [--tags a,b] [--color #hex] \| update <id> --tags a,b \| rename <id> <name…> \| remove <id> \| restore <id> \| usage <id> \| default <intro\|outro> <id\|none> \| reindex            [--user <email>] the library: intro/outro videos and images, logos, stickers, GIFs, SVGs, music and sound effects. `search` looks in your library, the Reelsaw catalog (default) or an enabled provider (pexels, pixabay, freesound, iconify, openverse, giphy, klipy); `add` takes a file, a link or a search hit (license and credit are recorded). The user is --user, else the only account on this install; otherwise pass --user. `reindex` rebuilds the asset reference table ("used by", purge safety) for every project, to completion |
| `reelsaw catalog status\|refresh` | the Reelsaw catalog manifest in force (version, source, last check); refresh asks CATALOG_URL now |
| `reelsaw project-bumpers <projectId> [--intro default\|none\|<id>] [--outro …] [--intro-sec n] [--outro-sec n] [--rerender]` | a project's intro/outro: the library default, none or a specific item |
| `reelsaw clip-bumpers <projectId> <clipId…> [--intro inherit\|none\|<id>] [--outro …] [--intro-sec n] [--outro-sec n] [--rerender]` | a clip's own choice (inherit the project's, none or an item); both act as the project's owner; --rerender re-renders only the affected clips |
| `reelsaw clip-layers <projectId> <clipId> [--set '<json array>' \| --add <assetId> --from <sec> --to <sec> [--x f] [--y f] [--w f] [--opacity f] [--loop\|--no-loop] \| --add-text <text> --from <sec> --to <sec> [--x f] [--y f] [--size f] [--color #RRGGBB] [--font <family>] [--box] [--opacity f] \| --add-sound <assetId> --from <sec> [--to <sec>] [--volume 0-1] [--offset <sec>] [--fade <sec>] [--duck\|--no-duck] [--loop\|--no-loop] \| --remove <layerId> \| --clear] [--rerender]` | everything laid over or played under a clip, one list (source seconds, x/y/w/size as fractions of the 9:16 frame); a sound of 8 s or less, is a one-shot at full level, anything else music (ducked, faded, looped); with no change flag it lists them |
| `reelsaw apply-framing <clipId> [--at <sec>] [--keep-overrides] [--no-rerender]` | make one clip's framing (its section at --at, else its first framed one: mode plus nudge / subject / crop) the project's default for every clip, clearing the others' own sections and re-rendering the finished ones (same as the editor's "Use for all clips" and apply_framing) |
| `reelsaw templates list \| show <id> \| save <projectId> <clipId> <name…> \| rename <id> <name…> \| set <id> --layers '<json array>' \| remove <id> \| restore <id> \| apply <templateId> <projectId> [clipId…] [--add] [--rerender]` | layer templates: layers whose timing fits any clip length (head / tail / fill / relative); `save` builds one from a clip's layers, `apply` writes them onto the clips of a project (all of them without clip ids; --add keeps the clip's own layers, default replaces); --rerender re-renders the finished ones. Same procedures as the Templates page and the MCP tools |
| `reelsaw overlays <projectId> [--store]` | scan the source for burned-in captions / watermarks; --store saves them (renders then hide them) |
| `reelsaw usage` | [--days 30]                     per account: projects, source minutes, clips, model calls / tokens / reported cost, minutes transcribed, stored bytes (same numbers as Users → Usage) |
| `reelsaw limits <email> [--watermark always\|never\|follow]` | an account's quotas: instance value, plan, override, in force, in use now; --watermark sets the per-user override (same as Users → Limits) |
| `reelsaw abuse` | [--run]                         accounts the hourly abuse pass flagged (shared sign-up address, bursts, temporary domains); --run recomputes the flags now |
| `reelsaw billing <email> \| sync [<email>] \| set-plan <email> <plan\|none>` | hosted (REELSAW_EE): an account's plan, subscription, Stripe's view and its last webhook events; `sync` re-reads Stripe for one account or every subscription (the daily reconcile, by hand); `set-plan` grants a plan without Stripe (none removes it) |
| `reelsaw settings [KEY=value…] [--clear KEY…]` | instance settings in force (sign-up mode, quotas, retention, …): .env default, admin override, effective; KEY=value changes one without a restart, --clear KEY goes back to .env (same as Settings → System and set_instance_settings) |
| `reelsaw mcp` | the MCP server over stdio for clients that launch a command: same tools as /api/mcp, forwarded to REELSAW_URL with REELSAW_API_KEY (needs no database; see src/mcp-stdio.ts) |
<!-- /generated -->

## Settings and precedence

Where a value comes from, from the weakest source to the strongest (a later link overrides an earlier one):

| What | Chain |
| --- | --- |
| Models (language, transcription, alignment) | `.env` (`AI_MODEL`, `TRANSCRIPTION_MODEL`, `TRANSCRIPT_ALIGN_MODEL`) then the admin's runtime override (Settings → System → Models, stored in `instance_settings`). A stage already running keeps the model it started with. |
| Provider keys and URLs | `.env` then the encrypted keys admins enter in Settings. |
| Instance settings (sign-up mode, email verification, captcha, legal links, quotas, upload limits, refine-stage gates, retention, stall watchdog, update check, health details) | `.env` then the admin's runtime override (Settings → System, `reelsaw settings`, `set_instance_settings`; stored in `instance_settings`, applied by every process within seconds). An override whose precondition goes away (email verification without an email driver) is ignored and shown as such. |
| Refine gates (`TRANSCRIPT_CORRECTION`, `DISFLUENCY_REMOVAL`, `DISFLUENCY_LLM`, `REFINE_SCENES` = the on-screen text scan; shot cuts are always detected) | `.env` then the instance setting (Settings → System → Pipeline). `TRANSCRIPT_CORRECTION` and `REFINE_SCENES` default **on**, the disfluency gates **off**. That value is a **ceiling**: when off, every project skips the step. When on, each project's `refineEntities` / `refineDisfluency` / `disfluencyLlm` / `refineScenes` (and the user's Project defaults) decides: name fixes and the text scan run unless turned off, filler removal only when turned on. |
| Other stage knobs (`TRANSCRIPT_BIAS`, `VAD`, `ALIGNER`, `FACE_DETECTION`, `TEXT_DETECTION`, concurrency) | `.env` only. No UI or per-project override exists. |
| A project's settings | built-in defaults, then the user's **Project defaults**, then what the create form or agent sent. The result is frozen into `projects.settings`; later changes (`updateStyle`, re-analyze with new settings) patch that row. |
| A clip's style | the project's style, then the clip's own override (`clips.style`). `updateStyle` clears clip overrides unless told to keep them. |
| Layer template | the user's **Project defaults** `layerTemplateId`, then the project's setting (frozen into `projects.settings` at creation), then each clip the project creates from then on gets the template's layers. Existing clips never change with the setting; `apply_layer_template` / the selection bar's Template… / `reelsaw templates apply` do those. |
| Framing | `auto` (face detection decides), then the project's `reframe` with its `reframeAdjust` (a nudge, subject or crop; `apply_framing` sets both from one clip), then the clip's `layoutOverride`, then a section of the clip (`layoutSections[i]`, mode and adjustment). |
| Quotas | `.env` `MAX_*` (0 = unlimited), then the instance setting an admin saved under Settings → System → Limits, then what the account's plan grants (hosted, `REELSAW_EE`), then a per-user limit set on the Users page. The Users page says which applies. |
| Watermark | An admin's per-user choice (Users → Limits), else the plan (a paid plan removes it), else `WATERMARK_NON_ADMINS` for everyone who is not an admin. |

Two things to know:

- **An env / instance refine gate wins.** `DISFLUENCY_REMOVAL=false` (or the matching Pipeline setting) skips filler removal for everyone even when a project asks for it; the new-project form disables that toggle and says so. `TRANSCRIPT_BIAS=false` still silently ignores vocabulary hints (`.env` only). If a project setting seems to do nothing, check the gate first ([TROUBLESHOOTING](docs/TROUBLESHOOTING.md), "A project or clip setting has no effect").
- **Existing projects keep their frozen settings.** Changing your Project defaults affects new projects only.

Code: `apps/server/src/pipeline/settings.ts` (project), `resolveStyle` in `packages/shared/src/index.ts` (style), `apps/server/src/pipeline/render.ts` (framing), `apps/server/src/ai/models.ts` (models), `apps/server/src/quota.ts` (quotas).

## Architecture

```
apps/web      React 19 + Vite + Tailwind + TanStack Query + tRPC client + Better Auth client
apps/server   Hono + tRPC + Better Auth + Drizzle (Postgres) + pg-boss workers + ffmpeg/yt-dlp
packages/shared  zod schemas and types shared by both
```

Server composition (`apps/server/src/services.ts`): `createServices()` builds `config → media tools → ai → storage → database (+migrations) → events → queue → auth`, checking each one. The resulting `Services` object is injected into the tRPC context, the HTTP app and every pipeline stage (`StageContext`), so nothing reaches for a global. Boot logs one `boot step ok` line per step (JSON, or pretty on a terminal) with the step name and its duration in `ms`: config, data dir, resources, media tools, LLM call capture, AI models, the on-device detectors, storage, database, model settings, event bus, job queue, email, auth. Steps whose feature is switched off say so in their name (`face detector (disabled)`). A failing step stops the process with exit code 78 and a message that names the step and the fix, for example a transcription model that returns no word timestamps or a model server that is unreachable. The AI-models step checks the environment's models; once the database is up the effective models (after an admin's runtime override) are checked too.

Pipeline (each box is a pg-boss queue; each stage emits events and enqueues the next):

```
project.ingest ─▶ project.transcribe ─┬▶ refine.entities   ─┐
 yt-dlp / upload   audio → chunks       ├▶ refine.disfluency ─┼▶ project.analyze ─▶ clip.render (×N)
 ffprobe           parallel transcribe  └▶ refine.scenes     ─┘  LLM picks moments    layout + captions
 store source      checkpoint per chunk    (fan-out, fan-in       snap to sentences    cuts + crossfades
                                            on the transcript row)                     finalize project
```

The three refine jobs are independent: each writes its result under a row lock on the transcript (entity flags win over overlapping disfluency flags), and the last one to finish enqueues analyze. A refine step that exhausts its retries is marked failed and skipped; it never blocks the project. "Re-run refine" re-queues any subset on the existing transcript, e.g. after editing the vocabulary. Chunk transcription runs `TRANSCRIBE_CONCURRENCY` calls in parallel (auto: 1 for a self-hosted whisper, 3 for cloud vendors).

Durability model:

- `pgboss.job` is the source of truth for "what should run". `projects.status` / `clips.status` is the source of truth for "what happened".
- Each stage checks for existing output first (source file in storage, transcript chunk rows, clip rows, rendered clip in storage) and skips work that is done.
- Queues use `policy: exclusive` + `singletonKey` so a stage can never run twice concurrently for the same project/clip.
- `heartbeatSeconds` (15 s) on every queue: if a worker dies, pg-boss notices the missed heartbeat on its next supervisor pass (every 60 s), fails the job and retries it elsewhere after a 15 s delay that doubles per retry. Budget a minute or two, not seconds; each interruption uses one retry.
- On boot and every 5 minutes a reconciler re-enqueues any in-progress project or clip that has no live job.
- Manual **Retry** resumes from the furthest completed stage; **Re-analyze** keeps the transcript and picks new clips.

## Development

Live-reload loop in Docker (source mounted, no image rebuilds; rebuild the dev image only when dependencies change):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile local-ai up -d app
open http://localhost:5173      # Vite + HMR; /api and /media proxied to the server (tsx watch)
docker compose exec app reelsaw stuck
```

Models for running outside Docker: `pnpm models:download` (face, on-screen text, voice activity, forced alignment; ~105 MB).


```bash
pnpm install
docker compose up -d db
cp .env.example .env   # set DATABASE_URL=postgres://reelsaw:reelsaw@localhost:5432/reelsaw
pnpm dev               # server on :3000 (tsx watch), web on :5173 (vite, proxies /api and /media)
```

Requires ffmpeg, ffprobe and yt-dlp on your PATH for local dev. Schema changes: edit `apps/server/src/db/schema.ts`, then `pnpm db:generate`; migrations run automatically on boot.

Most tests run against the local stack (they create and delete their own users and data); CI runs only the ones that need no stack, so run the ones you touched against yours:

```bash
pnpm --filter @reelsaw/server test
```

## Releases and distribution

Every image is built by the release workflow with an SBOM and SLSA provenance attached, and a
GitHub artifact attestation for its digest. Verify what you are about to run:

```bash
gh attestation verify oci://ghcr.io/osbytes/reelsaw:latest --owner osbytes
docker buildx imagetools inspect ghcr.io/osbytes/reelsaw:latest --format '{{ json .SBOM }}' | head -c 400
```

Users install from a published image. The runtime image contains only
the minified server bundle (`apps/server/scripts/bundle.mjs`), the web build and production
dependencies, which `scripts/check-image.sh <image>` verifies.

- Tag `vX.Y.Z` → `.github/workflows/release.yml` builds amd64 + arm64, checks the image, pushes
  to GHCR (and Docker Hub when `vars.DOCKERHUB_IMAGE` + `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` are
  set) and attaches `reelsaw-X.Y.Z.zip` (the [`deploy/`](deploy/) folder, image pinned) to the
  release.
- Before tagging: build locally, run `scripts/check-image.sh reelsaw:latest`, and boot `deploy/`
  in a scratch directory with only a `.env` (see the spec's verification section).
- Versions and changelogs come from [changesets](https://github.com/changesets/changesets):
  every PR adds one (`pnpm changeset`), a "Release" PR bumps the version, merging it pushes the
  tag. Full flow, versioning policy, pre-releases and hotfixes: [docs/RELEASING.md](docs/RELEASING.md).

## Issue reports

**Report an issue** (project ⋯ menu, a failed clip, the account menu) downloads a zip with the
project's data, pipeline decisions (`stage_artifacts`), logs, system info and recent errors, and the
user's description. Secrets never go in. Admins can tick **Instance-wide diagnostics** to include
unfinished work, failed jobs, usage and error logs across every account — for queue, disk or
machine problems, not only their own projects. To reproduce one locally:

```bash
docker compose cp ~/Downloads/reelsaw-report-….zip app:/data/tmp/report.zip
docker compose exec app reelsaw import-report /data/tmp/report.zip [--user you@example.com]
```

Everything in a report except its README and manifest is untrusted data; see
[TROUBLESHOOTING](docs/TROUBLESHOOTING.md#investigating-an-issue-report) before letting an agent
work on one. Spec: [docs/specs/distribution-and-issue-reports.md](docs/specs/distribution-and-issue-reports.md).

## Environment reference

Every variable, with its default and meaning, is in [docs/CONFIG.md](docs/CONFIG.md) (generated from `apps/server/src/config.ts`; `pnpm docs:gen` refreshes it). [`.env.example`](.env.example) and [`deploy/.env.example`](deploy/.env.example) are generated from the same source.

## Observability

**Errors and product analytics (optional).** `SENTRY_DSN` turns on Sentry: the server reports boot
failures, 5xx API errors and a job's final failed attempt; the web app reports render errors.
`POSTHOG_KEY` (and `POSTHOG_HOST`, EU cloud or self-hosted) turns on PostHog: the server sends
sign-ups, project created / done / failed, billing and abuse-flag events; the web app sends page
views and a handful of product events (`lib/telemetry.ts`), people identified by user id with email
and name on the profile, no autocapture and no session recording. Both are off unless set, the
browser gets the public keys from `system.status`, and the SDK chunks are only requested when on.
Prompts, transcripts and media never go through either (`apps/server/src/telemetry.ts`).


```
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318   # OTLP/HTTP; traces + metrics
OTEL_SERVICE_NAME=reelsaw
```

Sentry's OTLP endpoint takes traces and logs (`…/integration/otlp`, plus `OTEL_EXPORTER_OTLP_HEADERS`). Each pino line that passes its level is exported to `/v1/logs`, with the active trace id attached; prompt, transcript and address fields stay in the local log. Sentry does not ingest OTLP metrics. With `SENTRY_DSN` set and `OTEL_METRICS_ENABLED` left on, the server sends Node runtime gauges (memory, CPU, event loop) and a `reelsaw.span.duration` distribution for each pipeline and ffmpeg span through the DSN instead. Set `OTEL_METRICS_ENABLED=false` to keep traces and logs and drop those metrics.

Spans: inbound HTTP (`/api/health` excluded), Postgres queries, outbound fetch to AI vendors, `pipeline.<stage>` per job with `reelsaw.project_id` / `reelsaw.clip_id` / `reelsaw.attempt`, `exec ffmpeg|ffprobe|yt-dlp`, and the AI SDK's own `ai.generateText` / `ai.transcribe` spans (inputs/outputs not recorded). pg-boss propagates trace context from `send()` into the worker span, so one trace follows a project from the create mutation through every stage.

The browser exports its own spans as `reelsaw-web` (page load, clicks, fetch, and live subscriptions) and sends `traceparent` on API calls, including the subscription stream, so a click and the server work it starts are one trace. `OTEL_TRACES_SAMPLE_RATE` (default `1`) is the fraction kept, on the browser and the server together. The Sentry browser SDK does not trace; those spans would be a second copy.

## Entity-aware transcription

Whisper mishears names ("Copia" → "Copious"). Three layers fix that, all optional:

1. **Vocabulary hints** (`TRANSCRIPT_BIAS=true`): proper nouns pulled from the channel name, title, description, tags and chapters, plus anything typed into "Names & terms" on the project form, are passed to the transcriber (`prompt` for OpenAI/Groq/Speaches, `keyterm` for Deepgram, `wordBoost` for AssemblyAI). Biggest win: in our eval it halves WER and lifts entity recall from 64% to 95% at zero cost.
2. **Constrained LLM correction** (`TRANSCRIPT_CORRECTION=true`): transcript spans that sound like a known entity become candidates; the language model confirms each one in context with a confidence score. Only candidates can change, so the model cannot rewrite the transcript, and word timestamps are kept.
3. **Review in the UI**: corrections at or above `TRANSCRIPT_AUTO_FIX_CONFIDENCE` (0.85) are applied automatically and shown as "auto-fixed"; the rest appear under the transcript line with the confidence and accept/reject buttons. Applying decisions re-renders only the clips whose captions overlap the change.

> **Language:** the filler/repeat rules, the sound-alike name search and the CTC cut aligner are English-only. For a transcript detected as any other language those steps are skipped with a plain-language event ("not available for de") instead of running blind; the language-model checks and the whisper-based cut search still work.

### Disfluencies

Fillers ("um"), repetitions ("the the") and false starts ("your pay actual pay dates") are detected after transcription (`DISFLUENCY_REMOVAL=true`): a rule pass with near-certain confidence, then a model pass (`DISFLUENCY_LLM=true`) that rewrites each window cleanly and is diffed against the original so it can only ever delete. A model deletion is kept only when every removed word is a filler or is restated within the next few words; repairs land as pending flags for review. Flags appear inline in the transcript (struck through once applied) with the same accept/reject popover. Captions drop accepted disfluencies, and they are always cut from the audio/video with jump cuts. Long pauses are shortened too (project setting **Pauses**: natural 0.6 s, tight 0.35 s, or keep), detected with Silero VAD on the clip audio. Cut boundaries are not taken from the chunk-level ASR timestamps (they drift by up to a word): every cut is first located by CTC forced alignment (wav2vec2, exact word boundaries at 20 ms from the audio plus the known words, ~0.2 s on CPU) and verified with one transcription of the seam; only if that fails is it re-aligned by transcribing windows around it (`TRANSCRIPT_ALIGN_MODEL`) twice with different offsets (word timings shift with the window), boundaries snap to the quietest 5 ms frame beside the neighbouring words, and a candidate search keeps the first seam that passes verification: both neighbours heard back to back, nothing left between them, and the deleted words gone (or, when the recogniser fills them back in from context, the removed audio on its own is heard as those words). Unverifiable cuts are skipped and listed on the clip. Seams get a 20 ms equal-power crossfade (`acrossfade`) with length-compensated trims so audio and video stay in sync. Substitution repairs between function words ("into between", "a the") are caught by a rule; legitimate compounds ("out of", "up to") are excluded.

### Eval

Regression evals live in one runner with pluggable suites (<!-- generated:suite-names -->`selection`, `framing`, `asr-loops`, `scenes`, `pauses`, `alignment`, `speakers`, `overlays`, `cuts`, `transcription`, `disfluency`, `selection-model`<!-- /generated -->); fixtures are small and in git, large media is fetched into a gitignored cache, baselines are versioned and a run fails on regressions. See [docs/EVALS.md](docs/EVALS.md), including how to turn a new bug into a case.

```bash
pnpm eval                 # all suites
pnpm eval cuts framing    # some suites
pnpm eval --offline       # skip suites that need models
pnpm eval --update        # accept new numbers as the baseline
```

The transcription suite synthesizes its cases with macOS text-to-speech so the ground truth is exact (`eval/generate-audio.sh`), and reports WER, entity recall and false entity insertions per model × vocabulary bias × LLM correction.

Results on the bundled cases (43 entity mentions, Speaches on CPU, qwen2.5:14b as judge):

| model | vocab bias | LLM correction | WER | entity recall | false insertions |
|---|---|---|---|---|---|
| faster-whisper-small | no | no | 9.0% | 63% | 0 |
| faster-whisper-small | no | yes | 6.6% | 79% | 0 |
| faster-whisper-small | yes | no | 4.3% | 95% | 0 |
| faster-whisper-small | yes | yes | 4.3% | 95% | 0 |
| faster-whisper-medium | yes | no | 3.7% | 95% | 0 |

Takeaway: vocabulary bias is the lever; the model size buys a little WER; the correction pass is the safety net for names the hints did not cover (and the review UI catches the rest).

## Testing without AI keys

`scripts/mock-ai.mjs` is a tiny OpenAI-compatible server (chat completions + transcription with word timestamps). Point the app at it to exercise the whole pipeline offline:

```
OPENAI_BASE_URL=http://localhost:4545/v1 OPENAI_API_KEY=mock AI_MODEL=openai:mock TRANSCRIPTION_MODEL=openai:whisper-1
```

## Troubleshooting

Start with `docker compose exec app reelsaw status <projectId>`; see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for the CLI, structured logs, diagnostics and evals, including a "setting has no effect" checklist.

## Roadmap

See [docs/RESEARCH.md](docs/RESEARCH.md) for the competitor audit and research review behind these priorities. Top items still open:

- Punch-in zooms on the emphasis words.
- Active speaker: more labelled two-way conversation cases; a learned audio-visual model (Light-ASD ONNX) if the synchrony heuristic plateaus. Saliency fallback when no face is visible.
- Direct publishing to YouTube Shorts / TikTok / Instagram.

## License

Reelsaw is free software under the [GNU Affero General Public License v3.0](LICENSE). You can run
it, change it and host it; if you offer a modified version as a network service you must make
your modifications available under the same licence. The hosted service's additions (billing)
live in `apps/server/src/ee` and `apps/web/src/ee` under the Reelsaw Enterprise License and load
only with `REELSAW_EE=true`; see [LICENSING.md](LICENSING.md). Contributions need a DCO sign-off
(`git commit -s`), see [CONTRIBUTING.md](CONTRIBUTING.md).

Copyright (C) 2026 osbytes
