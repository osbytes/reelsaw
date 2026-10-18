/**
 * Log levels you can change while the app runs. LOG_LEVEL (`info,render=debug`) is the default; an
 * operator (`reelsaw log-level render=debug --for 15m`, or Settings > System) can override it for a
 * bounded time. The override is stored in `instance_settings` (key `log_level`) so every process (api,
 * workers) applies it: the one that saved it at once, the others on their next poll (~5 s). When the
 * time is up each process drops back to the environment's levels on its own, and the row is removed.
 */
import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { schema } from "./db/index.js";
import { formatLogLevels, logControl, parseLogLevels, type LogLevel, type LogLevels, type Logger } from "./log.js";

const KEY = "log_level";
export const MAX_LOG_OVERRIDE_MS = 24 * 3600_000;
export const DEFAULT_LOG_OVERRIDE_MS = 15 * 60_000;

export interface LogLevelState {
  /** what is in force now, e.g. `info,render=debug` */
  effective: string;
  /** from LOG_LEVEL */
  env: string;
  /** the temporary override, or null when the environment is in charge */
  override: { spec: string; until: string; by: string | null } | null;
}

export interface LogLevelSettings {
  state(): LogLevelState;
  /** re-read the stored override (every process does this on a timer) */
  refresh(): Promise<LogLevelState>;
  /** set an override for `forMs` (default 15 min, max 24 h); `null` clears it */
  set(spec: string | null, actor: string, forMs?: number): Promise<LogLevelState>;
  stop(): void;
}

/** Parse a duration like `90s`, `15m`, `2h`; undefined when it is not one. */
export function parseDuration(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)$/i.exec(s.trim());
  if (!m) return undefined;
  return Math.round(Number(m[1]) * ({ s: 1000, m: 60_000, h: 3600_000 } as const)[m[2]!.toLowerCase() as "s" | "m" | "h"]);
}

/** A bare level in the override replaces the global level; otherwise the environment's global stays. */
export function mergeLogLevels(base: LogLevels, spec: string): LogLevels {
  const over = parseLogLevels(spec, base.global);
  return { global: over.global, modules: { ...base.modules, ...over.modules } };
}

export function createLogLevelSettings(log: Logger, opts: { pollMs?: number } = {}): LogLevelSettings & { attach(db: Db): Promise<LogLevelState> } {
  const control = logControl(log);
  let db: Db | undefined;
  let timer: NodeJS.Timeout | undefined;
  let override: LogLevelState["override"] = null;
  let applied = "";

  const state = (): LogLevelState => ({ effective: control ? formatLogLevels(control.effective()) : "info", env: control ? formatLogLevels(control.base) : "info", override });

  function apply(next: LogLevelState["override"]) {
    override = next;
    const key = next ? `${next.spec}|${next.until}` : "";
    if (!control || key === applied) return;
    applied = key;
    control.apply(next ? mergeLogLevels(control.base, next.spec) : null);
    log.child({ module: "log" }).warn({ levels: state().effective, until: next?.until ?? null }, next ? "log level override applied" : "log level back to the environment's");
  }

  async function load(): Promise<LogLevelState> {
    if (!db) return state();
    const row = await db.query.instanceSettings.findFirst({ where: eq(schema.instanceSettings.key, KEY) });
    const v = row?.value as { spec?: string; until?: string } | undefined;
    const until = v?.until ? Date.parse(v.until) : NaN;
    if (v?.spec && Number.isFinite(until) && until > Date.now()) {
      try {
        parseLogLevels(v.spec);
        apply({ spec: v.spec, until: v.until!, by: row?.updatedBy ?? null });
        return state();
      } catch {
        /* a bad stored spec is ignored */
      }
    }
    apply(null);
    if (row) await db.delete(schema.instanceSettings).where(eq(schema.instanceSettings.key, KEY)).catch(() => {});
    return state();
  }

  return {
    state,
    refresh: load,
    async attach(database) {
      db = database;
      const s = await load();
      const pollMs = opts.pollMs ?? 5000;
      if (pollMs > 0) {
        timer = setInterval(() => void load().catch((err) => log.warn({ module: "log", err }, "log level refresh failed")), pollMs);
        timer.unref();
      }
      return s;
    },
    async set(spec, actor, forMs = DEFAULT_LOG_OVERRIDE_MS) {
      if (!db) throw new Error("log level settings are not attached to a database");
      if (spec === null || spec.trim() === "") {
        await db.delete(schema.instanceSettings).where(eq(schema.instanceSettings.key, KEY));
        apply(null);
        return state();
      }
      parseLogLevels(spec); // throws a readable message on a bad spec
      const ms = Math.max(1000, Math.min(forMs, MAX_LOG_OVERRIDE_MS));
      const until = new Date(Date.now() + ms).toISOString();
      const value = { spec: spec.trim(), until };
      await db
        .insert(schema.instanceSettings)
        .values({ key: KEY, value, updatedBy: actor })
        .onConflictDoUpdate({ target: schema.instanceSettings.key, set: { value, updatedBy: actor, updatedAt: new Date() } });
      apply({ ...value, by: actor });
      return state();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

/** Module names used in code (the `module` binding), so the picker offers them before they have logged anything. */
export const KNOWN_LOG_MODULES = ["accounts", "ai", "analyze", "asr", "auth", "boot", "bumpers", "cli", "cut-preview", "cuts", "db", "email", "events", "export", "http", "ingest", "llm", "log", "mcp", "media", "models", "otel", "providers", "prune", "queue", "reconcile", "refine", "render", "resources", "retention", "storage", "sweep", "transcribe", "uow", "uploads", "watchdog", "web", "worker"] as const;

/** The levels a person may pick, most severe first (not `silent`: it hides errors too). */
export const PICKABLE_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

/** Every module that can be targeted: the static set plus whatever has registered with the logger. */
export function knownModules(log: Logger): string[] {
  return [...new Set<string>([...KNOWN_LOG_MODULES, ...(logControl(log)?.modules() ?? [])])].sort();
}

export interface StructuredLevels {
  global: LogLevel;
  modules: Array<{ module: string; level: LogLevel }>;
}

/** Build the `info,render=debug` spec from picker input; throws on a module that is not known. A repeated module: the last row wins. */
export function specFromStructured(input: StructuredLevels, known: readonly string[]): string {
  const unknown = input.modules.filter((m) => !known.includes(m.module)).map((m) => m.module);
  if (unknown.length) throw new Error(`unknown log module${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  const byModule = new Map(input.modules.map((m) => [m.module, m.level]));
  return [input.global, ...[...byModule].map(([m, l]) => `${m}=${l}`)].join(",");
}
