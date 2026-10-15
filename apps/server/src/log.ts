/**
 * Structured logging (pino). JSON lines on stdout by default, which is what log shippers, Docker
 * and 12-factor expect; human-readable when stdout is a terminal or LOG_FORMAT=pretty.
 * When OpenTelemetry is on, the pino auto-instrumentation stamps trace_id/span_id on every line.
 *
 * Conventions:
 *  - one root logger built in the composition root and injected (svc.log); modules derive
 *    `log.child({ module: "render", projectId, clipId })` so every line carries its ids
 *  - message is a short constant phrase; variable data goes in the object (`log.info({ cuts }, "cutting")`)
 *  - errors go in `err` so pino serialises the stack: `log.error({ err }, "render failed")`
 */
import { pino, type Logger, type LoggerOptions } from "pino";

export type { Logger };

export interface LogConfig {
  LOG_LEVEL?: string;
  LOG_FORMAT?: "json" | "pretty" | "auto";
}

export function createLogger(env: LogConfig, base: Record<string, unknown> = {}): Logger {
  const format = env.LOG_FORMAT ?? "auto";
  const pretty = format === "pretty" || (format === "auto" && process.stdout.isTTY);
  const opts: LoggerOptions = {
    level: env.LOG_LEVEL ?? "info",
    base: { app: "reelsaw", ...base },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: ["*.password", "*.apiKey", "*.authorization", "*.cookie", "headers.cookie", "headers.authorization"], censor: "[redacted]" },
    serializers: { err: pino.stdSerializers.err },
  };
  if (pretty) return pino({ ...opts, transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname,app" } } });
  return pino(opts);
}
