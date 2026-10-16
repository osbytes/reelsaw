import { z } from "zod";
import path from "node:path";

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
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // json: one JSON object per line (default when stdout is not a terminal); pretty: human-readable
  LOG_FORMAT: z.enum(["auto", "json", "pretty"]).default("auto"),
  PORT: z.coerce.number().default(3000),
  APP_URL: z.string().default("http://localhost:3000"),
  // baked into the image at build time (Dockerfile build args); "dev" when running from source
  REELSAW_VERSION: z.string().default("dev"),
  REELSAW_COMMIT: z.string().default("unknown"),
  REELSAW_BUILT_AT: z.string().default("unknown"),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(16),
  DATA_DIR: z.string().default(path.resolve(process.cwd(), "data")),
  WEB_DIST: z.string().optional(),

  RUN_WORKERS: boolTrue,
  RUN_HTTP: boolTrue,
  ALLOW_SIGNUP: boolTrue,
  RENDER_CONCURRENCY: z.coerce.number().int().min(1).default(2),
  MAX_UPLOAD_MB: z.coerce.number().default(4096),

  AI_MODEL: z.string().default("openai:gpt-4o-mini"),
  TRANSCRIPTION_MODEL: z.string().default("openai:whisper-1"),
  TRANSCRIBE_CHUNK_SECONDS: z.coerce.number().int().min(60).default(600),
  /** Model used to re-align cut boundaries on short windows (default: TRANSCRIPTION_MODEL). A bigger whisper here is cheap and pays off. */
  TRANSCRIPT_ALIGN_MODEL: z.string().optional(),
  /** Parallel chunk transcriptions. 0 = auto: 1 for a self-hosted OPENAI_BASE_URL (serialises on the model anyway), 3 for cloud vendors. */
  TRANSCRIBE_CONCURRENCY: z.coerce.number().int().min(0).max(8).default(0),
  /** Parallel LLM calls while finding/scoring moments. 0 = auto (1 for a self-hosted model, 4 for cloud). */
  ANALYZE_CONCURRENCY: z.coerce.number().int().min(0).max(16).default(0),
  /** Rubric samples per candidate (median is kept). 0 = auto (1 self-hosted, 3 cloud). */
  ANALYZE_SCORE_SAMPLES: z.coerce.number().int().min(0).max(7).default(0),
  /** Pairwise re-ranking of the top clips with position swapping. auto = on for cloud models only. */
  ANALYZE_PAIRWISE: z.enum(["auto", "on", "off"]).default("auto"),
  /** Feed entities from the video metadata (channel, title, description, tags) to the transcriber as vocabulary hints. */
  TRANSCRIPT_BIAS: boolTrue,
  /** After transcription, let the language model fix misheard entity names (constrained to fuzzy matches). */
  TRANSCRIPT_CORRECTION: boolTrue,
  /** Detect fillers / repetitions / false starts and remove them from captions (rules + optional LLM pass). */
  DISFLUENCY_REMOVAL: boolTrue,
  DISFLUENCY_LLM: boolTrue,
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

  OTEL_ENABLED: boolFalse,

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
  ALIGN_MODEL_DIR: z.string().default(path.resolve(process.cwd(), "models/wav2vec2-base-960h")),
  VAD_MODEL_PATH: z.string().default(path.resolve(process.cwd(), "models/silero-vad.onnx")),
  TEXT_MODEL_PATH: z.string().default(path.resolve(process.cwd(), "models/ppocrv4-det.onnx")),
  LAYOUT_MIN_FACE_RATIO: z.coerce.number().min(0).max(1).default(0.6), // share of frames that must contain a face
  LAYOUT_MIN_FACE_SIZE: z.coerce.number().min(0).max(1).default(0.18), // median face height / frame height

  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  YTDLP_PATH: z.string().default("yt-dlp"),
  CAPTION_FONT: z.string().default("DejaVu Sans"),
});

export type Config = z.infer<typeof envSchema>;

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
  const c = parsed.data;
  if (c.STORAGE_DRIVER === "s3" && !c.S3_BUCKET) throw new ConfigError("STORAGE_DRIVER=s3 requires S3_BUCKET");
  // the operator CLI (src/cli.ts) runs with both off on purpose
  if (!c.RUN_HTTP && !c.RUN_WORKERS && env.REELSAW_CLI !== "1") throw new ConfigError("RUN_HTTP and RUN_WORKERS are both false; nothing to run");
  if (c.NODE_ENV === "production" && c.BETTER_AUTH_SECRET.length < 32) throw new ConfigError("BETTER_AUTH_SECRET must be at least 32 characters in production");
  return c;
}
