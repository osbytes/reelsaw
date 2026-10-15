# Reelsaw

Self-hosted, AI-powered long-form → short-form video clipper. Paste a YouTube link or upload a video; Reelsaw transcribes it, asks an LLM for the most clippable moments, then renders vertical 9:16 clips with word-highlight captions and a hook overlay.

Pure TypeScript. Any AI vendor via the [AI SDK](https://ai-sdk.dev). One-step deploy with Docker Compose.

## Features

- **Any AI vendor** – language model and transcription model are each a `provider:model` string. OpenAI, Anthropic, Google, Groq, Deepgram, AssemblyAI, Vercel AI Gateway, or any OpenAI-compatible server (Ollama, vLLM, LM Studio, local Whisper servers).
- **Reliable, resumable pipeline** – every stage is a [pg-boss](https://github.com/timgit/pg-boss) job stored in Postgres. Stages are idempotent and checkpoint their output (per-chunk transcripts, clip rows, rendered files), so a crashed or restarted worker simply picks up where it left off. Heartbeats re-queue jobs from dead workers within seconds; a reconciler re-enqueues anything orphaned.
- **Event driven UI** – workers emit events through Postgres `NOTIFY`; the browser gets them over a tRPC SSE subscription with automatic reconnect and catch-up.
- **Pluggable storage** – `STORAGE_DRIVER=local` (Docker volume) or `s3` (AWS S3, MinIO, Cloudflare R2, Backblaze B2…).
- **Smart 9:16 reframing** – UltraFace (1.2 MB ONNX, CPU, ~7 ms/frame via `onnxruntime-node`) samples each clip at 4 fps and picks a layout per segment (clips are split at scene cuts and face-presence changes, so a picture-in-picture intro can be "fit" and the talking head after it "face"): **face** (crop follows the speaker with "heavy tripod" smoothing: dead zone, capped pan speed, instant snap at scene cuts), **split** (two speakers stacked), **stack** (slides/screen on top, zoomed webcam below), or **fit** (whole frame over a blurred background when there is no face, e.g. graphics and b-roll). Override per project or per clip.
- **Captions** – AI-picked key words per clip coloured and enlarged (editable in the editor), readability limits (≈2 short lines, comma/sentence breaks, 0.7 s minimum on screen), ASS karaoke word highlight (any colour), boxed, or outlined; size, words on screen (1 = one word at a time), uppercase; hook overlay with its own duration. Caption and hook positions are free x/y set by dragging on a live 9:16 preview that uses the renderer's crop math and font metrics, with a platform safe-zone overlay. Project-wide defaults, per-clip overrides. Burned in with ffmpeg + libass.
- **Research-backed clip selection** – map → pool → rank: the transcript is chunked at long pauses with 20% overlap (no "lost in the middle" on long videos), every standalone moment is collected per chunk in parallel, candidates are snapped/deduped, then scored on a rubric (hook / value / flow / shareability, plus relevance with a focus) as the median of k samples, and the top clips get a pairwise head-to-head pass with positions swapped to cancel judge bias. No target count: weak picks (< 45) are dropped; optional "at most N" cap. Click a clip's score for the breakdown. `ANALYZE_CONCURRENCY`, `ANALYZE_SCORE_SAMPLES`, `ANALYZE_PAIRWISE` tune cost (auto: 1 call at a time, 1 sample, no pairwise for self-hosted models; 4 / 3 / on for cloud).
- **Focus** – "Find clips about …" keeps only on-topic moments and adds a relevance score.
- **Clip editor** – live preview of the source with the clip's framing and captions; a multi-lane timeline (ruler, transcript words, clip range, layout track) with zoom, snapping to words/scene cuts/playhead, nudge buttons, typed timestamps and I/O keys for frame-accurate trims. Split the layout track with ⌘/Ctrl+B, the Split button, a double-click or the right-click menu (which also sets framing, removes transitions and sets in/out); ⌘/Ctrl+Z / ⇧⌘Z undo and redo every edit. Drag the picture to re-centre any section. The layout track splits a clip into sections: each is Auto (face detection decides) or forced to face/split/stack/fit/centre; add, drag and remove transitions. Accepted disfluencies are always cut from the video.
- **Workspace UI** – source player and clickable transcript on the left, clips streaming in on the right as they render, synchronized seeking, score, layout badge, post caption + hashtags copy, download. Clip editor: drag in/out range or click words to retrim, retitle, change layout, re-render.
- **Bulk export** – "Export all" zips every rendered clip with platform-ready metadata: a paste-ready `.txt` (title, description, tags, caption), a `.youtube.json` (YouTube Data API v3 `videos.insert` body, private by default) and a `.tiktok.json` (Content Posting API `post_info`, `SELF_ONLY`) per clip, plus `manifest.json`, `clips.csv` and a README. Descriptions carry a timestamped link to the exact moment in the parent video; the README explains YouTube Studio's per-Short "Related video" field, which no upload API exposes.
- **Horizontal scale** – run extra `worker` containers; all coordination goes through Postgres.
- **Fail-fast boot (12-factor)** – every service is built in `main`, self-checks, and the process exits with a readable reason if a model id is wrong, a key is missing, a binary is absent, the bucket is unreachable, or the DB is down. No deferred "works until the first job" surprises.
- **Optional OpenTelemetry** – `OTEL_ENABLED=true` turns on OTLP traces + metrics for HTTP, Postgres, outbound fetch, pg-boss jobs, AI SDK calls, ffmpeg/yt-dlp executions and each pipeline stage.

## Quick start

```bash
git clone <this repo> reelsaw && cd reelsaw
cp .env.example .env
# edit .env: set BETTER_AUTH_SECRET, APP_URL, and at least one AI provider key
docker compose up -d --build
```

Open http://localhost:3000, create an account, start a project. Set `ALLOW_SIGNUP=false` afterwards if the instance is public.

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

```bash
pnpm install
docker compose up -d db
cp .env.example .env   # set DATABASE_URL=postgres://reelsaw:reelsaw@localhost:5432/reelsaw
pnpm dev               # server on :3000 (tsx watch), web on :5173 (vite, proxies /api and /media)
```

Requires ffmpeg, ffprobe and yt-dlp on your PATH for local dev. Schema changes: edit `apps/server/src/db/schema.ts`, then `pnpm db:generate`; migrations run automatically on boot.

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

Fillers ("um"), repetitions ("the the") and false starts ("your pay actual pay dates") are detected after transcription (`DISFLUENCY_REMOVAL=true`): a rule pass with near-certain confidence, then a model pass (`DISFLUENCY_LLM=true`) that rewrites each window cleanly and is diffed against the original so it can only ever delete. A model deletion is kept only when every removed word is a filler or is restated within the next few words; repairs land as pending flags for review. Flags appear inline in the transcript (struck through once applied) with the same accept/reject popover. Captions always drop accepted disfluencies; the project option "Cut stutters & fillers from the video" also removes them from the audio/video with jump cuts. Cut boundaries are not taken from the chunk-level ASR timestamps (they drift by up to a word): every cut is re-aligned by transcribing a 3 s window around it (`TRANSCRIPT_ALIGN_MODEL`, a bigger whisper is cheap here), each boundary then moves to the quietest 5 ms frame in the gap beside the neighbouring word on a zero crossing, and finally the seam audio is rendered on its own, transcribed, and the cut is kept only if both neighbours are still heard and the deleted words are not. Seams get a 20 ms equal-power crossfade (`acrossfade`) with length-compensated trims so audio and video stay in sync. Substitution repairs between function words ("into between", "a the") are caught by a rule; legitimate compounds ("out of", "up to") are excluded.

### Eval

`eval/cases.json` holds short scripts with known entities; `eval/generate-audio.sh` synthesizes them with macOS text-to-speech so the ground truth is exact. The harness reports WER, entity recall, false entity insertions and how many corrections were auto-applied vs flagged, for every combination of model × vocabulary bias × LLM correction:

```bash
./eval/generate-audio.sh
DATABASE_URL=x BETTER_AUTH_SECRET=xxxxxxxxxxxxxxxx OPENAI_BASE_URL=http://localhost:8000/v1 OPENAI_API_KEY=local \
AI_MODEL=compat:qwen2.5:14b OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1 \
pnpm --filter @reelsaw/server eval:transcription -- --models openai:Systran/faster-whisper-small,openai:Systran/faster-whisper-medium
```

Add real recordings by dropping an mp3 into `eval/audio/` and a case with the reference text.

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

Start with `docker compose exec app reelsaw status <projectId>`; see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for the CLI (`status`, `events`, `clip`, `rerender`, `cuts`, `align`, `hear`, `flags`), structured logs, diagnostics and evals.

## Roadmap

See [docs/RESEARCH.md](docs/RESEARCH.md) for the competitor audit and research review behind these priorities. Top items:

- Punch-in zooms on the emphasis words.
- Silero VAD silence trimming; windowed CTC forced alignment for cut seams.
- Active-speaker selection in split/face layouts (diarization mapped to face tracks, later Light-ASD ONNX) and a saliency fallback when no face is visible.
- SRT/VTT export.
- Direct publishing to YouTube Shorts / TikTok / Instagram.
