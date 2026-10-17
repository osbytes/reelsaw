import fs from "node:fs/promises";
import { otel, type Otel } from "./otel.js";
import { loadConfig, makePaths, ConfigError, type Config, type Paths } from "./config.js";
import { createDatabase, type Database } from "./db/index.js";
import { createStorage, type Storage } from "./storage/index.js";
import { createAi, type AiService } from "./ai/registry.js";
import { createAsr, type Asr } from "./ai/asr.js";
import { createLlmTracer, type LlmTracer } from "./ai/trace.js";
import path from "node:path";
import { createMediaTools, type MediaTools } from "./media.js";
import { createEventBus, type EventBus } from "./events.js";
import { createQueue, type Queue } from "./queue/boss.js";
import { createUnitOfWork, type RunInTx } from "./uow.js";
import { createAuth, type Auth } from "./auth.js";
import { createEmail, type Email } from "./email.js";
import { sql } from "drizzle-orm";
import { schema } from "./db/index.js";
import { createResourceGovernor, type ResourceGovernor } from "./resources.js";
import { loadFaceDetector, type FaceDetector } from "./vision/faces.js";
import { loadTextDetector, type TextDetector } from "./vision/text.js";
import { loadVad, type Vad } from "./audio/vad.js";
import { loadAligner, type Aligner } from "./audio/align.js";
import { createLogger, type Logger } from "./log.js";

/** Everything a handler or pipeline stage needs, built once in main() and passed explicitly. */
export interface Services {
  /** root structured logger; derive children with ids (`log.child({ clipId })`) */
  log: Logger;
  config: Config;
  paths: Paths;
  otel: Otel;
  database: Database;
  storage: Storage;
  ai: AiService;
  /** LLM call capture (LLM_TRACE) */
  llmTrace: LlmTracer;
  /** cached speech-to-text (content-addressed) */
  asr: Asr;
  media: MediaTools;
  events: EventBus;
  queue: Queue;
  /** run a unit of work: state change + events + job enqueues in one transaction (uow.ts) */
  tx: RunInTx;
  auth: Auth;
  email: Email;
  resources: ResourceGovernor;
  /** null when ALIGNER=false; then cut boundaries come from the whisper-based search only. */
  aligner: Aligner | null;
  /** null when VAD=false; then pauses are never trimmed. */
  vad: Vad | null;
  /** null when TEXT_DETECTION=false; then burned-in source text is never hidden. */
  text: TextDetector | null;
  /** null when FACE_DETECTION=false; then "auto" layout degrades to "fit". */
  faces: FaceDetector | null;
}

export class StartupError extends Error {
  constructor(
    public step: string,
    message: string,
  ) {
    super(`${step}: ${message}`);
  }
}

/**
 * Build and verify every service in dependency order. Any failure throws a StartupError with
 * a human-readable reason so main() can crash the process immediately (12-factor fail-fast)
 * rather than surfacing a deferred error on the first request or job.
 */
export async function createServices(env: NodeJS.ProcessEnv = process.env): Promise<Services> {
  // the logger comes first (from raw env, before validation) so config errors are logged too
  const fmt = env.LOG_FORMAT === "json" || env.LOG_FORMAT === "pretty" ? env.LOG_FORMAT : "auto";
  const role = env.REELSAW_CLI === "1" ? "cli" : env.RUN_HTTP === "false" ? "worker" : env.RUN_WORKERS === "false" ? "api" : "app";
  const log = createLogger({ LOG_LEVEL: env.LOG_LEVEL || "info", LOG_FORMAT: fmt, LOG_FILE: env.REELSAW_CLI === "1" ? undefined : env.LOG_FILE || undefined }, { role: env.REELSAW_CLI === "1" ? "cli" : role });
  const bootLog = log.child({ module: "boot" });
  const step = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    try {
      const t0 = Date.now();
      const out = await fn();
      bootLog.info({ step: name, ms: Date.now() - t0 }, "boot step ok");
      return out;
    } catch (err) {
      if (err instanceof StartupError) throw err;
      throw new StartupError(name, (err as Error).message ?? String(err));
    }
  };

  const config = await step("config", () => {
    try {
      return loadConfig(env);
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      throw err;
    }
  });
  const paths = makePaths(config.DATA_DIR);

  await step("data dir", async () => {
    for (const d of [paths.uploads, paths.projects, paths.tmp]) await fs.mkdir(d, { recursive: true });
    const probe = `${paths.tmp}/.write-test-${process.pid}`;
    await fs.writeFile(probe, "ok");
    await fs.rm(probe, { force: true });
  });

  const resources = await step("resources", async () => {
    const r = createResourceGovernor(config, config.DATA_DIR, log.child({ module: "resources" }));
    await r.check();
    return r;
  });

  const media = await step("media tools (ffmpeg, ffprobe, yt-dlp)", async () => {
    const m = createMediaTools(config, log.child({ module: "media" }));
    await m.check();
    return m;
  });

  const llmTrace = await step("llm call capture", async () => {
    const t = await createLlmTracer(config, log);
    if (env.REELSAW_CLI !== "1") await t.check();
    if (t.sinks.length) log.info({ module: "llm", sinks: t.sinks }, "capturing LLM calls");
    return t;
  });

  const ai = await step(`ai models (${config.AI_MODEL}, ${config.TRANSCRIPTION_MODEL})`, async () => {
    const a = createAi(config, log.child({ module: "ai" }), llmTrace.middleware);
    await a.check();
    return a;
  });

  const faces = await step(config.FACE_DETECTION ? "face detector (UltraFace ONNX)" : "face detector (disabled)", async () => {
    if (!config.FACE_DETECTION) return null;
    try {
      return await loadFaceDetector(config.FACE_MODEL_PATH);
    } catch (err) {
      throw new Error(`cannot load ${config.FACE_MODEL_PATH}: ${(err as Error).message}. Run "pnpm models:download" or set FACE_DETECTION=false.`);
    }
  });

  const vad = await step(config.VAD ? "voice activity detector (Silero VAD)" : "voice activity detector (disabled)", async () => {
    if (!config.VAD) return null;
    try {
      return await loadVad(config.VAD_MODEL_PATH);
    } catch (err) {
      throw new Error(`cannot load ${config.VAD_MODEL_PATH}: ${(err as Error).message}. Run "pnpm models:download" or set VAD=false.`);
    }
  });

  const aligner = await step(config.ALIGNER ? "forced aligner (wav2vec2 CTC)" : "forced aligner (disabled)", async () => {
    if (!config.ALIGNER) return null;
    try {
      return await loadAligner(config.ALIGN_MODEL_DIR);
    } catch (err) {
      throw new Error(`cannot load ${config.ALIGN_MODEL_DIR}: ${(err as Error).message}. Run "pnpm models:download" or set ALIGNER=false.`);
    }
  });

  const asr = await step("asr cache", async () => {
    const a = createAsr(ai, config.TRANSCRIPTION_MODEL, path.join(config.DATA_DIR, "cache", "asr"), log.child({ module: "asr" }));
    if (config.ASR_CACHE_DAYS > 0 && env.REELSAW_CLI !== "1") void a.prune(config.ASR_CACHE_DAYS).then((n) => n && log.info({ module: "asr", removed: n }, "pruned old asr cache entries"));
    return a;
  });

  const text = await step(config.TEXT_DETECTION ? "text detector (PP-OCRv4 ONNX)" : "text detector (disabled)", async () => {
    if (!config.TEXT_DETECTION) return null;
    try {
      return await loadTextDetector(config.TEXT_MODEL_PATH);
    } catch (err) {
      throw new Error(`cannot load ${config.TEXT_MODEL_PATH}: ${(err as Error).message}. Run "pnpm models:download" or set TEXT_DETECTION=false.`);
    }
  });

  const storage = await step(`storage (${config.STORAGE_DRIVER})`, async () => {
    const s = createStorage(config, paths);
    await s.check();
    return s;
  });

  const database = await step("database", async () => {
    const d = createDatabase(config.DATABASE_URL, log.child({ module: "db" }));
    await d.check();
    await d.migrate();
    return d;
  });

  // usage accounting: one row per model call, attributed to the project's owner
  llmTrace.onUsage = (u) => {
    const db = database.db;
    void db
      .insert(schema.llmUsage)
      .values({
        userId: u.ctx.projectId ? sql`(select user_id from projects where id = ${u.ctx.projectId})` : null,
        projectId: u.ctx.projectId ?? null,
        stage: u.ctx.stage ?? null,
        call: u.ctx.call ?? null,
        model: u.model,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        ms: u.ms,
        ok: u.ok,
      })
      .catch((err) => log.warn({ module: "llm", err }, "usage row failed"));
  };

  const events = await step("event bus", async () => {
    const e = createEventBus(config, database.db, database.pool, log.child({ module: "events" }));
    if (config.RUN_HTTP) await e.start();
    return e;
  });

  const queue = await step("job queue (pg-boss)", async () => {
    const q = createQueue(config, database.pool, otel.enabled, log.child({ module: "queue" }));
    await q.start();
    return q;
  });

  const email = await step(config.EMAIL_DRIVER === "none" ? "email (disabled)" : `email (${config.EMAIL_DRIVER})`, async () => {
    const e = createEmail(config, log.child({ module: "email" }));
    if (env.REELSAW_CLI !== "1") await e.check();
    return e;
  });

  const auth = await step("auth", () => createAuth(config, database.db, email, log.child({ module: "auth" })));

  const tx = createUnitOfWork(database.pool, queue, log.child({ module: "uow" }));
  return { log, config, paths, otel, database, storage, ai, llmTrace, asr, media, events, queue, tx, auth, email, resources, faces, text, vad, aligner };
}

export async function shutdownServices(s: Services) {
  await s.queue.stop().catch((err) => s.log.error({ err }, "queue shutdown failed"));
  await s.faces?.release().catch(() => {});
  await s.text?.release().catch(() => {});
  await s.vad?.release().catch(() => {});
  await s.aligner?.release().catch(() => {});
  await s.llmTrace.shutdown();
  await s.events.stop().catch(() => {});
  await s.database.close().catch(() => {});
  await s.otel.shutdown().catch(() => {});
}
