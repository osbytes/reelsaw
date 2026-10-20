import { z } from "zod";
import path from "node:path";
import { parseLogLevels } from "./log.js";
import { parseYtdlpProxies } from "./ytdlp-proxy.js";

const boolTrue = z
  .string()
  .optional()
  .transform((v) => v === undefined || ["1", "true", "yes", "on"].includes(v.toLowerCase()));
const boolFalse = z
  .string()
  .optional()
  .transform((v) => v !== undefined && ["1", "true", "yes", "on"].includes(v.toLowerCase()));

export const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  // a level (`info`) or a level plus per-module overrides (`info,render=debug,http=warn`); see log.ts
  LOG_LEVEL: z
    .string()
    .default("info")
    .refine((v) => {
      try {
        parseLogLevels(v);
        return true;
      } catch {
        return false;
      }
    }, "LOG_LEVEL must be a level (trace, debug, info, warn, error, fatal, silent) optionally followed by module=level pairs, e.g. info,render=debug"),
  // json: one JSON object per line (default when stdout is not a terminal); pretty: human-readable
  LOG_FORMAT: z.enum(["auto", "json", "pretty"]).default("auto"),
  PORT: z.coerce.number().default(3000),
  APP_URL: z.string().default("http://localhost:3000"),
  // baked into the image at build time (Dockerfile build args); "dev" when running from source
  REELSAW_VERSION: z.string().default("dev"),
  REELSAW_COMMIT: z.string().default("unknown"),
  REELSAW_BUILT_AT: z.string().default("unknown"),
  // "a newer Reelsaw is available" (updates.ts); documented in scripts/docs-meta.ts
  UPDATE_CHECK: boolTrue,
  UPDATE_CHECK_URL: z.string().url().default("https://api.github.com/repos/osbytes/reelsaw/releases/latest"),
  UPDATE_CHECK_HOURS: z.coerce.number().min(1).max(168).default(6),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(16),
  DATA_DIR: z.string().default(path.resolve(process.cwd(), "data")),
  WEB_DIST: z.string().optional(),

  RUN_WORKERS: boolTrue,
  RUN_HTTP: boolTrue,
  /**
   * Stable id for this process in Settings → System → Workers. Unset: `hostname:pid`. Set it to the
   * pod or container name when replicas would otherwise collide or when you want a name you recognise.
   */
  WORKER_ID: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9._:/-]+$/, "WORKER_ID may contain letters, digits, . _ : / -")
    .optional(),
  /**
   * open: anyone may sign up (single-user box, default). approval: sign-ups wait for an admin.
   * closed: no sign-ups. The first account is always the admin. ALLOW_SIGNUP=false is an alias for closed.
   */
  SIGNUP_MODE: z.enum(["open", "approval", "closed"]).optional(),
  /** @deprecated use SIGNUP_MODE */
  ALLOW_SIGNUP: z.string().optional(),
  /** Outgoing mail for approvals, password resets and verification. none = those features stay off. */
  EMAIL_DRIVER: z.enum(["none", "smtp", "resend"]).default("none"),
  EMAIL_FROM: z.string().optional(), // "Reelsaw <no-reply@example.com>"
  SMTP_URL: z.string().optional(), // smtps://user:pass@smtp.example.com:465
  RESEND_API_KEY: z.string().optional(),
  /** With an email driver: users must click the verification link before they can sign in. */
  REQUIRE_EMAIL_VERIFICATION: boolFalse,
  /** Behind a reverse proxy (Caddy, Cloudflare; the Docker deployment), the client address comes from its headers. false = ignore them (exposed directly). */
  TRUST_PROXY: boolTrue,
  /** Sign-up guards (abuse.ts); 0 / false = off. Runtime settings. */
  MAX_SIGNUPS_PER_IP_PER_DAY: z.coerce.number().int().min(0).default(0),
  BLOCK_DISPOSABLE_EMAILS: boolFalse,
  /** Changes (mutations, MCP tool calls) an account may make per minute / hour; 0 = unlimited. Runtime settings. */
  MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().min(0).default(0),
  MAX_REQUESTS_PER_HOUR: z.coerce.number().int().min(0).default(0),
  /** Shown on the sign-up form when set (hosted instances). */
  TERMS_URL: z.string().url().optional(),
  PRIVACY_URL: z.string().url().optional(),
  // "auto" (default): renders start while CPU and memory allow (see resources.ts); a number pins it
  RENDER_CONCURRENCY: z.union([z.literal("auto"), z.coerce.number().int().min(1)]).default("auto"),
  MAX_UPLOAD_MB: z.coerce.number().default(4096),
  MAX_SOURCE_FILE_MB: z.coerce.number().int().min(1).default(8192), // yt-dlp --max-filesize for URL sources
  ALLOW_PRIVATE_SOURCE_URLS: boolFalse, // true: URL sources may point at LAN/loopback addresses (e.g. a NAS)

  AI_MODEL: z.string().default("openai:gpt-4o-mini"),
  TRANSCRIPTION_MODEL: z.string().default("openai:whisper-1"),
  TRANSCRIBE_CHUNK_SECONDS: z.coerce.number().int().min(60).default(600),
  /** Model used to re-align cut boundaries on short windows (default: TRANSCRIPTION_MODEL). A bigger whisper here is cheap and pays off. */
  TRANSCRIPT_ALIGN_MODEL: z.string().optional(),
  /** Parallel chunk transcriptions. 0 = auto: 1 for a self-hosted OPENAI_BASE_URL (serialises on the model anyway), 3 for cloud vendors. */
  TRANSCRIBE_CONCURRENCY: z.coerce.number().int().min(0).max(8).default(0),
  /** Parallel LLM calls while finding/scoring moments. 0 = auto (1 for a self-hosted model, 4 for cloud). */
  ANALYZE_CONCURRENCY: z.coerce.number().int().min(0).max(16).default(0),
  /** Model calls in flight per provider across every process ("ollama=2,openai=16"; 0 = unlimited). Unset: 2 for self-hosted (the compatible server, openai with a base URL), unlimited for cloud. See ai/gate.ts. */
  PROVIDER_CONCURRENCY: z.string().default(""),
  /** Rubric samples per candidate (median is kept). 0 = auto (1 self-hosted, 3 cloud). */
  ANALYZE_SCORE_SAMPLES: z.coerce.number().int().min(0).max(7).default(0),
  /** Pairwise re-ranking of the top clips with position swapping. auto = on for cloud models only. */
  ANALYZE_PAIRWISE: z.enum(["auto", "on", "off"]).default("auto"),
  /** Sliding pairwise passes over the top 10 (pass p places rank p; 3 = the top 3 the user sees first). Cost: Σ(n-1-p) pairs × 2 calls. */
  ANALYZE_PAIRWISE_PASSES: z.coerce.number().int().min(1).max(9).default(3),
  /** Auto-mode score gate. relative (default): drop below max(FLOOR, median − K·MAD) of the run's rubric totals, so the count does not depend on how generous the judge is; absolute: the old fixed 45. */
  ANALYZE_SCORE_RULE: z.enum(["relative", "absolute"]).default("relative"),
  ANALYZE_MIN_SCORE_FLOOR: z.coerce.number().min(0).max(100).default(25),
  ANALYZE_SCORE_MAD_K: z.coerce.number().min(0).max(5).default(1),
  /** provider:model that scores and compares candidates (default: the language model). A different model avoids self-preference. */
  ANALYZE_JUDGE_MODEL: z.string().optional(),
  /** Feed entities from the video metadata (channel, title, description, tags) to the transcriber as vocabulary hints. */
  TRANSCRIPT_BIAS: boolTrue,
  /** After transcription, let the language model fix misheard entity names (constrained to fuzzy matches). Off by default; projects opt in via refineEntities when this ceiling is on. */
  TRANSCRIPT_CORRECTION: boolFalse,
  /** Detect fillers / repetitions / false starts and remove them from captions (rules + optional LLM pass). Off by default. */
  DISFLUENCY_REMOVAL: boolFalse,
  DISFLUENCY_LLM: boolFalse,
  /** Scene-cut detection and on-screen text scan during refine. Off by default. */
  REFINE_SCENES: boolFalse,
  /** Corrections at or above this LLM confidence are applied automatically; the rest wait for the user. */
  TRANSCRIPT_AUTO_FIX_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.85),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  OPENAI_API_MODE: z.enum(["responses", "chat"]).optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  ASSEMBLYAI_API_KEY: z.string().optional(),
  AI_GATEWAY_API_KEY: z.string().optional(),
  VERCEL_OIDC_TOKEN: z.string().optional(),
  OPENAI_COMPATIBLE_BASE_URL: z.string().optional(),
  OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
  OPENAI_COMPATIBLE_NAME: z.string().default("compat"),
  OPENAI_COMPATIBLE_STRUCTURED_OUTPUTS: boolTrue,

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: boolFalse,
  S3_PREFIX: z.string().optional(),
  S3_PUBLIC_URL: z.string().optional(),
  S3_PRESIGN_EXPIRES: z.coerce.number().int().default(3600),
  CLEANUP_WORKDIR: boolTrue,
  /** Events a project page replays when it connects (progress ticks never replay); older ones load on request */
  EVENT_REPLAY_LIMIT: z.coerce.number().int().min(20).max(2000).default(300),

  OTEL_ENABLED: boolFalse,
  // error reporting and product analytics (telemetry.ts); off unless set, the browser gets the public keys via system.status
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().max(60).optional(),
  POSTHOG_KEY: z.string().max(200).optional(),
  POSTHOG_HOST: z.string().url().default("https://us.i.posthog.com"),
  // quotas (0 = unlimited); admins can override per user in Users → Limits
  MAX_PROJECTS_PER_USER: z.coerce.number().int().min(0).default(0),
  MAX_SOURCE_MINUTES_PER_DAY: z.coerce.number().int().min(0).default(0),
  MAX_NEW_PROJECTS_PER_HOUR: z.coerce.number().int().min(0).default(0),
  MAX_LIVE_JOBS_PER_USER: z.coerce.number().int().min(0).default(0), // queued + running jobs a user's own requests may add to (hosted: e.g. 12)
  MAX_RERENDERS_PER_HOUR: z.coerce.number().int().min(0).default(0), // re-renders and hand-made clips a user may ask for per hour
  MAX_STORAGE_MB: z.coerce.number().int().min(0).default(0), // sources + uploads + renders + intros/outros per user; checked at upload and project creation
  /** Minutes of source video per account per period: the billing period when the account has one, else the UTC calendar month. 0 = unlimited. */
  MAX_SOURCE_MINUTES_PER_MONTH: z.coerce.number().int().min(0).default(0),
  /** Burn a small watermark into the clips of accounts that are not admins (a paid plan or an admin's per-user choice removes it). */
  WATERMARK_NON_ADMINS: boolTrue,
  WATERMARK_TEXT: z.string().trim().min(1).max(60).default("reelsaw.com"),
  // retention (0 = keep forever): stored sources / rendered clips older than this are deleted; rows stay, "Retry" re-fetches
  SOURCE_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
  CLIP_RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
  DELETED_RETENTION_DAYS: z.coerce.number().int().min(0).default(7), // deleted projects / replaced clips stay restorable this long, then rows and files go (0 = keep forever)
  // history pruning (0 = keep forever). project_events always keeps each project's run skeleton (created / run.started / done).
  EVENT_RETENTION_DAYS: z.coerce.number().int().min(0).default(90),
  LLM_USAGE_RETENTION_DAYS: z.coerce.number().int().min(0).default(180),
  ADMIN_EVENT_RETENTION_DAYS: z.coerce.number().int().min(0).default(365),
  // bot protection on sign-up / sign-in (Better Auth captcha plugin)
  CAPTCHA_PROVIDER: z.enum(["cloudflare-turnstile", "google-recaptcha", "hcaptcha"]).optional(),
  CAPTCHA_SITE_KEY: z.string().optional(),
  CAPTCHA_SECRET_KEY: z.string().optional(),
  // MCP over OAuth 2.1 (claude.ai / Claude Desktop connectors sign in with the browser); API keys always work
  MCP_OAUTH: boolFalse,
  /** Include machine resources in GET /api/health for anonymous callers (load balancers on a private network). Admins always get them. */
  HEALTH_DETAILS: boolFalse,

  // enterprise edition (apps/server/src/ee, docs/specs/ee.md): billing through Stripe. Off, the folder is never imported.
  REELSAW_EE: boolFalse,
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** Stripe as merchant of record (Managed Payments) on every Checkout Session; needs the account approved for it. */
  STRIPE_MANAGED_PAYMENTS: boolFalse,
  /** Development only: send Stripe API calls to this origin (stripe-mock, test/stripe-mock.ts) instead of api.stripe.com. */
  STRIPE_API_BASE: z.string().url().optional(),
  /** Days a past-due subscription keeps its plan after the first failed payment before the account falls back to Free. */
  BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(90).default(7),

  // resource governor (see resources.ts)
  // a running job with no progress event for this long is reported (log + UI) as stalled
  // LLM call capture: none | logs | langfuse (comma-separated for several)
  LLM_TRACE: z.string().default("none"),
  LLM_TRACE_MAX_CHARS: z.coerce.number().int().min(200).default(4000),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_BASE_URL: z.string().url().default("https://cloud.langfuse.com"),
  // speech-to-text results cache (DATA_DIR/cache/asr); entries older than this are pruned at boot
  ASR_CACHE_DAYS: z.coerce.number().int().min(0).default(14),
  STALL_MINUTES: z.coerce.number().int().min(2).default(15),
  // on SIGTERM, wait this long for running jobs to finish before exiting (deploys stop interrupting renders)
  SHUTDOWN_GRACE_SECONDS: z.coerce.number().int().min(5).max(3600).default(300),
  // also append logs to this file (survives container re-creation); stdout stays the primary stream
  LOG_FILE: z.string().optional(),
  MAX_CPU_PERCENT: z.coerce.number().min(10).max(100).default(90), // % of all CPU time busy (measured, any OS)
  MIN_FREE_MEM_MB: z.coerce.number().int().min(0).default(512),
  MIN_FREE_DISK_MB: z.coerce.number().int().min(0).default(2048),
  RESOURCE_WAIT_MAX_SECONDS: z.coerce.number().int().min(10).default(900),

  // face detection for automatic layout (vision/faces.ts)
  FACE_DETECTION: boolTrue,
  FACE_MODEL_PATH: z.string().default(path.resolve(process.cwd(), "models/ultraface-rfb-320.onnx")),
  // burned-in caption / watermark detection (PP-OCRv4 text detector); false = never hide source text
  TEXT_DETECTION: boolTrue,
  // voice activity detection (Silero VAD) for tightening long pauses; false = never trim silence
  VAD: boolTrue,
  // CTC forced alignment (wav2vec2) for exact word boundaries at disfluency cuts; false = whisper-only search
  ALIGNER: boolTrue,
  // onnxruntime execution provider for the face, text and alignment models (onnx.ts). cpu is the measured best on
  // Apple silicon (CoreML was slower for all three); cuda needs the CUDA EP binaries and CUDA 12 + cuDNN 9 libraries.
  // Unavailable providers fall back to cpu with a warning. The VAD always runs on the CPU (stateful 32 ms frames).
  ONNX_EXECUTION_PROVIDER: z.enum(["cpu", "cuda", "coreml", "dml"]).default("cpu"),
  ALIGN_MODEL_DIR: z.string().default(path.resolve(process.cwd(), "models/wav2vec2-base-960h")),
  VAD_MODEL_PATH: z.string().default(path.resolve(process.cwd(), "models/silero-vad.onnx")),
  TEXT_MODEL_PATH: z.string().default(path.resolve(process.cwd(), "models/ppocrv4-det.onnx")),
  LAYOUT_MIN_FACE_RATIO: z.coerce.number().min(0).max(1).default(0.6), // share of frames that must contain a face
  LAYOUT_MIN_FACE_SIZE: z.coerce.number().min(0).max(1).default(0.18), // median face height / frame height

  FFMPEG_PATH: z.string().default("ffmpeg"),
  // H.264 encoder for clips, bumpers and previews. auto probes h264_nvenc (NVIDIA) then h264_videotoolbox (macOS,
  // outside Docker) at boot and keeps libx264 otherwise; a named encoder must work or boot fails (media.ts)
  FFMPEG_ENCODER: z.enum(["auto", "libx264", "h264_nvenc", "h264_videotoolbox"]).default("auto"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  YTDLP_PATH: z.string().default("yt-dlp"),
  /** Datacentre IPs get blocked by YouTube: one proxy URL, or a ranked pool (ytdlp-proxy.ts) */
  YTDLP_PROXY: z.string().optional(),
  YTDLP_COOKIES_FILE: z.string().optional(),
  CAPTION_FONT: z.string().default("DejaVu Sans"),
});

export type Config = Omit<z.infer<typeof envSchema>, "SIGNUP_MODE" | "ALLOW_SIGNUP"> & { SIGNUP_MODE: "open" | "approval" | "closed" };

export interface Paths {
  root: string;
  uploads: string;
  projects: string;
  tmp: string;
  storage: string;
  project: (id: string) => string;
}

export function makePaths(dataDir: string): Paths {
  return {
    root: dataDir,
    uploads: path.join(dataDir, "uploads"),
    projects: path.join(dataDir, "projects"),
    tmp: path.join(dataDir, "tmp"),
    storage: path.join(dataDir, "storage"),
    project: (id: string) => path.join(dataDir, "projects", id),
  };
}

export class ConfigError extends Error {}

/**
 * Parse configuration from the environment (12-factor). Empty strings count as unset: `.env`
 * files and compose `env_file` commonly contain `FOO=` lines, and some AI SDK providers throw
 * at import time on an empty *_BASE_URL. The sanitised values are written back to process.env
 * because provider SDKs read their keys from there.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  for (const [k, v] of Object.entries(env)) if (v === "") delete env[k];
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new ConfigError("Invalid environment:\n" + z.prettifyError(parsed.error));
  const { ALLOW_SIGNUP, ...rest } = parsed.data;
  const c: Config = { ...rest, SIGNUP_MODE: rest.SIGNUP_MODE ?? (ALLOW_SIGNUP !== undefined && !["1", "true", "yes", "on"].includes(ALLOW_SIGNUP.toLowerCase()) ? "closed" : "open") };
  if (c.EMAIL_DRIVER !== "none" && !c.EMAIL_FROM) throw new ConfigError(`EMAIL_DRIVER=${c.EMAIL_DRIVER} requires EMAIL_FROM`);
  if (c.EMAIL_DRIVER === "smtp" && !c.SMTP_URL) throw new ConfigError("EMAIL_DRIVER=smtp requires SMTP_URL");
  if (c.EMAIL_DRIVER === "resend" && !c.RESEND_API_KEY) throw new ConfigError("EMAIL_DRIVER=resend requires RESEND_API_KEY");
  if (c.REQUIRE_EMAIL_VERIFICATION && c.EMAIL_DRIVER === "none") throw new ConfigError("REQUIRE_EMAIL_VERIFICATION needs an EMAIL_DRIVER");
  if (c.CAPTCHA_PROVIDER && (!c.CAPTCHA_SITE_KEY || !c.CAPTCHA_SECRET_KEY)) throw new ConfigError("CAPTCHA_PROVIDER requires CAPTCHA_SITE_KEY and CAPTCHA_SECRET_KEY");
  if (c.STORAGE_DRIVER === "s3" && !c.S3_BUCKET) throw new ConfigError("STORAGE_DRIVER=s3 requires S3_BUCKET");
  if (c.REELSAW_EE && (!c.STRIPE_SECRET_KEY || !c.STRIPE_WEBHOOK_SECRET)) throw new ConfigError("REELSAW_EE=true requires STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET");
  // the operator CLI (src/cli.ts) runs with both off on purpose
  if (!c.RUN_HTTP && !c.RUN_WORKERS && env.REELSAW_CLI !== "1") throw new ConfigError("RUN_HTTP and RUN_WORKERS are both false; nothing to run");
  if (c.NODE_ENV === "production" && c.BETTER_AUTH_SECRET.length < 32) throw new ConfigError("BETTER_AUTH_SECRET must be at least 32 characters in production");
  try {
    if (c.YTDLP_PROXY) parseYtdlpProxies(c.YTDLP_PROXY);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }
  return c;
}
