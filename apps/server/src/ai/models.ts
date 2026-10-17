/**
 * Which models run right now. The environment (AI_MODEL, TRANSCRIPTION_MODEL, TRANSCRIPT_ALIGN_MODEL)
 * is the default; an admin can override any of the three from Settings without a restart, and the
 * override is stored in `instance_settings` so every process (api, workers) picks it up. API keys and
 * base URLs stay in the environment: an override can only name models the configured providers can
 * already reach, which `verify` checks before anything is saved.
 *
 * Readers call `svc.models.get()` (sync, cached). The process that saved the change refreshes at once;
 * other processes poll the row every few seconds, so a change reaches workers within that window.
 * A stage that is already running keeps the model it resolved when it started.
 */
import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import type { Logger } from "../log.js";

export interface ModelIds {
  language: string;
  transcription: string;
  /** cut-boundary re-alignment; defaults to `transcription` */
  align: string;
}
export type ModelKind = keyof ModelIds;
export const MODEL_KINDS: ModelKind[] = ["language", "transcription", "align"];

/** What is stored: only the kinds the admin changed. */
export type ModelOverride = Partial<Record<ModelKind, string>>;

export interface ModelsState {
  /** what runs now */
  current: ModelIds;
  /** from the environment */
  env: ModelIds;
  /** saved by an admin; {} when the environment is in charge */
  override: ModelOverride;
  updatedAt: string | null;
  updatedBy: string | null;
  /** an override that failed verification at load time is ignored, and this says why */
  ignored: Partial<Record<ModelKind, string>>;
}

export interface ModelSettings {
  get(): ModelIds;
  state(): ModelsState;
  /** Re-read the stored override (every process does this on a timer). */
  refresh(): Promise<ModelsState>;
  /**
   * Save a new override (verified first, all-or-nothing) and apply it here at once. `patch` keys set
   * to null fall back to the environment; an empty result removes the row.
   */
  set(patch: Partial<Record<ModelKind, string | null>>, actor: { id: string; email: string }): Promise<ModelsState>;
  stop(): void;
}

const KEY = "models";

export function envModels(config: Pick<Config, "AI_MODEL" | "TRANSCRIPTION_MODEL" | "TRANSCRIPT_ALIGN_MODEL">): ModelIds {
  return { language: config.AI_MODEL, transcription: config.TRANSCRIPTION_MODEL, align: config.TRANSCRIPT_ALIGN_MODEL ?? config.TRANSCRIPTION_MODEL };
}

/** Apply an override on top of the environment; `align` follows an overridden transcription unless set itself. */
export function resolveModels(env: ModelIds, override: ModelOverride, envAlignSet: boolean): ModelIds {
  const transcription = override.transcription ?? env.transcription;
  const align = override.align ?? (envAlignSet ? env.align : transcription);
  return { language: override.language ?? env.language, transcription, align };
}

export function parseOverride(value: unknown): ModelOverride {
  const out: ModelOverride = {};
  if (!value || typeof value !== "object") return out;
  for (const k of MODEL_KINDS) {
    const v = (value as Record<string, unknown>)[k];
    if (typeof v === "string" && v.includes(":")) out[k] = v;
  }
  return out;
}

export function createModelSettings(
  config: Config,
  log: Logger,
  /** static check that a model id resolves to a configured provider (ai/registry.ts `verify`) */
  verify: (kind: "language" | "transcription", id: string) => Promise<void>,
  opts: { pollMs?: number } = {},
): ModelSettings & { attach(db: Db): Promise<ModelsState> } {
  const env = envModels(config);
  const envAlignSet = !!config.TRANSCRIPT_ALIGN_MODEL;
  let db: Db | undefined;
  let st: ModelsState = { current: env, env, override: {}, updatedAt: null, updatedBy: null, ignored: {} };
  /** the stored value last examined, so a poll verifies only when the row changed */
  let lastStored = "";
  let timer: NodeJS.Timeout | undefined;

  async function verifyAll(override: ModelOverride): Promise<Partial<Record<ModelKind, string>>> {
    const bad: Partial<Record<ModelKind, string>> = {};
    for (const k of MODEL_KINDS) {
      const id = override[k];
      if (!id) continue;
      try {
        await verify(k === "language" ? "language" : "transcription", id);
      } catch (err) {
        bad[k] = (err as Error).message;
      }
    }
    return bad;
  }

  async function load(): Promise<ModelsState> {
    if (!db) return st;
    const row = await db.query.instanceSettings.findFirst({ where: eq(schema.instanceSettings.key, KEY) });
    const stored = parseOverride(row?.value);
    const key = JSON.stringify(stored);
    const changed = key !== lastStored;
    // verify only when the stored value differs from what we already applied (or rejected)
    const ignored = changed ? await verifyAll(stored) : st.ignored;
    lastStored = key;
    const override: ModelOverride = {};
    for (const k of MODEL_KINDS) if (stored[k] && !ignored[k]) override[k] = stored[k];
    const next: ModelsState = { current: resolveModels(env, override, envAlignSet), env, override, updatedAt: row?.updatedAt?.toISOString() ?? null, updatedBy: row?.updatedBy ?? null, ignored: { ...ignored } };
    if (changed) {
      if (JSON.stringify(next.current) !== JSON.stringify(st.current)) log.info({ models: next.current, override }, "models changed");
      for (const k of MODEL_KINDS) if (ignored[k]) log.warn({ kind: k, model: stored[k], reason: ignored[k] }, "stored model override ignored; using the environment");
    }
    st = next;
    return st;
  }

  return {
    get: () => st.current,
    state: () => st,
    refresh: load,
    async attach(database) {
      db = database;
      const s = await load();
      const pollMs = opts.pollMs ?? 5000;
      if (pollMs > 0) {
        timer = setInterval(() => void load().catch((err) => log.warn({ err }, "models refresh failed")), pollMs);
        timer.unref();
      }
      return s;
    },
    async set(patch, actor) {
      if (!db) throw new Error("not attached to the database yet");
      const stored = parseOverride((await db.query.instanceSettings.findFirst({ where: eq(schema.instanceSettings.key, KEY) }))?.value);
      const next: ModelOverride = { ...stored };
      for (const k of MODEL_KINDS) {
        const v = patch[k];
        if (v === undefined) continue;
        if (v === null || v === env[k]) delete next[k];
        else next[k] = v;
      }
      const bad = await verifyAll(next);
      const problems = MODEL_KINDS.filter((k) => bad[k]).map((k) => `${k}: ${bad[k]}`);
      if (problems.length) throw new Error(problems.join("\n"));
      const from = st.current;
      await db.transaction(async (tx) => {
        if (Object.keys(next).length) {
          await tx
            .insert(schema.instanceSettings)
            .values({ key: KEY, value: next, updatedBy: actor.email })
            .onConflictDoUpdate({ target: schema.instanceSettings.key, set: { value: next, updatedBy: actor.email, updatedAt: new Date() } });
        } else {
          await tx.delete(schema.instanceSettings).where(eq(schema.instanceSettings.key, KEY));
        }
        await tx.insert(schema.adminEvents).values({ type: "models.changed", actorId: actor.id, userId: actor.id, email: actor.email, payload: { from, to: resolveModels(env, next, envAlignSet), override: next } });
      });
      lastStored = "";
      return load();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
