import fs from "node:fs/promises";
import { otel, type Otel } from "./otel.js";
import { loadConfig, makePaths, ConfigError, type Config, type Paths } from "./config.js";
import { createDatabase, type Database } from "./db/index.js";
import { createStorage, type Storage } from "./storage/index.js";
import { createAi, type AiService } from "./ai/registry.js";
import { createModelSettings, type ModelSettings } from "./ai/models.js";
import { createProviderSettings, type ProviderSettings } from "./ai/providers.js";
import { createModelCatalog, type ModelCatalog } from "./ai/catalog.js";
import { createAsr, type Asr } from "./ai/asr.js";
import { createLlmTracer, type LlmTracer } from "./ai/trace.js";
import { createProviderGate } from "./ai/gate.js";
import path from "node:path";
import { createMediaTools, type MediaTools } from "./media.js";
import { createEventBus, type EventBus } from "./events.js";
import { createQueue, type Queue } from "./queue/boss.js";
import { createUnitOfWork, type RunInTx } from "./uow.js";
import { projectEventHandlers } from "./project-event-handlers.js";
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
import { createLogLevelSettings, type LogLevelSettings } from "./log-level.js";
import { createUpdateChecker, type UpdateChecker } from "./updates.js";
import { createReleaseFeed, type ReleaseFeed } from "./releases.js";
import { createInstanceSettings, type InstanceSettings } from "./instance-settings.js";
import type { Entitlements } from "./quota.js";
import type { EE } from "./ee/index.js";
import { createTelemetry, type Telemetry } from "./telemetry.js";
import { setOtelLogScrubber } from "./otel-log.js";
import { secretValues } from "./report/redact.js";

/** Everything a handler or pipeline stage needs, built once in main() and passed explicitly. */
export interface Services {
  /** root structured logger; derive children with ids (`log.child({ clipId })`) */
  log: Logger;
  /** temporary log-level overrides, shared by every process (log-level.ts) */
  logLevel: LogLevelSettings;
  config: Config;
  paths: Paths;
  otel: Otel;
  database: Database;
  storage: Storage;
  ai: AiService;
  /** instance settings in force now (sign-up, quotas, retention, …): environment defaults, or the admin's runtime override (instance-settings.ts) */
  settings: InstanceSettings;
  /** the model ids in force now: environment defaults, or the admin's runtime override (ai/models.ts) */
  models: ModelSettings;
  /** provider keys and base URLs in force: environment, or what an admin entered (ai/providers.ts) */
  providers: ProviderSettings;
  /** what the configured providers offer, and downloads onto Ollama / Speaches (ai/catalog.ts) */
  catalog: ModelCatalog;
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
  /** is a newer release published (updates.ts); checked by the http process, shown to admins */
  updates: UpdateChecker;
  /** GitHub releases + 90-day commit heatmap (releases.ts); reelsaw.com/releases, list_releases, reelsaw releases */
  releases: ReleaseFeed;
  /** null when ALIGNER=false; then cut boundaries come from the whisper-based search only. */
  aligner: Aligner | null;
  /** null when VAD=false; then pauses are never trimmed. */
  vad: Vad | null;
  /** null when TEXT_DETECTION=false; then burned-in source text is never hidden. */
  text: TextDetector | null;
  /** null when FACE_DETECTION=false; then "auto" layout degrades to "fit". */
  faces: FaceDetector | null;
  /** Sentry + PostHog, each a no-op without its key (telemetry.ts) */
  telemetry: Telemetry;
  /** the enterprise edition (billing), loaded only with REELSAW_EE=true (ee/index.ts); null self-hosted */
  ee: EE | null;
  /** what each account's plan grants (quotas, watermark); null = no plans on this instance */
  entitlements: Entitlements | null;
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
  setOtelLogScrubber(secretValues(config));
  const telemetry = createTelemetry(config, log.child({ module: "telemetry" }));

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

  // what an admin saved (keys, model override) is loaded once the database is up; the models and keys
  // are then checked at boot against the EFFECTIVE models, so a dead local server does not block a
  // deployment an admin has already switched to a cloud model
  const providers = createProviderSettings(config, log.child({ module: "providers" }));
  // model calls in flight per provider; self-hosted = the compatible server or openai pointed at a base URL
  const gate = await step("provider concurrency", () =>
    createProviderGate(config.PROVIDER_CONCURRENCY, config.OPENAI_COMPATIBLE_NAME, (p) => (p === config.OPENAI_COMPATIBLE_NAME || p === "openai") && !!providers.get(p).baseUrl, log.child({ module: "ai" })),
  );
  let models!: ReturnType<typeof createModelSettings>;
  const ai = await step(`ai models (${config.AI_MODEL}, ${config.TRANSCRIPTION_MODEL})`, async () => {
    const a = createAi(config, log.child({ module: "ai" }), llmTrace.middleware, () => models.get(), providers, gate);
    models = createModelSettings(config, log.child({ module: "models" }), a.verify);
    // reachability is checked below, against the models that will really run (after the admin override loads)
    return a;
  });
  const catalog = createModelCatalog(config, log.child({ module: "models" }), providers);

  const faces = await step(config.FACE_DETECTION ? "face detector (UltraFace ONNX)" : "face detector (disabled)", async () => {
    if (!config.FACE_DETECTION) return null;
    try {
      return await loadFaceDetector(config.FACE_MODEL_PATH, { provider: config.ONNX_EXECUTION_PROVIDER, log: log.child({ module: "faces" }) });
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
      return await loadAligner(config.ALIGN_MODEL_DIR, { provider: config.ONNX_EXECUTION_PROVIDER, log: log.child({ module: "align" }) });
    } catch (err) {
      throw new Error(`cannot load ${config.ALIGN_MODEL_DIR}: ${(err as Error).message}. Run "pnpm models:download" or set ALIGNER=false.`);
    }
  });

  const asr = await step("asr cache", async () => {
    const a = createAsr(ai, () => models.get().transcription, path.join(config.DATA_DIR, "cache", "asr"), log.child({ module: "asr" }), gate);
    if (config.ASR_CACHE_DAYS > 0 && env.REELSAW_CLI !== "1") void a.prune(config.ASR_CACHE_DAYS).then((n) => n && log.info({ module: "asr", removed: n }, "pruned old asr cache entries"));
    return a;
  });

  const text = await step(config.TEXT_DETECTION ? "text detector (PP-OCRv4 ONNX)" : "text detector (disabled)", async () => {
    if (!config.TEXT_DETECTION) return null;
    try {
      return await loadTextDetector(config.TEXT_MODEL_PATH, { provider: config.ONNX_EXECUTION_PROVIDER, log: log.child({ module: "text" }) });
    } catch (err) {
      throw new Error(`cannot load ${config.TEXT_MODEL_PATH}: ${(err as Error).message}. Run "pnpm models:download" or set TEXT_DETECTION=false.`);
    }
  });

  const storage = await step(`storage (${config.STORAGE_DRIVER})`, async () => {
    const s = createStorage(config, paths, log.child({ module: "storage" }));
    await s.check();
    return s;
  });

  const database = await step("database", async () => {
    const d = createDatabase(config.DATABASE_URL, log.child({ module: "db" }));
    await d.check();
    await d.migrate();
    return d;
  });

  // what an admin saved under Settings → System (sign-up mode, quotas, retention, …) loads once the database is up
  const settings = createInstanceSettings(config, log.child({ module: "settings" }), { emailEnabled: config.EMAIL_DRIVER !== "none" });
  await step("instance settings", () => settings.attach(database.db));

  const logLevel = createLogLevelSettings(log, { listen: env.REELSAW_CLI !== "1" });
  const updates = createUpdateChecker(config, log.child({ module: "updates" }), { enabled: () => settings.get().UPDATE_CHECK });
  const releases = createReleaseFeed(config, log.child({ module: "releases" }));
  await step("log level settings", async () => {
    await logLevel.attach(database.db, config.DATABASE_URL);
  });

  await step("model settings", async () => {
    await providers.attach(database.db);
    const s = await models.attach(database.db);
    if (Object.keys(s.override).length) log.info({ module: "models", models: s.current, override: s.override, by: s.updatedBy }, "admin model override in force");
  });

  // the provider limits now hold across every process (ai/gate.ts)
  gate.attach(database.pool);

  await step(`ai model check (${models.get().language}, ${models.get().transcription})`, async () => {
    const eff = models.get();
    await ai.check(eff);
    // an unreachable environment default only matters if it is what runs; with an override in force, warn
    for (const [envVar, kind, envId, effId] of [
      ["AI_MODEL", "language", config.AI_MODEL, eff.language],
      ["TRANSCRIPTION_MODEL", "transcription", config.TRANSCRIPTION_MODEL, eff.transcription],
    ] as const) {
      if (envId === effId) continue;
      await ai.verify(kind, envId).catch((err) => log.warn({ module: "models", envVar, model: envId, reason: (err as Error).message }, `${envVar} is not usable but an admin override is in force; fix it or clear the override before relying on the default`));
    }
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
        costUsd: u.costUsd ?? null,
      })
      .catch((err) => log.warn({ module: "llm", err }, "usage row failed"));
  };
  asr.onUsage = (u) => {
    void database.db
      .insert(schema.sttUsage)
      .values({
        userId: u.ctx.projectId ? sql`(select user_id from projects where id = ${u.ctx.projectId})` : null,
        projectId: u.ctx.projectId ?? null,
        stage: u.ctx.stage ?? null,
        provider: u.provider,
        model: u.model,
        audioSec: u.audioSec,
        ms: u.ms,
        ok: u.ok,
      })
      .catch((err) => log.warn({ module: "asr", err }, "usage row failed"));
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

  const auth = await step("auth", () => createAuth(config, database.db, email, log.child({ module: "auth" }), settings, telemetry));

  const svc: Services = { log, logLevel, config, paths, otel, database, storage, ai, settings, models, providers, catalog, llmTrace, asr, media, events, queue, tx: undefined as unknown as RunInTx, auth, email, resources, updates, releases, telemetry, faces, text, vad, aligner, ee: null, entitlements: null };
  // jobs that commit with the event that triggers them (event-handlers.ts)
  svc.tx = createUnitOfWork(database.pool, queue, log.child({ module: "uow" }), () => settings.get(), () => svc.entitlements, telemetry, { handlers: projectEventHandlers, deps: () => svc });
  if (config.REELSAW_EE) {
    // dynamic import on purpose: with REELSAW_EE unset the folder (and its licence) never loads
    svc.ee = await step("enterprise edition (billing)", async () => (await import("./ee/index.js")).createEE(svc));
    svc.entitlements = svc.ee.entitlements;
  }
  return svc;
}

export async function shutdownServices(s: Services) {
  s.logLevel.stop();
  s.updates.stop();
  s.settings.stop();
  s.models.stop();
  s.providers.stop();
  await s.queue.stop().catch((err) => s.log.error({ err }, "queue shutdown failed"));
  await s.faces?.release().catch(() => {});
  await s.text?.release().catch(() => {});
  await s.vad?.release().catch(() => {});
  await s.aligner?.release().catch(() => {});
  await s.llmTrace.shutdown();
  await s.telemetry.shutdown();
  await s.events.stop().catch(() => {});
  await s.database.close().catch(() => {});
  await s.otel.shutdown().catch(() => {});
}
