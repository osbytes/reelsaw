import "./otel.js"; // must stay first: patches http/pg before they load when OTEL_ENABLED=true
import { serve } from "@hono/node-server";
import { createServices, shutdownServices, StartupError } from "./services.js";
import { createLogger } from "./log.js";
import { createApp } from "./http.js";
import { startWorkers } from "./queue/workers.js";
import { startReconciler } from "./queue/reconcile.js";
import { beat, startHeartbeat } from "./ops/workers.js";
import { trackHttpServer, type HttpCloser } from "./http-shutdown.js";

async function main() {
  const svc = await createServices();
  const { config } = svc;
  const log = svc.log.child({ module: "boot" });
  log.info(
    {
      aiModel: svc.models.get().language,
      transcriptionModel: svc.models.get().transcription,
      openaiBaseUrl: config.OPENAI_BASE_URL ?? null,
      storage: config.STORAGE_DRIVER + (config.S3_BUCKET ? `:${config.S3_BUCKET}` : ""),
      dataDir: config.DATA_DIR,
      renderConcurrency: config.RENDER_CONCURRENCY,
      signupMode: svc.settings.get().SIGNUP_MODE,
      email: config.EMAIL_DRIVER,
      otel: svc.otel.enabled,
      ee: !!svc.ee,
    },
    "started",
  );

  if (config.SHUTDOWN_GRACE_SECONDS > 300) {
    // docker kills the container at stop_grace_period (330 s unless STOP_GRACE_PERIOD is set), whatever this says
    log.warn({ graceSeconds: config.SHUTDOWN_GRACE_SECONDS, minStopGracePeriodSeconds: config.SHUTDOWN_GRACE_SECONDS + 30 }, "SHUTDOWN_GRACE_SECONDS is above 300: set STOP_GRACE_PERIOD to at least SHUTDOWN_GRACE_SECONDS + 30s in the compose file's environment, or docker kills running jobs early");
  }

  // a rejection nobody awaited is a bug worth a line (and a stack); an uncaught exception leaves unknown state
  process.on("unhandledRejection", (err) => {
    log.error({ err }, "unhandled rejection");
    svc.telemetry.captureException(err, { where: "unhandledRejection" });
  });
  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "uncaught exception");
    svc.telemetry.captureException(err, { where: "uncaughtException" });
    setTimeout(() => process.exit(1), 100).unref();
  });

  let server: ReturnType<typeof serve> | undefined;
  let stopReconciler: (() => void) | undefined;
  let stopHeartbeat: (() => Promise<void>) | undefined;
  let stopDiskGate: (() => void) | undefined;
  let httpCloser: HttpCloser | undefined;

  if (config.RUN_HTTP) {
    const app = createApp(svc);
    // requestTimeout 0: Node's default (300 s) cuts off a multi-GB upload on an ordinary connection;
    // headersTimeout and keep-alive still close idle sockets
    server = serve({ fetch: app.fetch, port: config.PORT, serverOptions: { requestTimeout: 0 } }, (info) => log.info({ port: info.port, appUrl: config.APP_URL }, "http listening"));
    httpCloser = trackHttpServer(server);
    server.on("error", (err) => {
      log.fatal({ err, port: config.PORT }, "cannot listen");
      process.exit(1);
    });
    svc.updates.start();
  }
  if (config.RUN_WORKERS) {
    const { diskGate } = await startWorkers(svc);
    stopDiskGate = () => diskGate.stop();
    if (svc.ee) await svc.ee.startWorkers();
    stopReconciler = startReconciler(svc);
  }
  if (config.RUN_HTTP || config.RUN_WORKERS) {
    await beat(svc).catch((err) => log.warn({ err, module: "ops" }, "worker heartbeat failed"));
    stopHeartbeat = startHeartbeat(svc);
  }

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal: sig }, "shutting down");
    log.info({ graceSeconds: config.SHUTDOWN_GRACE_SECONDS }, "waiting for running jobs to finish");
    setTimeout(() => process.exit(1), (config.SHUTDOWN_GRACE_SECONDS + 15) * 1000).unref();
    stopReconciler?.();
    stopDiskGate?.();
    // stop accepting and end SSE streams now; a request still running gets 10 s, then the job drain below goes on
    if (httpCloser && !(await httpCloser.close(10_000))) log.warn({ timeoutSeconds: 10 }, "http connections still open after the close cap; continuing shutdown");
    // the heartbeat (and the disk leases it vouches for) stays until the jobs have finished: a job still writing
    // during the grace keeps its claim, so another process on the volume cannot start on the same bytes
    await shutdownServices(svc, { afterQueueStop: () => stopHeartbeat?.() ?? Promise.resolve() });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  // services may not exist yet: log with a standalone logger so the failure is still structured
  const log = createLogger({ LOG_LEVEL: process.env.LOG_LEVEL || "info", LOG_FORMAT: process.env.LOG_FORMAT === "json" || process.env.LOG_FORMAT === "pretty" ? process.env.LOG_FORMAT : "auto" }, { module: "boot" });
  if (err instanceof StartupError) {
    log.fatal({ step: err.step, reason: err.message }, `startup failed at step "${err.step}"`);
    // also a plain, readable line for humans reading `docker compose logs`
    process.stderr.write(`\nstartup failed at step "${err.step}":\n${err.message.split("\n").map((l) => "  " + l).join("\n")}\n\n`);
    setTimeout(() => process.exit(78), 50); // EX_CONFIG; let pino flush
    return;
  }
  log.fatal({ err }, "fatal");
  setTimeout(() => process.exit(1), 50);
});
