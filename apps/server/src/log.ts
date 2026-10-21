/**
 * Structured logging (pino). JSON lines on stdout by default, which is what log shippers, Docker
 * and 12-factor expect; human-readable when stdout is a terminal or LOG_FORMAT=pretty.
 * When OpenTelemetry is on, the pino auto-instrumentation stamps trace_id/span_id on every line,
 * and each line that passes its level is also exported to the OTLP logs endpoint, after pino's
 * own redaction. Prompt and transcript fields are removed from the export; secret values are
 * scrubbed by the same pass issue reports use.
 *
 * Conventions (the rule lives in docs/PRINCIPLES.md, "Logging"):
 *  - one root logger built in the composition root and injected (svc.log, ctx.log); modules derive
 *    `log.child({ module: "render", projectId, clipId })` so every line carries its ids
 *  - message is a short constant phrase; variable data goes in the object (`log.info({ cuts }, "cutting")`)
 *  - errors go in `err` so pino serialises the stack: `log.error({ err }, "render failed")`
 *  - levels: fatal = cannot continue; error = a person must act; warn = degraded or recovered;
 *    info = one countable line per milestone; debug = decisions and inputs; trace = per-item loops
 *
 * Levels are a spec, `info,render=debug,http=warn`: a global level plus per-module overrides (the
 * `module` binding). The spec can be changed while running (`reelsaw log-level`), see LogControl.
 */
import { pino, type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { forwardPinoLine } from "./otel-log.js";

export type { Logger };

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogConfig {
  /** `info`, or `info,render=debug,http=warn` (global level plus per-module overrides) */
  LOG_LEVEL?: string;
  LOG_FORMAT?: "json" | "pretty" | "auto";
  /** also write JSON lines here, rotated daily (7 kept), so logs survive container re-creation */
  LOG_FILE?: string;
}

export interface LogLevels {
  global: LogLevel;
  modules: Record<string, LogLevel>;
}

const isLevel = (s: string): s is LogLevel => (LOG_LEVELS as readonly string[]).includes(s);

/** Parse `info,render=debug,http=warn`. Throws with the offending token on a bad level. */
export function parseLogLevels(spec: string | undefined, fallback: LogLevel = "info"): LogLevels {
  const out: LogLevels = { global: fallback, modules: {} };
  for (const raw of (spec ?? "").split(",")) {
    const tok = raw.trim().toLowerCase();
    if (!tok) continue;
    const eq = tok.indexOf("=");
    if (eq < 0) {
      if (!isLevel(tok)) throw new Error(`unknown log level "${tok}" (use ${LOG_LEVELS.join(", ")})`);
      out.global = tok;
      continue;
    }
    const mod = tok.slice(0, eq).trim();
    const lvl = tok.slice(eq + 1).trim();
    if (!mod || !/^[a-z0-9._-]+$/.test(mod)) throw new Error(`bad module name "${mod}" in log level "${tok}"`);
    if (!isLevel(lvl)) throw new Error(`unknown log level "${lvl}" for module ${mod} (use ${LOG_LEVELS.join(", ")})`);
    out.modules[mod] = lvl;
  }
  return out;
}

export function formatLogLevels(l: LogLevels): string {
  return [l.global, ...Object.entries(l.modules).map(([m, v]) => `${m}=${v}`)].join(",");
}

/** Runtime handle on a logger tree: read and change the level spec without a restart. */
export interface LogControl {
  /** the spec from the environment (LOG_LEVEL) */
  readonly base: LogLevels;
  /** what is in force now (base, or a temporary override) */
  effective(): LogLevels;
  /** apply a spec to the root and every live child logger; `null` restores the environment's */
  apply(levels: LogLevels | null): void;
  /** every `module` name a logger was created with so far */
  modules(): string[];
}

const controls = new WeakMap<object, LogControl>();
/** The LogControl of a logger created by createLogger (also of its children). */
export function logControl(log: Logger): LogControl | undefined {
  for (let o: object | null = log; o; o = Object.getPrototypeOf(o) as object | null) {
    const c = controls.get(o);
    if (c) return c;
  }
  return undefined;
}

/** `dest` replaces stdout/LOG_FILE with a stream (tests capture lines this way). */
export function createLogger(env: LogConfig, base: Record<string, unknown> = {}, dest?: DestinationStream): Logger {
  const format = env.LOG_FORMAT ?? "auto";
  const pretty = format === "pretty" || (format === "auto" && process.stdout.isTTY);
  // a bad spec falls back to info here; config validation reports it with a proper message
  const envLevels = (() => {
    try {
      return parseLogLevels(env.LOG_LEVEL);
    } catch {
      return parseLogLevels(undefined);
    }
  })();
  // the root and the transports stay open at "trace"; each logger's own level does the filtering, so
  // a module can be raised above or lowered below the global level while running
  const opts: LoggerOptions = {
    level: "trace",
    base: { app: "reelsaw", ...base },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ["*.password", "*.apiKey", "*.authorization", "*.cookie", "*.token", "*.secret", "password", "apiKey", "token", "secret", "headers.cookie", "headers.authorization", 'headers["x-api-key"]'],
      censor: "[redacted]",
    },
    serializers: { err: pino.stdSerializers.err },
    hooks: {
      // `s` is the line after redaction and err serialisation, and only if the level allowed it.
      // Return it unchanged so the local line still has prompts.
      streamWrite(s) {
        try {
          forwardPinoLine(s);
        } catch {
          /* exporting a log must not change the local line */
        }
        return s;
      },
    },
  };
  const console = pretty ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname,app" } } : { target: "pino/file", options: { destination: 1 } };
  const root = dest
    ? pino(opts, dest)
    : env.LOG_FILE
    ? pino({
        ...opts,
        transport: {
          targets: [
            { ...console, level: "trace" },
            { target: "pino-roll", level: "trace", options: { file: env.LOG_FILE, frequency: "daily", limit: { count: 7 }, mkdir: true, dateFormat: "yyyy-MM-dd" } },
          ],
        },
      })
    : pretty
      ? pino({ ...opts, transport: console })
      : pino(opts);

  let current = envLevels;
  const levelFor = (module: string | undefined): LogLevel => (module && current.modules[module]) || current.global;
  const seen = new Set<string>();
  const moduleOf = new WeakMap<object, string | undefined>();
  let live: Array<WeakRef<Logger>> = [];

  const origChild = root.child as unknown as (this: Logger, bindings: Record<string, unknown>, options?: Record<string, unknown>) => Logger;
  // children of children reach this through the prototype chain (pino builds them with Object.create)
  (root as unknown as { child: unknown }).child = function (this: Logger, bindings: Record<string, unknown>, options?: Record<string, unknown>) {
    const module = typeof bindings?.module === "string" ? bindings.module : moduleOf.get(this);
    const child = origChild.call(this, bindings, options);
    moduleOf.set(child, module);
    if (module) seen.add(module);
    live.push(new WeakRef(child));
    if (live.length > 4096) live = live.filter((r) => r.deref());
    child.level = levelFor(module);
    return child;
  };
  root.level = current.global;

  controls.set(root, {
    base: envLevels,
    effective: () => current,
    modules: () => [...seen],
    apply(levels) {
      current = levels ?? envLevels;
      root.level = current.global;
      live = live.filter((r) => {
        const l = r.deref();
        if (l) l.level = levelFor(moduleOf.get(l));
        return !!l;
      });
    },
  });
  return root;
}
