/**
 * Hand-written documentation for every environment variable, consumed by gen-docs.ts.
 * The zod schema in src/config.ts owns names, types and defaults; this file owns the prose, the
 * grouping and which variables the two .env.example files switch on. A schema variable with no
 * entry here (and no `.describe()`) fails `pnpm docs:check`, so new variables cannot ship undocumented.
 */

export const GROUPS = [
  ["core", "Core"],
  ["accounts", "Accounts and sign-up"],
  ["models", "Models"],
  ["providers", "Provider keys"],
  ["pipeline", "Pipeline tuning"],
  ["local", "On-device models (face, text, voice, alignment)"],
  ["storage", "Storage"],
  ["limits", "Quotas, retention and history"],
  ["resources", "Resource governor and workers"],
  ["observability", "Logging, tracing and telemetry"],
  ["tools", "Media tools and downloads"],
  ["compose", "Docker Compose and OpenTelemetry (read outside config.ts)"],
] as const;
export type GroupId = (typeof GROUPS)[number][0];

/** variable -> [group, description]. A `.describe()` on the schema entry wins over the text here. */
export const DOCS: Record<string, [GroupId, string]> = {
  NODE_ENV: ["core", "`production` enforces a 32+ character BETTER_AUTH_SECRET. The image sets it."],
  PORT: ["core", "Port the HTTP server listens on."],
  APP_URL: ["core", "Public URL people open in the browser; used for auth cookies, CORS, the OAuth issuer and links in emails."],
  DATABASE_URL: ["core", "Postgres connection string. Compose sets it; set it yourself when running from source."],
  BETTER_AUTH_SECRET: ["core", "32+ random characters (`openssl rand -base64 32`). Signs sessions and encrypts the provider keys admins enter in Settings; rotating it makes those keys unreadable."],
  DATA_DIR: ["core", "Working directory for uploads, per-project scratch files, the local storage driver and caches."],
  WEB_DIST: ["core", "Directory of the built web app to serve. Unset: the bundled location."],
  RUN_HTTP: ["core", "Serve HTTP in this process. false for a worker-only container."],
  RUN_WORKERS: ["core", "Process pipeline jobs in this process. false for a web-only container. At least one of RUN_HTTP / RUN_WORKERS must be on."],
  REELSAW_VERSION: ["core", "Release version baked into the image at build time (`dev` from source)."],
  REELSAW_COMMIT: ["core", "Git commit baked into the image at build time."],
  REELSAW_BUILT_AT: ["core", "Build timestamp baked into the image."],
  MAX_UPLOAD_MB: ["core", "Largest accepted file upload in MB."],
  MAX_SOURCE_FILE_MB: ["core", "Largest file yt-dlp may download for a link source, in MB (`--max-filesize`)."],
  ALLOW_PRIVATE_SOURCE_URLS: ["core", "`true` lets link sources point at LAN or loopback hosts (a NAS). Off, they are blocked (SSRF guard)."],

  SIGNUP_MODE: ["accounts", "`open`: anyone may sign up. `approval`: new accounts wait for an admin. `closed`: no sign-ups. The first account is always the admin. Unset: `open`, unless the deprecated ALLOW_SIGNUP says otherwise."],
  ALLOW_SIGNUP: ["accounts", "Deprecated alias: `false` means SIGNUP_MODE=closed. Use SIGNUP_MODE."],
  EMAIL_DRIVER: ["accounts", "Outgoing mail for approval notices, password resets and verification: `none`, `smtp` or `resend`. `none` leaves those features off."],
  EMAIL_FROM: ["accounts", "Sender, e.g. `Reelsaw <no-reply@example.com>`. Required with an email driver."],
  SMTP_URL: ["accounts", "SMTP connection, e.g. `smtps://user:pass@smtp.example.com:465`. Required with EMAIL_DRIVER=smtp."],
  RESEND_API_KEY: ["accounts", "Required with EMAIL_DRIVER=resend."],
  REQUIRE_EMAIL_VERIFICATION: ["accounts", "With an email driver: users must click the verification link before they can sign in."],
  TERMS_URL: ["accounts", "Terms of service link shown on the sign-up form when set."],
  PRIVACY_URL: ["accounts", "Privacy policy link shown on the sign-up form when set."],
  CAPTCHA_PROVIDER: ["accounts", "Bot protection on sign-up and sign-in: `cloudflare-turnstile`, `google-recaptcha` or `hcaptcha`. Needs both keys below."],
  CAPTCHA_SITE_KEY: ["accounts", "Public captcha key."],
  CAPTCHA_SECRET_KEY: ["accounts", "Secret captcha key."],
  MCP_OAUTH: ["accounts", "MCP over OAuth 2.1 so claude.ai and Claude Desktop connectors sign in with the browser. API keys always work."],
  UPDATE_CHECK: ["core", "Ask GitHub for the latest release and tell admins in Settings → System, `reelsaw version` and the `check_for_update` tool when a newer one exists. Only the request leaves the machine (no ids, no usage). `false` never contacts GitHub."],
  UPDATE_CHECK_URL: ["core", "Releases endpoint the check asks (GitHub's `releases/latest` of this repository); change it for a fork or a mirror."],
  UPDATE_CHECK_HOURS: ["core", "Hours between update checks (1–168). \"Check now\" in Settings asks at most once a minute."],
  HEALTH_DETAILS: ["accounts", "Include machine numbers in `GET /api/health` for anonymous callers (private networks only). Admins always get them."],

  AI_MODEL: ["models", "Default language model as `provider:model` (`openai:gpt-4o-mini`, `anthropic:claude-sonnet-4-5`, `google:gemini-2.5-flash`, `groq:llama-3.3-70b-versatile`, `gateway:anthropic/claude-sonnet-4-5`, `compat:<model>`). Admins can override it at runtime under Settings -> System -> Models."],
  TRANSCRIPTION_MODEL: ["models", "Default speech-to-text model as `provider:model`. It must return word timestamps: `openai:whisper-1`, `deepgram:nova-3`, `assemblyai:best`, `groq:whisper-large-v3-turbo`, `gateway:openai/whisper-1`, or a Speaches model through OPENAI_BASE_URL. `openai:gpt-4o-transcribe` returns none and does not work."],
  TRANSCRIPT_ALIGN_MODEL: ["models", "Model that re-aligns cut boundaries on short windows. Unset: TRANSCRIPTION_MODEL. A bigger whisper here is cheap and pays off."],

  OPENAI_API_KEY: ["providers", "OpenAI key. With OPENAI_BASE_URL it is the key for that server (`local` for Speaches)."],
  OPENAI_BASE_URL: ["providers", "Point the OpenAI provider at a local OpenAI-compatible server (Speaches, LM Studio, vLLM), e.g. `http://speaches:8000/v1`."],
  OPENAI_API_MODE: ["providers", "`responses` (OpenAI default) or `chat`. Defaults to `chat` whenever OPENAI_BASE_URL is set."],
  ANTHROPIC_API_KEY: ["providers", "Anthropic key (language model only; Anthropic has no speech-to-text)."],
  GOOGLE_GENERATIVE_AI_API_KEY: ["providers", "Google Gemini key."],
  GROQ_API_KEY: ["providers", "Groq key (language and transcription models)."],
  DEEPGRAM_API_KEY: ["providers", "Deepgram key (transcription)."],
  ASSEMBLYAI_API_KEY: ["providers", "AssemblyAI key (transcription)."],
  AI_GATEWAY_API_KEY: ["providers", "Vercel AI Gateway: one key for every cloud vendor as `gateway:<vendor>/<model>`, list-price tokens, per-request cost in eval reports."],
  VERCEL_OIDC_TOKEN: ["providers", "Alternative to AI_GATEWAY_API_KEY on Vercel-hosted deployments (injected by the platform)."],
  OPENAI_COMPATIBLE_BASE_URL: ["providers", "Generic OpenAI-compatible chat server, addressed as `compat:<model>` (Ollama: `http://host.docker.internal:11434/v1`)."],
  OPENAI_COMPATIBLE_API_KEY: ["providers", "Key for the compat server (`ollama` for Ollama)."],
  OPENAI_COMPATIBLE_NAME: ["providers", "Provider prefix used for the compat server, i.e. the `compat` in `compat:<model>`."],
  OPENAI_COMPATIBLE_STRUCTURED_OUTPUTS: ["providers", "Ask the compat server for `response_format: json_schema`. Set false for servers that choke on it; parsing falls back to lenient."],

  TRANSCRIBE_CHUNK_SECONDS: ["pipeline", "Audio is split into chunks of this length for transcription APIs with upload limits."],
  TRANSCRIBE_CONCURRENCY: ["pipeline", "Parallel chunk transcriptions. 0 = auto: 1 for a self-hosted OPENAI_BASE_URL, 3 for cloud vendors."],
  PROVIDER_CONCURRENCY: ["pipeline", "Model calls in flight per provider across every app and worker process, e.g. `compat=2,openai=2` (`compat` = the compatible provider's name). Unset providers: 2 for a self-hosted server (the compatible provider, openai with OPENAI_BASE_URL), unlimited for cloud."],
  ANALYZE_CONCURRENCY: ["pipeline", "Parallel LLM calls while finding and scoring moments. 0 = auto: 1 for a self-hosted model, 4 for cloud."],
  ANALYZE_SCORE_SAMPLES: ["pipeline", "Rubric samples per candidate (the median is kept). 0 = auto: 1 self-hosted, 3 cloud."],
  ANALYZE_PAIRWISE: ["pipeline", "Pairwise re-ranking of the top clips with position swapping. `auto` = on for cloud models only."],
  ANALYZE_PAIRWISE_PASSES: ["pipeline", "Sliding pairwise passes over the top 10 candidates. 3 passes = 48 judge calls, 1 = 18."],
  ANALYZE_SCORE_RULE: ["pipeline", "How auto mode drops weak picks. `relative`: below max(ANALYZE_MIN_SCORE_FLOOR, median - ANALYZE_SCORE_MAD_K x MAD) of the run's scores, so it holds across judges. `absolute`: the old fixed cutoff of 45. The best clip is always kept."],
  ANALYZE_MIN_SCORE_FLOOR: ["pipeline", "With the relative rule: never keep a clip whose rubric total is below this (25 means the judge called it unpostable)."],
  ANALYZE_SCORE_MAD_K: ["pipeline", "With the relative rule: how many median absolute deviations below the median still count as a keeper."],
  ANALYZE_JUDGE_MODEL: ["pipeline", "Model that scores and compares candidates, as `provider:model` (e.g. `anthropic:claude-sonnet-4-5`). Unset: the language model."],
  TRANSCRIPT_BIAS: ["pipeline", "Feed entities from the video metadata (channel, title, description, tags) and the project's \"Names & terms\" to the transcriber as vocabulary hints. Set false and those per-project hints are silently ignored."],
  TRANSCRIPT_CORRECTION: ["pipeline", "After transcription, let the language model fix misheard entity names (constrained to fuzzy matches)."],
  TRANSCRIPT_AUTO_FIX_CONFIDENCE: ["pipeline", "Corrections at or above this model confidence are applied automatically; the rest wait for the user."],
  DISFLUENCY_REMOVAL: ["pipeline", "Detect fillers, repetitions and false starts and cut them from captions. Set false and the per-project disfluency settings are silently ignored."],
  DISFLUENCY_LLM: ["pipeline", "Add a model pass to the rule-based disfluency pass. false skips the slowest refine step on small local models."],
  RENDER_CONCURRENCY: ["pipeline", "Parallel renders per worker. `auto` follows CPUs and free memory (see the resource governor); a number pins it."],
  FACE_DETECTION: ["pipeline", "Face detection for automatic layout (follow crop, stacked webcam). false = fit only."],
  LAYOUT_MIN_FACE_RATIO: ["pipeline", "Share of sampled frames that must contain a face before a clip gets a face-following layout."],
  LAYOUT_MIN_FACE_SIZE: ["pipeline", "Median face height / frame height needed for a face-following layout."],

  FACE_MODEL_PATH: ["local", "UltraFace ONNX model. Ships in the image; `pnpm models:download` fetches it for runs outside Docker."],
  TEXT_DETECTION: ["local", "Burned-in caption and watermark detection (PP-OCRv4, CPU). false = never hide source text."],
  TEXT_MODEL_PATH: ["local", "PP-OCRv4 text detector ONNX model."],
  VAD: ["local", "Silero voice activity detection for tightening long pauses. false = never trim silence."],
  VAD_MODEL_PATH: ["local", "Silero VAD ONNX model."],
  ALIGNER: ["local", "wav2vec2 CTC forced alignment for exact word boundaries at filler cuts. false = whisper-only search."],
  ALIGN_MODEL_DIR: ["local", "wav2vec2 model directory."],
  ONNX_EXECUTION_PROVIDER: ["local", "Where the face, text and alignment models run: `cpu`, `cuda` (Linux, needs the onnxruntime CUDA provider plus CUDA 12 and cuDNN 9 in the image, which the published image does not carry), `coreml` (macOS) or `dml` (Windows). A provider that cannot load falls back to cpu with a warning; Settings → System and `reelsaw machine` show where each model landed. Measured on Apple silicon, CoreML was slower than the CPU for all three models, so cpu stays the default. The VAD always runs on the CPU. Values: `cpu | cuda | coreml | dml`."],
  ASR_CACHE_DAYS: ["local", "Speech-to-text results cache under DATA_DIR/cache/asr; entries older than this are pruned at boot."],

  STORAGE_DRIVER: ["storage", "`local` (inside DATA_DIR) or `s3`."],
  STORAGE_LOCAL_DIR: ["storage", "Directory for the local driver. Unset: DATA_DIR/storage."],
  S3_BUCKET: ["storage", "Bucket name. Required with STORAGE_DRIVER=s3."],
  S3_REGION: ["storage", "Bucket region."],
  S3_ENDPOINT: ["storage", "Custom endpoint for MinIO, R2, B2 and similar. Empty for AWS."],
  S3_ACCESS_KEY_ID: ["storage", "Access key id."],
  S3_SECRET_ACCESS_KEY: ["storage", "Secret access key."],
  S3_FORCE_PATH_STYLE: ["storage", "Path-style addressing; required for MinIO."],
  S3_PREFIX: ["storage", "Optional key prefix inside the bucket."],
  S3_PUBLIC_URL: ["storage", "Serve clips from a public bucket or CDN at this base URL instead of presigned URLs."],
  S3_PRESIGN_EXPIRES: ["storage", "Presigned URL lifetime in seconds."],
  CLEANUP_WORKDIR: ["storage", "Delete audio, chunks and subtitle intermediates when a project finishes."],

  MAX_PROJECTS_PER_USER: ["limits", "Quota: projects per account. 0 = unlimited. Admins can override per user on the Users page."],
  MAX_SOURCE_MINUTES_PER_DAY: ["limits", "Quota: minutes of source video per account per day. 0 = unlimited."],
  MAX_NEW_PROJECTS_PER_HOUR: ["limits", "Quota: new projects per account per hour. 0 = unlimited."],
  MAX_LIVE_JOBS_PER_USER: ["limits", "Quota: jobs a user's own requests may have queued or running at once (hosted: e.g. 12). Pipeline hand-offs are never refused. 0 = unlimited."],
  MAX_RERENDERS_PER_HOUR: ["limits", "Quota: re-renders and hand-made clips per account per hour. 0 = unlimited."],
  MAX_STORAGE_MB: ["limits", "Quota: sources + uploads + rendered clips + intros/outros kept per account, in MB; checked at upload and project creation. 0 = unlimited."],
  SOURCE_RETENTION_DAYS: ["limits", "Delete stored sources older than this. Rows stay and Retry re-fetches. 0 = keep."],
  CLIP_RETENTION_DAYS: ["limits", "Delete rendered clips older than this. Rows stay and re-render brings them back. 0 = keep."],
  EVENT_RETENTION_DAYS: ["limits", "Prune project events after N days (each project keeps its created / run.started / done rows). 0 = keep."],
  LLM_USAGE_RETENTION_DAYS: ["limits", "Prune model-call usage rows after N days. 0 = keep."],
  ADMIN_EVENT_RETENTION_DAYS: ["limits", "Prune the admin event log after N days. 0 = keep."],
  DELETED_RETENTION_DAYS: ["limits", "Deleted projects and clips replaced by a re-analyze stay restorable this long, then their rows and files are purged. 0 = keep forever."],
  EVENT_REPLAY_LIMIT: ["limits", "Events a project page replays when it connects (progress ticks never replay); older ones load on request."],

  MAX_CPU_PERCENT: ["resources", "Heavy steps wait while total CPU time is busier than this (measured, any OS)."],
  MIN_FREE_MEM_MB: ["resources", "Heavy steps wait while free memory is below this."],
  MIN_FREE_DISK_MB: ["resources", "Below this, jobs fail fast with a \"low disk\" error instead of corrupting output."],
  RESOURCE_WAIT_MAX_SECONDS: ["resources", "Longest a step waits for the governor."],
  STALL_MINUTES: ["resources", "A running job with no progress event for this long is reported (log and UI) as stalled."],
  SHUTDOWN_GRACE_SECONDS: ["resources", "On SIGTERM wait this long for running jobs to finish before exiting, so deploys stop interrupting renders."],

  LOG_LEVEL: ["observability", "A level (`trace`..`silent`) optionally followed by per-module overrides, e.g. `info,render=debug,http=warn`. Change it without a restart with `reelsaw log-level`."],
  LOG_FORMAT: ["observability", "`auto` (pretty on a terminal, JSON otherwise), `json` or `pretty`."],
  LOG_FILE: ["observability", "Also write JSON lines here (daily files, 7 kept). Survives container re-creation; `reelsaw logs` and issue reports read it."],
  LLM_TRACE: ["observability", "Capture model calls: `none`, `logs` (one structured line per call: prompt, response, tokens, latency) or `langfuse`; comma-separate for several."],
  LLM_TRACE_MAX_CHARS: ["observability", "Truncate captured prompts and responses to this many characters."],
  LANGFUSE_PUBLIC_KEY: ["observability", "Langfuse public key (checked at boot when LLM_TRACE includes langfuse)."],
  LANGFUSE_SECRET_KEY: ["observability", "Langfuse secret key."],
  LANGFUSE_BASE_URL: ["observability", "Langfuse host."],
  OTEL_ENABLED: ["observability", "OpenTelemetry traces and metrics over OTLP/HTTP (see the OTEL_* variables at the end)."],

  FFMPEG_PATH: ["tools", "ffmpeg binary."],
  FFMPEG_ENCODER: ["tools", "H.264 encoder for clips, intros/outros and previews. `auto` probes `h264_nvenc` (NVIDIA, container started with docker-compose.gpu.yml) then `h264_videotoolbox` (macOS, outside Docker) at boot and keeps `libx264` otherwise; naming one makes boot fail if it cannot encode. A hardware encoder that fails mid-render is retried on libx264. Settings → System and `reelsaw machine` show the one in use and why. Values: `auto | libx264 | h264_nvenc | h264_videotoolbox`."],
  FFPROBE_PATH: ["tools", "ffprobe binary."],
  YTDLP_PATH: ["tools", "yt-dlp binary."],
  YTDLP_PROXY: ["tools", "Route yt-dlp through a proxy. YouTube blocks many datacentre IPs."],
  YTDLP_COOKIES_FILE: ["tools", "Cookies file in Netscape format for yt-dlp."],
  CAPTION_FONT: ["tools", "Font family for burned-in captions; it must be installed where ffmpeg runs."],

  POSTGRES_PASSWORD: ["compose", "Database password used by both the db and app containers (compose only)."],
  REELSAW_IMAGE: ["compose", "Image the compose file runs (compose only)."],
  WHISPER_MODEL: ["compose", "Speech model the Speaches container downloads. `Systran/faster-whisper-small` runs about real-time on a CPU; with a GPU use `Systran/faster-whisper-large-v3` (or `deepdml/faster-whisper-large-v3-turbo-ct2`). Compose only."],
  SPEACHES_IMAGE: ["compose", "Speaches image: `ghcr.io/speaches-ai/speaches:latest-cuda` with an NVIDIA GPU handed to the container by docker-compose.gpu.yml (`COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml`; the installer picks it). Compose only."],
  RUN_WORKERS_IN_APP: ["compose", "Compose maps this to RUN_WORKERS of the app container. false when only dedicated `worker` containers should process jobs."],
  OTEL_SERVICE_NAME: ["compose", "OpenTelemetry service name (read by otel.ts)."],
  OTEL_EXPORTER_OTLP_ENDPOINT: ["compose", "OTLP/HTTP collector, e.g. `http://otel-collector:4318`."],
  OTEL_EXPORTER_OTLP_HEADERS: ["compose", "Extra OTLP headers, e.g. `authorization=Bearer%20xxx`."],
  OTEL_METRICS_ENABLED: ["compose", "Export metrics as well as traces."],
  OTEL_METRIC_EXPORT_INTERVAL: ["compose", "Metric export interval in milliseconds."],
  OTEL_LOG_LEVEL: ["compose", "Diagnostic log level of the OpenTelemetry SDK itself."],
};

/** variables read outside the zod schema (compose, otel.ts): name -> default shown in docs */
export const EXTRA_DEFAULTS: Record<string, string> = {
  POSTGRES_PASSWORD: "reelsaw",
  REELSAW_IMAGE: "ghcr.io/osbytes/reelsaw:latest",
  WHISPER_MODEL: "Systran/faster-whisper-small",
  SPEACHES_IMAGE: "ghcr.io/speaches-ai/speaches:latest-cpu",
  RUN_WORKERS_IN_APP: "true",
  OTEL_SERVICE_NAME: "reelsaw",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
  OTEL_EXPORTER_OTLP_HEADERS: "",
  OTEL_METRICS_ENABLED: "true",
  OTEL_METRIC_EXPORT_INTERVAL: "30000",
  OTEL_LOG_LEVEL: "",
};

/**
 * Which variables each .env.example switches on (uncommented) and with what value. Everything
 * else is written as a commented line with its schema default. Root = a developer running from
 * source; deploy = a hosted install from the release zip (hosting knobs are visible).
 */
const PROVIDER_KEYS = Object.fromEntries(
  ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GROQ_API_KEY", "DEEPGRAM_API_KEY", "ASSEMBLYAI_API_KEY", "AI_GATEWAY_API_KEY"].map((k) => [k, ""]),
);
export const ENV_ACTIVE: Record<"root" | "deploy", Record<string, string>> = {
  root: {
    BETTER_AUTH_SECRET: "change-me-to-a-long-random-string",
    APP_URL: "http://localhost:3000",
    AI_MODEL: "openai:gpt-4o-mini",
    TRANSCRIPTION_MODEL: "openai:whisper-1",
    ...PROVIDER_KEYS,
    STORAGE_DRIVER: "local",
    SIGNUP_MODE: "open",
    TRANSCRIBE_CHUNK_SECONDS: "600",
    MAX_UPLOAD_MB: "4096",
    CLEANUP_WORKDIR: "true",
  },
  deploy: {
    BETTER_AUTH_SECRET: "",
    APP_URL: "http://localhost:3000",
    POSTGRES_PASSWORD: "change-me",
    AI_MODEL: "openai:gpt-4o-mini",
    TRANSCRIPTION_MODEL: "openai:whisper-1",
    ...PROVIDER_KEYS,
    STORAGE_DRIVER: "local",
    SIGNUP_MODE: "open",
    EMAIL_DRIVER: "none",
    EMAIL_FROM: "",
    SMTP_URL: "",
    RESEND_API_KEY: "",
    REQUIRE_EMAIL_VERIFICATION: "false",
    TERMS_URL: "",
    PRIVACY_URL: "",
    MAX_UPLOAD_MB: "4096",
    LLM_TRACE: "logs",
    MAX_PROJECTS_PER_USER: "0",
    MAX_SOURCE_MINUTES_PER_DAY: "0",
    MAX_NEW_PROJECTS_PER_HOUR: "0",
    SOURCE_RETENTION_DAYS: "0",
    CLIP_RETENTION_DAYS: "0",
    EVENT_RETENTION_DAYS: "90",
    LLM_USAGE_RETENTION_DAYS: "180",
    ADMIN_EVENT_RETENTION_DAYS: "365",
    CAPTCHA_PROVIDER: "",
    CAPTCHA_SITE_KEY: "",
    CAPTCHA_SECRET_KEY: "",
    YTDLP_PROXY: "",
    YTDLP_COOKIES_FILE: "",
    MCP_OAUTH: "false",
    HEALTH_DETAILS: "false",
  },
};

/** variables left out of a given .env.example entirely (they only make sense in the other) */
export const ENV_OMIT: Record<"root" | "deploy", string[]> = {
  root: ["REELSAW_IMAGE"],
  deploy: ["DATABASE_URL", "REELSAW_VERSION", "REELSAW_COMMIT", "REELSAW_BUILT_AT", "NODE_ENV", "WEB_DIST", "DATA_DIR", "RUN_HTTP", "RUN_WORKERS", "ALLOW_SIGNUP"],
};
/** the deprecated alias stays out of both example files */
export const ENV_OMIT_ALL = ["ALLOW_SIGNUP"];

/** value shown on a commented line when it should differ from the schema default */
export const ENV_VALUE: Record<"root" | "deploy", Record<string, string>> = {
  root: {
    DATABASE_URL: "postgres://reelsaw:reelsaw@localhost:5432/reelsaw",
    FACE_MODEL_PATH: "apps/server/models/ultraface-rfb-320.onnx",
    TEXT_MODEL_PATH: "apps/server/models/ppocrv4-det.onnx",
    VAD_MODEL_PATH: "apps/server/models/silero-vad.onnx",
    ALIGN_MODEL_DIR: "apps/server/models/wav2vec2-base-960h",
    LOG_FILE: "/data/logs/reelsaw.log",
  },
  deploy: {
    LOG_FILE: "/data/logs/reelsaw.log",
  },
};
