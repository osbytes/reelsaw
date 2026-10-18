<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.png">
    <img src="docs/assets/logo-light.png" alt="Reelsaw" width="300">
  </picture>
</p>

# Reelsaw

Self-hosted, AI-powered long-form → short-form video clipper. Paste a YouTube link or upload a video; Reelsaw transcribes it, asks an LLM for the most clippable moments, then renders vertical 9:16 clips with word-highlight captions and a hook overlay.

Pure TypeScript. Any AI vendor via the [AI SDK](https://ai-sdk.dev). One-step deploy with Docker Compose.

## Features

**Pipeline**

- **Any AI vendor** – language model, transcription model and caption-alignment model are each a `provider:model` string: OpenAI, Anthropic, Google, Groq, Deepgram, AssemblyAI, Vercel AI Gateway, or any OpenAI-compatible server (Ollama, vLLM, LM Studio, local Whisper servers). Fully local with no API keys is supported.
- **Research-backed clip selection** – map → pool → rank: the transcript is chunked at long pauses with 20% overlap (no "lost in the middle" on long videos), every standalone moment is collected per chunk in parallel, candidates are snapped/deduped, then scored on a rubric (hook / value / flow / shareability, plus relevance with a focus) as the median of k samples, and the top clips get a pairwise head-to-head pass with positions swapped to cancel judge bias. No target count: weak picks (< 45) are dropped; optional "at most N" cap, and "Find clips about …" keeps only on-topic moments. Click a clip's score for the breakdown. `ANALYZE_CONCURRENCY`, `ANALYZE_SCORE_SAMPLES`, `ANALYZE_PAIRWISE` tune cost (auto: 1 call at a time, 1 sample, no pairwise for self-hosted models; 4 / 3 / on for cloud).
- **Clean transcripts** – names are fixed from vocabulary hints and a constrained LLM correction, and fillers, repetitions and false starts are cut with jump cuts. Every cut is located by forced alignment and checked by listening to the seam, so karaoke highlights land on the syllable. Each fix shows inline in the transcript with accept/reject, and long pauses can be shortened (details below).
- **Smart 9:16 reframing** – UltraFace (1.2 MB ONNX, CPU, ~7 ms/frame via `onnxruntime-node`) samples each clip at 4 fps and picks a layout per segment (clips are split at scene cuts and face-presence changes, so a picture-in-picture intro can be "fit" and the talking head after it "face"): **face** (crop follows the speaker with "heavy tripod" smoothing: dead zone, capped pan speed, instant snap at scene cuts), **split** (two speakers stacked), **stack** (slides/screen on top, zoomed webcam below), or **fit** (whole frame over a blurred background when there is no face, e.g. graphics and b-roll). With two people in a wide shot the crop follows whoever is talking (mouth motion correlated with the audio envelope, minimum 2.5 s per shot), falling back to a split when detection isn't confident. Override per project or per clip. Reference for every layout, its triggers, caveats and fixtures: [docs/LAYOUTS.md](docs/LAYOUTS.md).
- **Captions** – AI-picked key words per clip coloured and enlarged (editable in the editor), readability limits (≈2 short lines, comma/sentence breaks, 0.7 s minimum on screen), ASS karaoke word highlight (any colour), boxed, or outlined; size, words on screen (1 = one word at a time), uppercase; hook overlay with its own duration. Caption and hook positions are free x/y set by dragging on a live 9:16 preview that uses the renderer's crop math and font metrics, with a platform safe-zone overlay. Project-wide defaults, per-clip overrides. Burned in with ffmpeg + libass.

**Editing**

- **Workspace and clip editor** – source player and clickable transcript on the left, clips streaming in on the right as they render, with score, layout badge, post caption + hashtags copy and download. The editor has a live preview of the source with the clip's framing and captions and a multi-lane timeline (ruler, transcript words, clip range, layout track) with zoom, snapping to words/scene cuts/playhead, nudge buttons, typed timestamps and I/O keys for frame-accurate trims. Split the layout track (⌘/Ctrl+B, the Split button, a double-click or the right-click menu) into sections that are Auto or forced to face/split/stack/fit/centre; drag the picture to re-centre a section; add, drag and remove transitions; ⌘/Ctrl+Z / ⇧⌘Z undo and redo every edit.
- **Deletes can be undone** – deleting a project stops its work and hides it, with an Undo in the toast; it stays restorable for `DELETED_RETENTION_DAYS` (7) before its files are removed. Re-picking moments keeps every clip you made or edited (text, bounds, framing, style, intro/outro) and only replaces untouched AI picks, which can be restored too. The same through MCP (`restore_project`, `restore_clip`) and the CLI (`reelsaw deleted`, `restore`, `restore-clip`, `purge`).
- **Command palette and bulk export** – ⌘K searches projects and clips with status, length and age, opens a row's actions (open, export, resume, retry failed clips, re-run refine, re-render, download, delete), takes pasted links (one project each, or opens the existing one) and offers retry-all shortcuts. "Export all" zips every rendered clip with platform-ready metadata: a paste-ready `.txt` (title, description, tags, caption), a `.youtube.json` (YouTube Data API v3 `videos.insert` body, private by default) and a `.tiktok.json` (Content Posting API `post_info`, `SELF_ONLY`) per clip, plus `manifest.json`, `clips.csv` (with rendered duration) and a README. Descriptions carry a timestamped link to the exact moment in the parent video.

**Intros and outros**

- **Intro and outro library** – the **Library** page keeps several videos or images (PNG or JPG, shown 1 to 10 s); drop many files at once (duplicates are detected), view them enlarged, see which projects and clips use each one, remove with Undo, and choose the default new projects start with. Each clip is rendered as intro + clip + outro in a single encode, fitted to vertical over a blurred background.
- **Per project and per clip** – a project follows the default, uses none or a specific item; each clip can follow the project, use none or pick its own, set in the editor, from a clip card or for several selected clips at once. The editor shows what a clip adds around its source range, changes re-render only when confirmed, and an unusable asset is skipped with a plain-language event instead of failing the clip.

**Agents and automation**

- **MCP server** – `/api/mcp` (Streamable HTTP) lets Claude Code, Claude Desktop, Cursor or a script create projects, wait for them, read timed transcripts, edit, create and re-render clips, manage the intro/outro library and download the results. Authenticate with an API key from Settings, or with `MCP_OAUTH=true` so claude.ai and Claude Desktop connectors sign in through the browser.
- **Operator CLI** – `docker compose exec app reelsaw …` inspects and fixes a running instance: `status`, `events`, `clip`, `rerender`, `stuck`, `recover`, `logs`, `cuts`, `align`, `hear`, `flags`, `storage`, `retention`, `deleted`, `restore`, `purge`, `users`, `approve`, `make-admin`, `bumpers`, `import-report` and more.

**Hosting and accounts**

- **Accounts, approval and quotas** – the first account is the admin; `SIGNUP_MODE=open|approval|closed` decides who gets in, and admins approve, suspend, promote and remove people on the **Users** page, with usage per account (projects, source minutes, clips, model calls and tokens, stored bytes). Optional per-user quotas, retention of old files, captcha on sign-in, email (approval notices, password reset, verification) and terms/privacy links. Everyone has their own **Project defaults** (vocabulary, instructions, language, clip length, pauses, caption style, intro and outro) and API keys.
- **Models and providers at runtime** – admins switch the language, transcription and alignment models under Settings → System → Models without a restart: pick a provider, enter its key or server URL there (stored encrypted, never shown again), and choose from live model lists; local Ollama and Speaches models download with a progress bar. Keys and models are tested when saved.

**Operations**

- **Reliable, resumable, scalable** – every stage is a [pg-boss](https://github.com/timgit/pg-boss) job in Postgres that checkpoints its output, so a crashed or restarted worker picks up where it left off; heartbeats re-queue jobs from dead workers within seconds and a reconciler re-enqueues anything orphaned. Run extra `worker` containers to scale. Every run (first pass, retry, re-render, re-analyze) is recorded with its own timings, and the UI shows elapsed against expected time per stage, learned from your finished projects. The browser gets live updates over a tRPC SSE subscription with automatic reconnect.
- **Storage and install** – local volume or `s3` (AWS S3, MinIO, Cloudflare R2, Backblaze B2…); superseded renders, expired sources and orphaned files are swept hourly (`reelsaw storage` reports, `reelsaw storage sweep` runs it). One-line installers for macOS/Linux (bash) and Windows (PowerShell), and **Report an issue** saves a zip of a project's data, decisions and logs, with secrets left out.
- **Observable and fail-fast** – every service is built in `main` and self-checks, so the process exits with a readable reason if a model id is wrong, a key is missing, a binary is absent, the bucket is unreachable or the DB is down. `LLM_TRACE=logs` or `langfuse` captures every prompt/response (tokens, latency, project/clip/stage), and `OTEL_ENABLED=true` turns on OTLP traces and metrics for HTTP, Postgres, pg-boss jobs, AI SDK calls, ffmpeg/yt-dlp and each stage.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (principles, tests, sign-off). Roadmap for learning from user decisions: [docs/SELF-IMPROVEMENT.md](docs/SELF-IMPROVEMENT.md).

Read [docs/PRINCIPLES.md](docs/PRINCIPLES.md) first: the consistency, concurrency and UI rules every change follows. Agent instructions live in `AGENTS.md` / `CLAUDE.md`.

## Install (no source needed)

Fully local, with Ollama for the language model and Speaches for speech-to-text. Needs Docker; on
macOS install [Ollama](https://ollama.com/download) first:

```bash
curl -fsSL https://raw.githubusercontent.com/osbytes/reelsaw/main/deploy/install.sh | bash
```

On Windows (Docker Desktop), in PowerShell:

```powershell
irm https://raw.githubusercontent.com/osbytes/reelsaw/main/deploy/install.ps1 | iex
```

WSL2 users can run the bash one-liner as is (with Docker Desktop's WSL integration on).

It writes `~/reelsaw` (compose file + `.env` with generated secrets), pulls the published image and
the model (`qwen2.5:14b`, ~9 GB; `REELSAW_LLM=qwen2.5:7b` for less RAM), starts everything and waits
until http://localhost:3000 answers. Hosted providers and manual setup: [deploy/README.md](deploy/README.md).
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
| `AI_MODEL` | `openai:gpt-4o-mini`, `anthropic:claude-sonnet-4-5`, `google:gemini-2.5-flash`, `groq:llama-3.3-70b-versatile`, `gateway:anthropic/claude-sonnet-4-5`, `compat:llama3.1` |
| `TRANSCRIPTION_MODEL` | `openai:whisper-1`, `openai:gpt-4o-transcribe`, `deepgram:nova-3`, `assemblyai:best`, `groq:whisper-large-v3-turbo` |

### Fully local (no API keys)

Ollama only serves language models; it has no speech-to-text. So the local stack is Ollama for `AI_MODEL` plus [Speaches](https://github.com/speaches-ai/speaches) (faster-whisper behind an OpenAI-compatible API, word timestamps supported) for `TRANSCRIPTION_MODEL`. Both ship as a compose profile:

```bash
docker compose --profile local-ai up -d            # Speaches; use your native Ollama (macOS: Metal GPU)
docker compose --profile local-ai --profile ollama up -d   # Linux: also run Ollama in a container
ollama pull llama3.1:8b                            # or: docker compose exec ollama ollama pull llama3.1:8b
```

`.env`:

```
AI_MODEL=compat:llama3.1:8b
OPENAI_COMPATIBLE_BASE_URL=http://host.docker.internal:11434/v1   # native Ollama; http://ollama:11434/v1 for the container
OPENAI_COMPATIBLE_API_KEY=ollama
TRANSCRIPTION_MODEL=openai:Systran/faster-whisper-small
OPENAI_BASE_URL=http://speaches:8000/v1
OPENAI_API_KEY=local
```

Notes: the app requests `response_format: json_schema` from the compat server (`OPENAI_COMPATIBLE_STRUCTURED_OUTPUTS=false` to disable) and falls back to lenient parsing when a model ignores it, but small models still pick weak moments and write bland hooks. gemma3 4b works; llama3.1 8b, qwen2.5 14b or gemma3 12b are noticeably better. On first boot the app auto-downloads the whisper model into Speaches and verifies the Ollama model is pulled (it exits with `ollama pull <model>` otherwise). Speaches CPU with `faster-whisper-small` runs roughly real-time; use the `latest-cuda` image and `faster-whisper-large-v3` on a GPU. The `OPENAI_*` variables are reused for Speaches because it speaks the OpenAI audio API, which is why the LLM goes through the `compat` provider instead.

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

These factors are only the starting point. The app learns from its own finished projects: each stage's expected time is the median over your recent projects that ran with the same models, shown next to the elapsed time on the project page while it runs, in the activity feed when a stage finishes (`Transcribe finished in 4:50 (expected ~4:00)`), and as a per-stage expected vs actual table under Settings → Machine. There is no calibration step; the runs are the calibration.

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
| `open` (default) | Anyone can sign up and use the app at once. Right for a single-user box. |
| `approval` | New accounts wait on a "Waiting for approval" page until an admin approves them (Users page, or `reelsaw approve <email>`). Admins get an email when `EMAIL_DRIVER` is set. |
| `closed` | No sign-ups. `ALLOW_SIGNUP=false` still works as an alias. |

Every user has **Settings → Project defaults** (vocabulary, instructions, language, clip length,
pauses, caption style…) applied to each new project they or their agents start; the new-project
form starts from them and can save its current values back. Admins also see the **System** section
(models, storage, resource meters) and `/api/health` includes machine numbers only for them (or
with `HEALTH_DETAILS=true`).

Suspending an account (Users page) ends its sessions and refuses its API keys at the next request;
removing one deletes its projects, clips and files. Locked out? `docker compose exec app reelsaw
make-admin you@example.com` promotes an account from the shell.

Email (`EMAIL_DRIVER=smtp|resend`, `EMAIL_FROM`, `SMTP_URL` or `RESEND_API_KEY`) turns on approval
notices, password reset and, with `REQUIRE_EMAIL_VERIFICATION=true`, verification before the
first sign-in. Without it everything else works; approvals are handled on the Users page.

## Hosting for many people

Everything below is off by default and switched on by environment (`deploy/.env.example` lists
them), so a single-user box stays as it is:

- **Quotas**: `MAX_PROJECTS_PER_USER`, `MAX_SOURCE_MINUTES_PER_DAY`, `MAX_NEW_PROJECTS_PER_HOUR`
  (0 = unlimited), with per-user overrides on the Users page. A refusal is a sentence that says
  what to do ("Daily limit of 120 minutes reached; resets at 00:00 UTC"). Length is checked once
  the video is probed, so an over-long download fails the project with that reason.
- **Usage** (Users → Usage): projects, minutes of source, clips rendered, model calls and tokens
  (every model call writes a `llm_usage` row attributed to the project's owner), stored bytes.
- **Retention**: `SOURCE_RETENTION_DAYS` / `CLIP_RETENTION_DAYS` delete stored files from finished
  projects; rows and history stay, the project page offers "fetch again" and clips re-render.
  `reelsaw retention` runs a sweep by hand.
- **History pruning**: `EVENT_RETENTION_DAYS` (90), `LLM_USAGE_RETENTION_DAYS` (180) and
  `ADMIN_EVENT_RETENTION_DAYS` (365) delete old rows in batches once a day (0 keeps everything);
  a project's run skeleton (created, run started, done) is always kept.
- **Bot protection**: `CAPTCHA_PROVIDER` (Cloudflare Turnstile, reCAPTCHA, hCaptcha) with site and
  secret keys puts a widget on sign-up and sign-in.
- **yt-dlp from a datacentre**: YouTube refuses many cloud IPs. `YTDLP_PROXY` and
  `YTDLP_COOKIES_FILE` help; a blocked download fails with "upload the file instead".
- **Legal**: `TERMS_URL` / `PRIVACY_URL` appear on the sign-up form.
- **MCP over OAuth** (`MCP_OAUTH=true`): Reelsaw becomes an OAuth 2.1 authorization server for
  MCP connectors (claude.ai, Claude Desktop): dynamic client registration, sign-in and a consent
  page in the browser, discovery at `/.well-known/oauth-protected-resource/api/mcp` (which names
  the issuer, `<APP_URL>/api/auth`, whose metadata is at
  `/.well-known/oauth-authorization-server/api/auth`). API keys keep working for CLIs.

## MCP: drive Reelsaw from an agent

Reelsaw is an MCP server (Model Context Protocol, Streamable HTTP) at `/api/mcp`. Create an API key
in **Settings → API keys and MCP** (shown once) and point a client at it:

```bash
claude mcp add --transport http reelsaw https://your-host/api/mcp --header "Authorization: Bearer rs_…"
```

```json
{ "mcpServers": { "reelsaw": { "type": "http", "url": "https://your-host/api/mcp", "headers": { "Authorization": "Bearer rs_…" } } } }
```

Tools: `list_projects`, `get_project`, `create_project` (URL → pipeline), `wait_for_project`,
`get_transcript` (timed sentences, range + truncation), `get_project_events`, `get_clip`,
`update_clip`, `create_clip`, `rerender_clip`, `rerender_clips` (several at once), `export_project` (zip link, optionally only some `clipIds`), `retry_project`, `reanalyze_project`,
`delete_project`. Intro/outro ("bumper") tools: `list_bumpers`, `add_bumper` (from a URL or an
upload id), `set_default_bumper`, `remove_bumper`, `restore_bumper`, `bumper_usage`,
`set_project_bumpers`, `set_clip_bumpers` (one clip or many; `rerender: true` re-renders only those
clips); `get_project` / `get_clip` show each clip's effective intro/outro and where it comes from.
They call the same tRPC procedures as the web app, so ownership checks and
validation are identical (`apps/server/src/mcp.ts`). The same key also authenticates tRPC
(`/api/trpc/*`), uploads and media downloads, so an agent can fetch the rendered clips. Keys are
hashed at rest (`@better-auth/api-key`); revoke them from Settings.

## Architecture

```
apps/web      React 19 + Vite + Tailwind + TanStack Query + tRPC client + Better Auth client
apps/server   Hono + tRPC + Better Auth + Drizzle (Postgres) + pg-boss workers + ffmpeg/yt-dlp
packages/shared  zod schemas and types shared by both
```

Server composition (`apps/server/src/services.ts`): `createServices()` builds `config → media tools → ai → storage → database (+migrations) → events → queue → auth`, checking each one. The resulting `Services` object is injected into the tRPC context, the HTTP app and every pipeline stage (`StageContext`), so nothing reaches for a global. Boot output looks like:

```
[boot] config ok
[boot] media tools (ffmpeg, ffprobe, yt-dlp) ok
[boot] ai models (anthropic:claude-sonnet-4-5, deepgram:nova-3) ok
[boot] storage (s3:reelsaw) ok
...
[boot] startup failed at step "ai models (anthropic:claude-sonnet-4-5, anthropic:whisper)":
  TRANSCRIPTION_MODEL: provider "anthropic" has no transcription models ("anthropic:whisper"). Use e.g. openai:whisper-1, deepgram:nova-3, ...
```

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
- `heartbeatSeconds` on every queue: if a worker dies, pg-boss fails the job within ~30 s and retries it elsewhere (with backoff).
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

Tests run against the local stack (they create and delete their own users and data):

```bash
pnpm --filter @reelsaw/server test
```

## Releases and distribution

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
user's description. Secrets never go in. To reproduce one locally:

```bash
docker compose cp ~/Downloads/reelsaw-report-….zip app:/data/tmp/report.zip
docker compose exec app reelsaw import-report /data/tmp/report.zip [--user you@example.com]
```

Everything in a report except its README and manifest is untrusted data; see
[TROUBLESHOOTING](docs/TROUBLESHOOTING.md#investigating-an-issue-report) before letting an agent
work on one. Spec: [docs/specs/distribution-and-issue-reports.md](docs/specs/distribution-and-issue-reports.md).

## Environment reference

See [`.env.example`](.env.example) for every variable with comments.

## Observability

```
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318   # OTLP/HTTP; traces + metrics
OTEL_SERVICE_NAME=reelsaw
```

Spans: inbound HTTP (`/api/health` excluded), Postgres queries, outbound fetch to AI vendors, `pipeline.<stage>` per job with `reelsaw.project_id` / `reelsaw.clip_id` / `reelsaw.attempt`, `exec ffmpeg|ffprobe|yt-dlp`, and the AI SDK's own `ai.generateText` / `ai.transcribe` spans (inputs/outputs not recorded). pg-boss propagates trace context from `send()` into the worker span, so one trace follows a project from the create mutation through every stage.

## Entity-aware transcription

Whisper mishears names ("Copia" → "Copious"). Three layers fix that, all optional:

1. **Vocabulary hints** (`TRANSCRIPT_BIAS=true`): proper nouns pulled from the channel name, title, description, tags and chapters, plus anything typed into "Names & terms" on the project form, are passed to the transcriber (`prompt` for OpenAI/Groq/Speaches, `keyterm` for Deepgram, `wordBoost` for AssemblyAI). Biggest win: in our eval it halves WER and lifts entity recall from 64% to 95% at zero cost.
2. **Constrained LLM correction** (`TRANSCRIPT_CORRECTION=true`): transcript spans that sound like a known entity become candidates; the language model confirms each one in context with a confidence score. Only candidates can change, so the model cannot rewrite the transcript, and word timestamps are kept.
3. **Review in the UI**: corrections at or above `TRANSCRIPT_AUTO_FIX_CONFIDENCE` (0.85) are applied automatically and shown as "auto-fixed"; the rest appear under the transcript line with the confidence and accept/reject buttons. Applying decisions re-renders only the clips whose captions overlap the change.

### Disfluencies

Fillers ("um"), repetitions ("the the") and false starts ("your pay actual pay dates") are detected after transcription (`DISFLUENCY_REMOVAL=true`): a rule pass with near-certain confidence, then a model pass (`DISFLUENCY_LLM=true`) that rewrites each window cleanly and is diffed against the original so it can only ever delete. A model deletion is kept only when every removed word is a filler or is restated within the next few words; repairs land as pending flags for review. Flags appear inline in the transcript (struck through once applied) with the same accept/reject popover. Captions drop accepted disfluencies, and they are always cut from the audio/video with jump cuts. Long pauses are shortened too (project setting **Pauses**: natural 0.6 s, tight 0.35 s, or keep), detected with Silero VAD on the clip audio. Cut boundaries are not taken from the chunk-level ASR timestamps (they drift by up to a word): every cut is first located by CTC forced alignment (wav2vec2, exact word boundaries at 20 ms from the audio plus the known words, ~0.2 s on CPU) and verified with one transcription of the seam; only if that fails is it re-aligned by transcribing windows around it (`TRANSCRIPT_ALIGN_MODEL`) twice with different offsets (word timings shift with the window), boundaries snap to the quietest 5 ms frame beside the neighbouring words, and a candidate search keeps the first seam that passes verification: both neighbours heard back to back, nothing left between them, and the deleted words gone (or, when the recogniser fills them back in from context, the removed audio on its own is heard as those words). Unverifiable cuts are skipped and listed on the clip. Seams get a 20 ms equal-power crossfade (`acrossfade`) with length-compensated trims so audio and video stay in sync. Substitution repairs between function words ("into between", "a the") are caught by a rule; legitimate compounds ("out of", "up to") are excluded.

### Eval

Regression evals live in one runner with pluggable suites (transcription, cuts, overlays, framing, selection); fixtures are small and in git, large media is fetched into a gitignored cache, baselines are versioned and a run fails on regressions. See [docs/EVALS.md](docs/EVALS.md), including how to turn a new bug into a case.

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

Start with `docker compose exec app reelsaw status <projectId>`; see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for the CLI (`status`, `events`, `clip`, `rerender`, `cuts`, `align`, `hear`, `flags`, `storage`, `bumpers`), structured logs, diagnostics and evals.

## Roadmap

See [docs/RESEARCH.md](docs/RESEARCH.md) for the competitor audit and research review behind these priorities. Top items:

- Punch-in zooms on the emphasis words.
- Active speaker: more labelled two-way conversation cases; a learned audio-visual model (Light-ASD ONNX) if the synchrony heuristic plateaus. Saliency fallback when no face is visible.
- SRT/VTT export.
- Direct publishing to YouTube Shorts / TikTok / Instagram.
- Hosted edition: billing and plans on top of the shipped accounts, quotas and usage ([docs/specs/hosted.md](docs/specs/hosted.md)).

## License

Reelsaw is free software under the [GNU Affero General Public License v3.0](LICENSE). You can run
it, change it and host it; if you offer a modified version as a network service you must make
your modifications available under the same licence. Hosted-only additions (billing, for example)
will live under `ee/` with their own licence; nothing in the repository is there yet. Contributions
need a DCO sign-off (`git commit -s`), see [CONTRIBUTING.md](CONTRIBUTING.md).

Copyright (C) 2026 osbytes
