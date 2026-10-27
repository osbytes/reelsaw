# Configuration reference

Reelsaw is configured by environment variables (12-factor): a `.env` next to `docker-compose.yml`, or
the process environment. Empty values count as unset. [`.env.example`](../.env.example) (from source) and
[`deploy/.env.example`](../deploy/.env.example) (hosted install) list the same variables in file form.

Not everything is set here: admins change the **models** and **provider keys** at runtime under
Settings → System → Models, per-user quotas on the Users page, and the variables marked
"Runtime setting" below (sign-up policy, captcha, quotas, retention, upload limits, …) under
Settings → System, with `reelsaw settings` or the `set_instance_settings` tool. For those the
variable is the default and the stored value wins. The order in which `.env`, admin settings and
per-project settings combine is in the README under "Settings and precedence".

The tables below are generated from the zod schema in `apps/server/src/config.ts` (names, types,
defaults) and `apps/server/scripts/docs-meta.ts` (descriptions). Run `pnpm docs:gen` after changing
either; `pnpm docs:check` fails when this file is stale.

<!-- generated:env -->
### Core

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enforces a 32+ character BETTER_AUTH_SECRET. The image sets it. |
| `PORT` | `3000` | Port the HTTP server listens on. |
| `APP_URL` | `http://localhost:3000` | Public URL people open in the browser; used for auth cookies, CORS, the OAuth issuer and links in emails. |
| `REELSAW_VERSION` | `dev` | Release version baked into the image at build time (`dev` from source). |
| `REELSAW_COMMIT` | `unknown` | Git commit baked into the image at build time. |
| `REELSAW_BUILT_AT` | `unknown` | Build timestamp baked into the image. |
| `UPDATE_CHECK` | `true` | Ask GitHub for the latest release and tell admins in Settings → System, `reelsaw version` and the `check_for_update` tool when a newer one exists. Only the request leaves the machine (no ids, no usage). `false` never contacts GitHub. Runtime setting: admins can change it under Settings → System without a restart. |
| `UPDATE_CHECK_URL` | `https://api.github.com/repos/osbytes/reelsaw/releases/latest` | Releases endpoint the check asks (GitHub's `releases/latest` of this repository); change it for a fork or a mirror. |
| `UPDATE_CHECK_HOURS` | `6` | Hours between update checks (1–168). "Check now" in Settings asks at most once a minute. |
| `DATABASE_URL` | `x` | Postgres connection string. Compose sets it; set it yourself when running from source. |
| `BETTER_AUTH_SECRET` | `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` | 32+ random characters (`openssl rand -base64 32`). Signs sessions and encrypts the provider keys admins enter in Settings; rotating it makes those keys unreadable. |
| `DATA_DIR` | `./data` | Working directory for uploads, per-project scratch files, the local storage driver and caches. |
| `WEB_DIST` | unset | Directory of the built web app to serve. Unset: the bundled location. |
| `RUN_WORKERS` | `true` | Process pipeline jobs in this process. false for a web-only container. At least one of RUN_HTTP / RUN_WORKERS must be on. |
| `RUN_HTTP` | `true` | Serve HTTP in this process. false for a worker-only container. |
| `WORKER_ID` | unset | Stable name for this process on Settings → System → Workers. Unset: `hostname:pid`. Set it to the pod or container name when scaling workers so each replica stays recognisable. Two live processes must not share an id (they would overwrite each other's heartbeat and disk leases): if a process with the same id beat in the last 30 s, the new one appends `-` and four hex characters and logs a warning, so a pinned id on `docker compose --scale worker=N` still works. |
| `MAX_UPLOAD_MB` | `4096` | Largest accepted file upload in MB. Runtime setting: admins can change it under Settings → System without a restart. |
| `MAX_SOURCE_FILE_MB` | `8192` | Largest file yt-dlp may download for a link source, in MB (`--max-filesize`). Runtime setting: admins can change it under Settings → System without a restart. |
| `ALLOW_PRIVATE_SOURCE_URLS` | `false` | `true` lets link sources point at LAN or loopback hosts (a NAS). Off, they are blocked (SSRF guard). Runtime setting: admins can change it under Settings → System without a restart. |
| `CATALOG_URL` | `https://reelsaw.com/catalog/v1/index.json` | Reelsaw catalog manifest (sounds, icons, stickers for the Library's Browse panel), fetched hourly with ETag; the starter pack bundled in the image is used until a newer version arrives. Runtime setting: admins can change it under Settings → System without a restart. |

### Accounts and sign-up

| Variable | Default | Description |
| --- | --- | --- |
| `SIGNUP_MODE` | unset | `open`: anyone may sign up. `approval`: new accounts wait for an admin (a private box). `closed`: no sign-ups. The first account is always the admin. Unset: `open`, unless the deprecated ALLOW_SIGNUP says otherwise. A public instance with email confirmation, captcha and quotas should stay `open`. Runtime setting: admins can change it under Settings → System without a restart. Values: `open | approval | closed`. |
| `ALLOW_SIGNUP` | unset | Deprecated alias: `false` means SIGNUP_MODE=closed. Use SIGNUP_MODE. |
| `EMAIL_DRIVER` | `none` | Outgoing mail for approval notices, password resets and verification: `none`, `smtp` or `resend`. `none` leaves those features off. Values: `none | smtp | resend`. |
| `EMAIL_FROM` | unset | Sender, e.g. `Reelsaw <no-reply@example.com>`. Required with an email driver. |
| `SMTP_URL` | unset | SMTP connection, e.g. `smtps://user:pass@smtp.example.com:465`. Required with EMAIL_DRIVER=smtp. |
| `RESEND_API_KEY` | unset | Required with EMAIL_DRIVER=resend. |
| `REQUIRE_EMAIL_VERIFICATION` | `false` | With an email driver: users must click the verification link before they can sign in. The link works for 24 hours and is single-use; an expired one offers a new send. Runtime setting: admins can change it under Settings → System without a restart. |
| `TRUST_PROXY` | `true` | Take the client address from the reverse proxy's headers (`CF-Connecting-IP`, `X-Real-IP`, `X-Forwarded-For`): the Docker deployment sits behind Caddy, so the default is on. `false` when the app is exposed directly, or the headers are whatever the client sent. |
| `MAX_SIGNUPS_PER_IP_PER_DAY` | `0` | Accounts one network address may create per day (sign-up guard). 0 = unlimited. Runtime setting: admins can change it under Settings → System without a restart. |
| `BLOCK_DISPOSABLE_EMAILS` | `false` | Refuse sign-ups from known temporary-address domains. Runtime setting: admins can change it under Settings → System without a restart. |
| `TERMS_URL` | unset | Terms of service link shown on the sign-up form when set. Runtime setting: admins can change it under Settings → System without a restart. |
| `PRIVACY_URL` | unset | Privacy policy link shown on the sign-up form when set. Runtime setting: admins can change it under Settings → System without a restart. |
| `CAPTCHA_PROVIDER` | unset | Bot protection on sign-up, sign-in and password reset: `cloudflare-turnstile`, `google-recaptcha` or `hcaptcha`. Needs both keys below. Runtime setting: admins can change it under Settings → System without a restart. Values: `cloudflare-turnstile | google-recaptcha | hcaptcha`. |
| `CAPTCHA_SITE_KEY` | unset | Public captcha key. Runtime setting: admins can change it under Settings → System without a restart. |
| `CAPTCHA_SECRET_KEY` | unset | Secret captcha key. Runtime setting: admins can change it under Settings → System without a restart. |
| `MCP_OAUTH` | `false` | MCP over OAuth 2.1 so claude.ai and Claude Desktop connectors sign in with the browser. API keys always work. |
| `HEALTH_DETAILS` | `false` | Include machine numbers in `GET /api/health` for anonymous callers (private networks only). Admins always get them. Runtime setting: admins can change it under Settings → System without a restart. |

### Models

| Variable | Default | Description |
| --- | --- | --- |
| `AI_MODEL` | `openai:gpt-4o-mini` | Default language model as `provider:model` (`openai:gpt-4o-mini`, `anthropic:claude-sonnet-4-5`, `google:gemini-2.5-flash`, `groq:llama-3.3-70b-versatile`, `gateway:anthropic/claude-sonnet-4-5`, `compat:<model>`). Admins can override it at runtime under Settings -> System -> Models. |
| `TRANSCRIPTION_MODEL` | `openai:whisper-1` | Default speech-to-text model as `provider:model`. It must return word timestamps: `openai:whisper-1`, `deepgram:nova-3`, `assemblyai:best`, `groq:whisper-large-v3-turbo`, `gateway:openai/whisper-1`, or a Speaches model through OPENAI_BASE_URL. `openai:gpt-4o-transcribe` returns none and does not work. |
| `TRANSCRIPT_ALIGN_MODEL` | unset | Model that re-aligns cut boundaries on short windows. Unset: TRANSCRIPTION_MODEL. A bigger whisper here is cheap and pays off. |

### Provider keys

| Variable | Default | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | unset | OpenAI key. With OPENAI_BASE_URL it is the key for that server (`local` for Speaches). |
| `OPENAI_BASE_URL` | unset | Point the OpenAI provider at a local OpenAI-compatible server (Speaches, LM Studio, vLLM), e.g. `http://speaches:8000/v1`. |
| `OPENAI_API_MODE` | unset | `responses` (OpenAI default) or `chat`. Defaults to `chat` whenever OPENAI_BASE_URL is set. Values: `responses | chat`. |
| `ANTHROPIC_API_KEY` | unset | Anthropic key (language model only; Anthropic has no speech-to-text). |
| `GOOGLE_GENERATIVE_AI_API_KEY` | unset | Google Gemini key. |
| `GROQ_API_KEY` | unset | Groq key (language and transcription models). |
| `DEEPGRAM_API_KEY` | unset | Deepgram key (transcription). |
| `ASSEMBLYAI_API_KEY` | unset | AssemblyAI key (transcription). |
| `AI_GATEWAY_API_KEY` | unset | Vercel AI Gateway: one key for every cloud vendor as `gateway:<vendor>/<model>`, list-price tokens, per-request cost in eval reports. |
| `VERCEL_OIDC_TOKEN` | unset | Alternative to AI_GATEWAY_API_KEY on Vercel-hosted deployments (injected by the platform). |
| `OPENAI_COMPATIBLE_BASE_URL` | unset | Generic OpenAI-compatible chat server, addressed as `compat:<model>` (Ollama: `http://host.docker.internal:11434/v1`). |
| `OPENAI_COMPATIBLE_API_KEY` | unset | Key for the compat server (`ollama` for Ollama). |
| `OPENAI_COMPATIBLE_NAME` | `compat` | Provider prefix used for the compat server, i.e. the `compat` in `compat:<model>`. |
| `OPENAI_COMPATIBLE_STRUCTURED_OUTPUTS` | `true` | Ask the compat server for `response_format: json_schema`. Set false for servers that choke on it; parsing falls back to lenient. |
| `PEXELS_API_KEY` | unset | Pexels key (free): stock photos and portrait videos in Library → Browse. Empty = hidden. Runtime setting: admins can change it under Settings → System without a restart. |
| `PIXABAY_API_KEY` | unset | Pixabay key (free): photos, illustrations, vectors and videos in Library → Browse. Results are cached 24 h; files are downloaded, never hotlinked. Empty = hidden. Runtime setting: admins can change it under Settings → System without a restart. |
| `FREESOUND_API_KEY` | unset | Freesound key (free): CC0 (or CC-BY) sound effects in Library → Browse. Empty = hidden. Runtime setting: admins can change it under Settings → System without a restart. |
| `GIPHY_API_KEY` | unset | Giphy key: GIFs and stickers in Library → Browse (shows "Powered by GIPHY"). Empty = hidden. Runtime setting: admins can change it under Settings → System without a restart. |
| `KLIPY_API_KEY` | unset | Klipy key: GIF search in Library → Browse (experimental). Empty = hidden. Runtime setting: admins can change it under Settings → System without a restart. |
| `ICONIFY_API_URL` | `https://api.iconify.design` | Iconify API for icon search (permissive sets only: lucide, tabler, mdi, ph, heroicons, ri, solar); point it at a self-hosted instance if you prefer. https only. Runtime setting: admins can change it under Settings → System without a restart. |
| `OPENVERSE_ENABLED` | `false` | Show Openverse (CC0 and CC-BY images and audio, no key) in Library → Browse. Runtime setting: admins can change it under Settings → System without a restart. |

### Pipeline tuning

| Variable | Default | Description |
| --- | --- | --- |
| `RENDER_CONCURRENCY` | `auto` | Parallel renders per worker. `auto` follows CPUs and free memory (see the resource governor); a number pins it. |
| `TRANSCRIBE_CHUNK_SECONDS` | `600` | Audio is split into chunks of this length for transcription APIs with upload limits. |
| `TRANSCRIBE_CONCURRENCY` | `0` | Parallel chunk transcriptions. 0 = auto: 1 for a self-hosted OPENAI_BASE_URL, 3 for cloud vendors. |
| `ANALYZE_CONCURRENCY` | `0` | Parallel LLM calls while finding and scoring moments. 0 = auto: 1 for a self-hosted model, 4 for cloud. |
| `PROVIDER_CONCURRENCY` | unset | Model calls in flight per provider across every app and worker process, e.g. `compat=2,openai=2` (`compat` = the compatible provider's name). Unset providers: 2 for a self-hosted server (the compatible provider, openai with OPENAI_BASE_URL), unlimited for cloud. |
| `ANALYZE_SCORE_SAMPLES` | `0` | Rubric samples per candidate (the median is kept). 0 = auto: 1 self-hosted, 3 cloud. |
| `ANALYZE_PAIRWISE` | `auto` | Pairwise re-ranking of the top clips with position swapping. `auto` = on for cloud models only. Values: `auto | on | off`. |
| `ANALYZE_PAIRWISE_PASSES` | `3` | Sliding pairwise passes over the top 10 candidates. 3 passes = 48 judge calls, 1 = 18. |
| `ANALYZE_SCORE_RULE` | `relative` | How auto mode drops weak picks. `relative`: below max(ANALYZE_MIN_SCORE_FLOOR, median - ANALYZE_SCORE_MAD_K x MAD) of the run's scores, so it holds across judges. `absolute`: the old fixed cutoff of 45. The best clip is always kept. Values: `relative | absolute`. |
| `ANALYZE_MIN_SCORE_FLOOR` | `25` | With the relative rule: never keep a clip whose rubric total is below this (25 means the judge called it unpostable). |
| `ANALYZE_SCORE_MAD_K` | `1` | With the relative rule: how many median absolute deviations below the median still count as a keeper. |
| `ANALYZE_JUDGE_MODEL` | unset | Model that scores and compares candidates, as `provider:model` (e.g. `anthropic:claude-sonnet-4-5`). Unset: the language model. |
| `TRANSCRIPT_BIAS` | `true` | Feed entities from the video metadata (channel, title, description, tags) and the project's "Names & terms" to the transcriber as vocabulary hints. Set false and those per-project hints are silently ignored. |
| `TRANSCRIPT_CORRECTION` | `true` | After transcription, let the language model fix misheard entity names (constrained to fuzzy matches). On by default. Instance ceiling: off skips it for every project; when on, a project may opt out via `refineEntities`. Runtime setting: admins can change it under Settings → System without a restart. |
| `DISFLUENCY_REMOVAL` | `false` | Detect fillers, repetitions and false starts and cut them from captions. Off by default. Instance ceiling: projects opt in via `refineDisfluency` when this is on. Runtime setting: admins can change it under Settings → System without a restart. |
| `DISFLUENCY_LLM` | `false` | Add a model pass to the rule-based disfluency pass. Off by default. Instance ceiling: projects opt in via `disfluencyLlm` when this is on. Runtime setting: admins can change it under Settings → System without a restart. |
| `REFINE_SCENES` | `true` | Scan the whole video for on-screen text (burned-in captions, watermarks, slides) during refine, so captions avoid it and slides are shown whole. On by default. Instance ceiling: off skips it for every project; when on, a project may opt out via `refineScenes`. Shot cuts do not depend on it: every project detects them before clip selection. Runtime setting: admins can change it under Settings → System without a restart. |
| `TRANSCRIPT_AUTO_FIX_CONFIDENCE` | `0.85` | Corrections at or above this model confidence are applied automatically; the rest wait for the user. |
| `FACE_DETECTION` | `true` | Face detection for automatic layout (follow crop, stacked webcam). false = fit only. |
| `LAYOUT_MIN_FACE_RATIO` | `0.6` | Share of sampled frames that must contain a face before a clip gets a face-following layout. |
| `LAYOUT_MIN_FACE_SIZE` | `0.18` | Median face height / frame height needed for a face-following layout. |

### On-device models (face, text, voice, alignment)

| Variable | Default | Description |
| --- | --- | --- |
| `ASR_CACHE_DAYS` | `14` | Speech-to-text results cache under DATA_DIR/cache/asr; entries older than this are pruned at boot and by the hourly sweep. |
| `FACE_MODEL_PATH` | `./models/ultraface-rfb-320.onnx` | UltraFace ONNX model. Ships in the image; `pnpm models:download` fetches it for runs outside Docker. |
| `TEXT_DETECTION` | `true` | Burned-in caption and watermark detection (PP-OCRv4, CPU). false = never hide source text. |
| `VAD` | `true` | Silero voice activity detection for tightening long pauses. false = never trim silence. |
| `ALIGNER` | `true` | wav2vec2 CTC forced alignment for exact word boundaries at filler cuts. false = whisper-only search. |
| `ONNX_EXECUTION_PROVIDER` | `cpu` | Where the face, text and alignment models run: `cpu`, `cuda` (Linux, needs the onnxruntime CUDA provider plus CUDA 12 and cuDNN 9 in the image, which the published image does not carry), `coreml` (macOS) or `dml` (Windows). A provider that cannot load falls back to cpu with a warning; Settings → System and `reelsaw machine` show where each model landed. Measured on Apple silicon, CoreML was slower than the CPU for all three models, so cpu stays the default. The VAD always runs on the CPU. Values: `cpu \| cuda \| coreml \| dml`. Values: `cpu | cuda | coreml | dml`. |
| `ALIGN_MODEL_DIR` | `./models/wav2vec2-base-960h` | wav2vec2 model directory. |
| `VAD_MODEL_PATH` | `./models/silero-vad.onnx` | Silero VAD ONNX model. |
| `TEXT_MODEL_PATH` | `./models/ppocrv4-det.onnx` | PP-OCRv4 text detector ONNX model. |

### Storage

| Variable | Default | Description |
| --- | --- | --- |
| `STORAGE_DRIVER` | `local` | `local` (inside DATA_DIR) or `s3`. Values: `local | s3`. |
| `STORAGE_LOCAL_DIR` | unset | Directory for the local driver. Unset: DATA_DIR/storage. |
| `S3_BUCKET` | unset | Bucket name. Required with STORAGE_DRIVER=s3. |
| `S3_REGION` | `us-east-1` | Bucket region. |
| `S3_ENDPOINT` | unset | Custom endpoint for MinIO, R2, B2 and similar. Empty for AWS. |
| `S3_ACCESS_KEY_ID` | unset | Access key id. |
| `S3_SECRET_ACCESS_KEY` | unset | Secret access key. |
| `S3_FORCE_PATH_STYLE` | `false` | Path-style addressing; required for MinIO. |
| `S3_PREFIX` | unset | Optional key prefix inside the bucket. |
| `S3_PUBLIC_URL` | unset | Serve clips from a public bucket or CDN at this base URL instead of presigned URLs. |
| `S3_PRESIGN_EXPIRES` | `3600` | Presigned URL lifetime in seconds (at most 604800, the 7-day SigV4 limit). |
| `CLEANUP_WORKDIR` | `true` | Delete audio, chunks and subtitle intermediates when a project finishes. |

### Quotas, retention and history

| Variable | Default | Description |
| --- | --- | --- |
| `MAX_REQUESTS_PER_MINUTE` | `0` | Changes (API mutations, MCP tool calls) an account may make per minute. 0 = unlimited. Runtime setting: admins can change it under Settings → System without a restart. |
| `MAX_REQUESTS_PER_HOUR` | `0` | Changes an account may make per hour. 0 = unlimited. Runtime setting: admins can change it under Settings → System without a restart. |
| `EVENT_REPLAY_LIMIT` | `300` | Events a project page replays when it connects (progress ticks never replay); older ones load on request. |
| `MAX_PROJECTS_PER_USER` | `0` | Quota: projects per account. 0 = unlimited. Admins can override per user on the Users page. Runtime setting: admins can change it under Settings → System without a restart. |
| `MAX_SOURCE_MINUTES_PER_DAY` | `0` | Quota: minutes of source video per account per day. 0 = unlimited. Runtime setting: admins can change it under Settings → System without a restart. |
| `MAX_NEW_PROJECTS_PER_HOUR` | `0` | Quota: new projects per account per hour. 0 = unlimited. Runtime setting: admins can change it under Settings → System without a restart. |
| `MAX_LIVE_JOBS_PER_USER` | `0` | Quota: jobs a user's own requests may have queued or running at once (hosted: e.g. 12). Pipeline hand-offs are never refused. 0 = unlimited. Runtime setting: admins can change it under Settings → System without a restart. |
| `MAX_RERENDERS_PER_HOUR` | `0` | Quota: re-renders and hand-made clips per account per hour. 0 = unlimited. Runtime setting: admins can change it under Settings → System without a restart. |
| `MAX_STORAGE_MB` | `0` | Quota: sources + uploads + rendered clips + intros/outros kept per account, in MB; checked at upload and project creation. Deleted items count until they are deleted forever. 0 = unlimited. Runtime setting: admins can change it under Settings → System without a restart. |
| `MAX_SOURCE_MINUTES_PER_MONTH` | `0` | Quota: minutes of source video per account per period: the billing period when the account has a plan (ee), else the UTC calendar month. 0 = unlimited. Runtime setting: admins can change it under Settings → System without a restart. |
| `WATERMARK_NON_ADMINS` | `true` | Burn a small text watermark into the clips of accounts that are not admins. A paid plan removes it; admins can switch it per user on the Users page (Limits). Runtime setting: admins can change it under Settings → System without a restart. |
| `WATERMARK_TEXT` | `reelsaw.com` | The watermark text, shown under the logo. Runtime setting: admins can change it under Settings → System without a restart. |
| `WATERMARK_LOGO_PATH` | `./assets/watermark.png` | PNG composited above the watermark text (top-left under the platform top band, 18% of the frame width, 95% opacity). An unreadable file logs a warning and leaves the text watermark alone. |
| `SOURCE_RETENTION_DAYS` | `0` | Delete stored sources older than this. Rows stay; Retry on the project fetches the source again, after which clips can be re-rendered (until then a render fails with a message saying so). 0 = keep. Runtime setting: admins can change it under Settings → System without a restart. |
| `CLIP_RETENTION_DAYS` | `0` | Delete rendered clips and thumbnails older than this, from the store and local disk. Rows stay; re-rendering a clip brings it back. 0 = keep. Runtime setting: admins can change it under Settings → System without a restart. |
| `DELETED_RETENTION_DAYS` | `7` | Deleted projects and clips replaced by a re-analyze stay restorable this long (Deleted page), then their rows and files are purged. Storage still counts until then (or until the owner deletes them forever). 0 = keep forever. Runtime setting: admins can change it under Settings → System without a restart. |
| `SCRATCH_CACHE_HOURS` | `24` | With `STORAGE_DRIVER=s3`, the copies of sources and rendered clips under `DATA_DIR/projects` are a cache of the bucket: the hourly sweep evicts the ones of finished projects idle this long (a job pulls them back when it needs them), and a job short of disk evicts the least recently used ones first before it gives up. 0 = keep them on the worker. Nothing to evict with the local store (scratch and store are one hardlinked file). Runtime setting: admins can change it under Settings → System without a restart. |
| `EVENT_RETENTION_DAYS` | `90` | Prune project events after N days (each project keeps its created / run.started / done rows). 0 = keep. Runtime setting: admins can change it under Settings → System without a restart. |
| `LLM_USAGE_RETENTION_DAYS` | `180` | Prune model-call usage rows after N days. 0 = keep. Runtime setting: admins can change it under Settings → System without a restart. |
| `ADMIN_EVENT_RETENTION_DAYS` | `365` | Prune the admin event log after N days. 0 = keep. Runtime setting: admins can change it under Settings → System without a restart. |

### Enterprise edition and billing (hosted)

| Variable | Default | Description |
| --- | --- | --- |
| `REELSAW_EE` | `false` | Load the enterprise edition (`apps/server/src/ee`, its own licence): billing through Stripe, plans that set each account's limits. Off, nothing in that folder runs. See docs/specs/ee.md. |
| `STRIPE_SECRET_KEY` | unset | Stripe secret key (`sk_live_…` / `sk_test_…`). Required with REELSAW_EE. |
| `STRIPE_WEBHOOK_SECRET` | unset | Signing secret of the webhook endpoint `POST /api/billing/webhook` (`whsec_…`). Required with REELSAW_EE. |
| `STRIPE_MANAGED_PAYMENTS` | `false` | Enable Stripe Managed Payments (Stripe as merchant of record: it files sales tax and VAT) on every Checkout Session. The Stripe account must be approved for it first. |
| `STRIPE_API_BASE` | unset | Development only: an origin that stands in for api.stripe.com (stripe-mock, or `test/stripe-mock.ts`). Never set in production. |
| `BILLING_GRACE_DAYS` | `7` | Days a past-due subscription keeps its plan after the first failed payment; then the account falls back to Free. |

### Resource governor and workers

| Variable | Default | Description |
| --- | --- | --- |
| `STALL_MINUTES` | `15` | A running job with no progress event for this long is reported (log and UI) as stalled. Runtime setting: admins can change it under Settings → System without a restart. |
| `SHUTDOWN_GRACE_SECONDS` | `300` | On SIGTERM wait this long for running jobs to finish before exiting, so deploys stop interrupting renders. |
| `MAX_CPU_PERCENT` | `90` | Heavy steps wait while total CPU time is busier than this (measured, any OS). |
| `MIN_FREE_MEM_MB` | `512` | Heavy steps wait while free memory is below this. |
| `MIN_FREE_DISK_MB` | `2048` | Floor that must stay free. A job that also needs scratch checks the floor plus that scratch against free space net of what jobs in flight have already leased on the volume, and leases its own in the same step, so two jobs cannot both pass on the same bytes; short of disk it first evicts scratch copies the S3 store still has (`SCRATCH_CACHE_HOURS`), then waits for other jobs' leases to come back, or, short of real bytes, moves to another worker that has the room or fails the run when none does. A worker below the floor with nothing left to evict stops taking media jobs while another worker has the room, until it is 1 GB above the floor again (Settings → System → Workers shows "disk full"); a single box fails the job instead. |
| `RESOURCE_WAIT_MAX_SECONDS` | `900` | Longest a step waits for CPU, memory, or disk other jobs have leased but not written yet. A shortfall of real bytes does not wait: eviction, hand-off or failure. |

### Logging, tracing and telemetry

| Variable | Default | Description |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | A level (`trace`..`silent`) optionally followed by per-module overrides, e.g. `info,render=debug,http=warn`. Change it without a restart with `reelsaw log-level`. |
| `LOG_FORMAT` | `auto` | `auto` (pretty on a terminal, JSON otherwise), `json` or `pretty`. Values: `auto | json | pretty`. |
| `OTEL_ENABLED` | `false` | OpenTelemetry traces, logs and metrics over OTLP/HTTP. Independent of SENTRY_DSN — set OTEL_EXPORTER_OTLP_ENDPOINT (and HEADERS) explicitly. Logs are the pino lines that pass their level, sent to `/v1/logs` (Sentry accepts these). Prompt, transcript and address fields stay in the local log only. Sentry does not accept OTLP metrics; those go through SENTRY_DSN when metrics are left on. See the OTEL_* variables at the end. |
| `SENTRY_DSN` | unset | Sentry DSN. Set, the server reports boot failures, 5xx API errors and a job's final failed attempt, and the web app reports render errors (the DSN is public and handed to the browser). Does not configure the OTLP exporter. When OTEL is on, the endpoint is Sentry, and metrics are left on, Node runtime gauges and the application metrics (README, Metrics) are sent through this DSN, because Sentry does not ingest OTLP metrics. Unset, nothing is sent. |
| `SENTRY_ENVIRONMENT` | unset | Sentry environment tag. Default: `production` under NODE_ENV=production, else `development`. |
| `POSTHOG_KEY` | unset | PostHog project key (public). Set, the server sends sign-ups, project created/done/failed, billing and abuse-flag events, and the web app sends page views and a few product events; people are identified by user id with email and name on the profile. Unset, nothing is sent. |
| `POSTHOG_HOST` | `https://us.i.posthog.com` | PostHog ingestion host (`https://eu.i.posthog.com` for the EU cloud, or a self-hosted instance). |
| `LLM_TRACE` | `none` | Capture model calls: `none`, `logs` (one structured line per call: prompt, response, tokens, latency) or `langfuse`; comma-separate for several. |
| `LLM_TRACE_MAX_CHARS` | `4000` | Truncate captured prompts and responses to this many characters. |
| `LANGFUSE_PUBLIC_KEY` | unset | Langfuse public key (checked at boot when LLM_TRACE includes langfuse). |
| `LANGFUSE_SECRET_KEY` | unset | Langfuse secret key. |
| `LANGFUSE_BASE_URL` | `https://cloud.langfuse.com` | Langfuse host. |
| `LOG_FILE` | unset | Also write JSON lines here (daily files, 7 kept). Survives container re-creation; `reelsaw logs` and issue reports read it. |

### Media tools and downloads

| Variable | Default | Description |
| --- | --- | --- |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg binary. |
| `FFMPEG_ENCODER` | `auto` | H.264 encoder for clips, intros/outros and previews. `auto` probes `h264_nvenc` (NVIDIA, container started with docker-compose.gpu.yml) then `h264_videotoolbox` (macOS, outside Docker) at boot and keeps `libx264` otherwise; naming one makes boot fail if it cannot encode. A hardware encoder that fails mid-render is retried on libx264. Settings → System and `reelsaw machine` show the one in use and why. Values: `auto \| libx264 \| h264_nvenc \| h264_videotoolbox`. Values: `auto | libx264 | h264_nvenc | h264_videotoolbox`. |
| `FFPROBE_PATH` | `ffprobe` | ffprobe binary. |
| `YTDLP_PATH` | `yt-dlp` | yt-dlp binary. |
| `YTDLP_PROXY` | unset | yt-dlp egress: one URL (`http`, `https`, `socks5`, `socks5h`), or a comma-separated pool `[id=]<url-or-direct>[;priority=N][;concurrency=N]`. `priority` is the operator ranking (higher is tried first) and never changes at runtime; a circuit breaker skips a candidate after consecutive faults, then the ranking applies again. `direct` uses this server's IP. `{session}` in a URL is replaced with a fresh id on every download so a residential gateway can pin that process to one IP and give the next download a different one (DataImpulse: `sessid.{session}` in the username; turn plan-wide sticky off). YouTube blocks many datacentre IPs. `reelsaw ytdlp-proxies` shows the pool (never URLs). Example: `pi=socks5h://100.64.1.10:1080;priority=20;concurrency=1,paid=http://user:pass@gate.example:7000;priority=1`. |
| `YTDLP_COOKIES_FILE` | unset | Cookies file in Netscape format for yt-dlp. |
| `CAPTION_FONT` | `DejaVu Sans` | Font family for burned-in captions; it must be installed where ffmpeg runs. |

### Docker Compose and OpenTelemetry (read outside config.ts)

| Variable | Default | Description |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | `reelsaw` | Database password used by both the db and app containers (compose only). |
| `REELSAW_IMAGE` | `ghcr.io/osbytes/reelsaw:latest` | Image the compose file runs (compose only). |
| `WHISPER_MODEL` | `Systran/faster-whisper-small` | Speech model the Speaches container downloads. `Systran/faster-whisper-small` runs about real-time on a CPU; with a GPU use `Systran/faster-whisper-medium` (under 16 GB VRAM) or `Systran/faster-whisper-large-v3` (the installer picks). Compose only. |
| `SPEACHES_IMAGE` | `ghcr.io/speaches-ai/speaches:latest-cpu` | Speaches image: `ghcr.io/speaches-ai/speaches:latest-cuda` with an NVIDIA GPU handed to the container by docker-compose.gpu.yml (`COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml` on Linux/macOS, `;` instead of `:` on Windows; the installer picks it). Compose only. |
| `RUN_WORKERS_IN_APP` | `true` | Compose maps this to RUN_WORKERS of the app container. false when only dedicated `worker` containers should process jobs. |
| `OTEL_SERVICE_NAME` | `reelsaw` | OpenTelemetry service name (read by otel.ts). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP/HTTP collector base URL (the SDK appends `/v1/traces`). For Sentry, paste the OTLP base from Project Settings → Client Keys → OpenTelemetry (`…/integration/otlp`), not `…/v1/traces`. |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | Extra OTLP headers as `key=url-encoded-value` pairs. For Sentry: `x-sentry-auth=sentry%20sentry_key%3D<public-key>` (the public key from the DSN). Private collector example: `authorization=Bearer%20xxx`. |
| `OTEL_METRICS_ENABLED` | `true` | Export metrics as well as traces. A collector receives OTLP `/v1/metrics`. Sentry does not: with a Sentry OTLP endpoint and `SENTRY_DSN` set, the server sends Node runtime gauges and the application metrics (README, Metrics: pipeline stages per second of video, yt-dlp proxies, model calls) as Sentry Application Metrics instead. Set to false for traces only. |
| `OTEL_TRACES_SAMPLE_RATE` | `1` | Fraction of traces to record, from 0 to 1. Default 1 (record all). The browser uses the same rate and starts before the first API call, so a page load and the server work it starts share a trace. A trace the browser does not record is not recorded on the server either. Leave `OTEL_TRACES_SAMPLER` unset; that standard variable overrides this on the server only. |
| `OTEL_METRIC_EXPORT_INTERVAL` | `30000` | Metric export interval in milliseconds. |
| `OTEL_LOG_LEVEL` | unset | Diagnostic log level of the OpenTelemetry SDK itself. |
<!-- /generated -->
