/**
 * Instance settings an admin changes at runtime: who may sign up, email verification, captcha,
 * legal links, quotas, upload limits, refine-stage gates (name fixes, disfluency, scenes),
 * retention, the stall watchdog, the update check and whether /api/health shows machine numbers.
 * One precedence chain (README, "Settings and precedence"): the environment (config.ts) is the
 * default; a value stored in `instance_settings` (key `runtime`) overrides it; `null` in a patch
 * removes the override and the environment applies again. Every process polls the row like
 * ai/models.ts, so a change made through the API reaches workers within seconds and no restart is
 * needed. The captcha secret is encrypted at rest with the same box as provider keys (ai/crypto.ts)
 * and never leaves the server; the UI sees whether it is set.
 *
 * Settings → System, the `settings` CLI command and the get/set_instance_settings MCP tools all go
 * through `set()` here, so validation, cross-checks and the audit event are the same everywhere.
 * Machine-level configuration (ports, database, storage, models on disk, OAuth) stays in `.env`:
 * it is read once at boot and changing it needs a restart anyway.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Config } from "./config.js";
import { schema, type Db } from "./db/index.js";
import type { Logger } from "./log.js";
import { createSecretBox } from "./ai/crypto.js";

export const SETTING_GROUPS = [
  ["access", "Access"],
  ["limits", "Limits"],
  ["pipeline", "Pipeline"],
  ["retention", "Retention"],
  ["library", "Library"],
  ["operations", "Operations"],
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number][0];

interface Def<S extends z.ZodTypeAny = z.ZodTypeAny> {
  group: SettingGroup;
  schema: S;
  /** one or two sentences for the UI, the tools and the docs */
  help: string;
  /** `""` means "none"; the effective value is then undefined (TERMS_URL unset) */
  optional?: true;
  /** encrypted at rest, masked everywhere outside the server */
  secret?: true;
}
const def = <S extends z.ZodTypeAny>(group: SettingGroup, schema: S, help: string, extra: Partial<Pick<Def, "optional" | "secret">> = {}): Def<S> => ({ group, schema, help, ...extra });

const int0 = z.number().int().min(0);
const url = z.string().trim().url().max(500).or(z.literal(""));
const days = (what: string) => `${what} 0 = keep forever.`;

export const RUNTIME_SETTINGS = {
  SIGNUP_MODE: def("access", z.enum(["open", "approval", "closed"]), "Who may sign up: open (anyone, right for a public instance with email confirmation), approval (new accounts wait for an admin; a private box) or closed (nobody). The first account is always the admin."),
  REQUIRE_EMAIL_VERIFICATION: def("access", z.boolean(), "New users must click the verification link before they can sign in. The link works for 24 hours and is single-use; an expired one offers a new send. Needs an email driver in .env."),
  CAPTCHA_PROVIDER: def("access", z.enum(["cloudflare-turnstile", "google-recaptcha", "hcaptcha"]).or(z.literal("")), "Bot protection on sign-up, sign-in and password reset: cloudflare-turnstile, google-recaptcha or hcaptcha; empty = off. Needs both keys.", { optional: true }),
  CAPTCHA_SITE_KEY: def("access", z.string().trim().max(200), "Public captcha key the browser widget uses; empty = unset.", { optional: true }),
  CAPTCHA_SECRET_KEY: def("access", z.string().trim().max(200), "Secret captcha key the server verifies with; stored encrypted, never shown again; empty = unset.", { optional: true, secret: true }),
  MAX_SIGNUPS_PER_IP_PER_DAY: def("access", int0, "Accounts one network address may create per day. 0 = unlimited. Needs TRUST_PROXY behind a reverse proxy."),
  BLOCK_DISPOSABLE_EMAILS: def("access", z.boolean(), "Refuse sign-ups from known temporary-address domains (a vendored list of about 120k domains)."),
  TERMS_URL: def("access", url, "Terms of service link shown on the sign-up form; empty = none.", { optional: true }),
  PRIVACY_URL: def("access", url, "Privacy policy link shown on the sign-up form; empty = none.", { optional: true }),

  MAX_PROJECTS_PER_USER: def("limits", int0, "Projects an account may keep. 0 = unlimited. Admins can override per user on the Users page."),
  MAX_SOURCE_MINUTES_PER_DAY: def("limits", int0, "Minutes of source video an account may add per day (UTC). 0 = unlimited."),
  MAX_NEW_PROJECTS_PER_HOUR: def("limits", int0, "Projects an account may create per hour. 0 = unlimited."),
  MAX_LIVE_JOBS_PER_USER: def("limits", int0, "Queued plus running jobs an account's own requests may add to. 0 = unlimited."),
  MAX_RERENDERS_PER_HOUR: def("limits", int0, "Re-renders, hand-made clips and re-runs (re-analyze, refine) an account may ask for per hour. 0 = unlimited."),
  MAX_STORAGE_MB: def("limits", int0, "MB of sources, uploads, renders and intros/outros an account may keep (deleted items count until they are deleted forever). 0 = unlimited."),
  MAX_SOURCE_MINUTES_PER_MONTH: def("limits", int0, "Minutes of source video an account may add per period: its billing period when it has a plan, else the calendar month (UTC). 0 = unlimited."),
  WATERMARK_NON_ADMINS: def("limits", z.boolean(), "Burn a small watermark into the clips of accounts that are not admins. A paid plan removes it, and an admin can switch it per user on the Users page."),
  WATERMARK_TEXT: def("limits", z.string().trim().min(1).max(60), "The watermark text, e.g. your site name."),
  MAX_REQUESTS_PER_MINUTE: def("limits", int0, "Changes (API mutations, MCP tool calls) an account may make per minute. 0 = unlimited. Admins can override per user on the Users page."),
  MAX_REQUESTS_PER_HOUR: def("limits", int0, "Changes an account may make per hour. 0 = unlimited."),
  MAX_UPLOAD_MB: def("limits", z.number().int().min(1).max(1_000_000), "Largest accepted file upload, in MB."),
  MAX_SOURCE_FILE_MB: def("limits", z.number().int().min(1).max(1_000_000), "Largest file a link source may download (yt-dlp --max-filesize), in MB."),
  ALLOW_PRIVATE_SOURCE_URLS: def("limits", z.boolean(), "Let link sources point at LAN or loopback hosts (a NAS). Off, they are blocked (SSRF guard)."),

  TRANSCRIPT_CORRECTION: def("pipeline", z.boolean(), "After transcription, fix misheard names with the language model. On by default; off closes the ceiling so no project runs it (projects opt out via refineEntities)."),
  DISFLUENCY_REMOVAL: def("pipeline", z.boolean(), "Detect fillers, repetitions and false starts after transcription. Off by default; turn on so projects may opt in via refineDisfluency."),
  DISFLUENCY_LLM: def("pipeline", z.boolean(), "Model pass on top of rule-based disfluency detection. Off by default. Ignored when disfluency removal is off. Turn on so projects may opt in via disfluencyLlm."),
  LLM_CALL_TIMEOUT_SECONDS: def("pipeline", z.number().int().min(0).max(86_400), "Longest one model call may take (all its HTTP attempts together) before its step is stopped and retried. 0 = auto: 120 s for a hosted model, 600 s for a self-hosted one. A slow CPU-only model may need more."),
  STAGE_IDLE_TIMEOUT_MINUTES: def("pipeline", z.number().int().min(0).max(1440), "A stage made of checkpointed steps (finding moments) is stopped when no step has finished for this long; Retry continues where it stopped. 0 = auto: 1.5 times the model call timeout."),
  REFINE_SCENES: def("pipeline", z.boolean(),"Scan the video for on-screen text (burned-in captions, watermarks, slides) during refine. On by default; off closes the ceiling (projects opt out via refineScenes). Shot cuts are always detected."),

  SOURCE_RETENTION_DAYS: def("retention", int0, days("Delete stored source videos this many days after upload; the project stays and Retry re-fetches.")),
  CLIP_RETENTION_DAYS: def("retention", int0, days("Delete rendered clip files this many days after rendering; the clip stays and can be re-rendered.")),
  DELETED_RETENTION_DAYS: def("retention", int0, days("Deleted projects and replaced clips stay restorable this long, then rows and files go.")),
  SCRATCH_CACHE_HOURS: def("retention", int0, "With an S3 store, drop a worker's local copies of the sources and rendered clips of finished projects after this many idle hours; a job pulls them back from the bucket when it needs them, and a worker short of disk drops the least recently used ones first. 0 = keep them on the worker. The local store needs nothing: scratch and store are the same file."),
  EVENT_RETENTION_DAYS: def("retention", int0, days("Prune project events older than this; each project keeps its run skeleton.")),
  LLM_USAGE_RETENTION_DAYS: def("retention", int0, days("Prune model and transcription usage rows older than this.")),
  ADMIN_EVENT_RETENTION_DAYS: def("retention", int0, days("Prune the admin event log after this many days.")),
  DECISION_RETENTION_DAYS: def("retention", int0, days("Prune users' recorded decisions (accepts, rejects, edits Reelsaw learns from) older than this. They outlive deleted projects until then.")),
  STEP_RETENTION_DAYS: def("retention", int0, days("Drop the saved checkpoints (finding-moments windows) of a finished project this many days after it last changed; a Retry sooner than that reuses them.")),

  STALL_MINUTES: def("operations", z.number().int().min(2).max(1440), "A running job with no progress for this long is reported as stalled (log and UI)."),
  UPDATE_CHECK: def("operations", z.boolean(), "Ask GitHub for the latest release and tell admins when a newer Reelsaw exists. Only the request leaves the machine."),
  HEALTH_DETAILS: def("operations", z.boolean(), "Include machine numbers in GET /api/health for anonymous callers (private networks only). Admins always get them."),

  CATALOG_URL: def("library", z.string().trim().url().max(500), "Where the Reelsaw catalog manifest (sounds, icons, stickers) is fetched from, hourly; the starter pack bundled with Reelsaw is used until a newer one arrives."),
  PEXELS_API_KEY: def("library", z.string().trim().max(200), "Pexels API key (free): enables stock photos and portrait videos in Browse. Stored encrypted; empty = provider hidden.", { optional: true, secret: true }),
  PIXABAY_API_KEY: def("library", z.string().trim().max(200), "Pixabay API key (free): enables photos, illustrations, vectors and videos in Browse. Stored encrypted; empty = provider hidden.", { optional: true, secret: true }),
  FREESOUND_API_KEY: def("library", z.string().trim().max(200), "Freesound API key (free): enables sound effects in Browse. Stored encrypted; empty = provider hidden.", { optional: true, secret: true }),
  GIPHY_API_KEY: def("library", z.string().trim().max(200), "Giphy API key: enables GIFs and stickers in Browse. Stored encrypted; empty = provider hidden.", { optional: true, secret: true }),
  KLIPY_API_KEY: def("library", z.string().trim().max(200), "Klipy API key: enables GIF search in Browse (experimental). Stored encrypted; empty = provider hidden.", { optional: true, secret: true }),
  ICONIFY_API_URL: def("library", z.string().trim().url().max(500), "Iconify API used for icon search; the public one by default, or your own self-hosted instance (https)."),
  OPENVERSE_ENABLED: def("library", z.boolean(), "Show Openverse (Creative Commons images and audio, no key) in Browse. Off by default until you have checked its limits for your use."),
} satisfies Record<string, Def>;

export type RuntimeKey = keyof typeof RUNTIME_SETTINGS;
export const RUNTIME_KEYS = Object.keys(RUNTIME_SETTINGS) as RuntimeKey[];
/** The settings in force, typed like the environment they default from. */
export type RuntimeSettings = Pick<Config, RuntimeKey>;
export type SettingsPatch = { [K in RuntimeKey]?: z.infer<(typeof RUNTIME_SETTINGS)[K]["schema"]> | null };

/** A patch as the API takes it: each key optional; null = back to the environment. Descriptions double as tool docs. */
export const settingsPatchSchema = z.object(Object.fromEntries(RUNTIME_KEYS.map((k) => [k, RUNTIME_SETTINGS[k].schema.nullable().optional().describe(RUNTIME_SETTINGS[k].help)])) as { [K in RuntimeKey]: z.ZodOptional<z.ZodNullable<(typeof RUNTIME_SETTINGS)[K]["schema"]>> });

export const isSecret = (k: RuntimeKey) => !!(RUNTIME_SETTINGS[k] as Def).secret;
export const isOptional = (k: RuntimeKey) => !!(RUNTIME_SETTINGS[k] as Def).optional;

/** A reason the value cannot be used as asked; the message is a sentence for the admin. */
export class SettingsError extends Error {}

type Actor = { id: string; email: string };
/** What leaves the server: effective values with the secret masked to "…abcd" / null. */
export type MaskedValues = Record<RuntimeKey, unknown>;

export interface SettingsState {
  /** in force now (environment or override), secrets masked */
  values: MaskedValues;
  /** the environment's values, secrets masked */
  env: MaskedValues;
  /** stored overrides that apply, secrets masked */
  override: Partial<MaskedValues>;
  source: Record<RuntimeKey, "env" | "db">;
  /** stored but not applied, with the reason (an override that lost its precondition, an unreadable secret) */
  ignored: Partial<Record<RuntimeKey, string>>;
  groups: Array<{ id: SettingGroup; title: string; keys: RuntimeKey[] }>;
  help: Record<RuntimeKey, string>;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface InstanceSettings {
  /** The settings in force now; cheap, read it at the point of use (never cache the result at boot). */
  get(): RuntimeSettings;
  state(): SettingsState;
  /** Validate, store, write the admin event, apply. Throws SettingsError with a sentence. */
  set(patch: SettingsPatch, actor: Actor): Promise<SettingsState>;
  /** Called after the effective settings changed (from a set here or in another process). */
  subscribe(fn: (s: RuntimeSettings) => void): () => void;
  refresh(): Promise<void>;
  attach(db: Db): Promise<void>;
  stop(): void;
}

type Override = Partial<Record<RuntimeKey, unknown>>;
const KEY = "runtime";

/** Validate one value (API input) against its schema; returns the parsed value or throws a sentence. */
export function parseValue(k: RuntimeKey, v: unknown): unknown {
  const r = RUNTIME_SETTINGS[k].schema.safeParse(v);
  if (!r.success) throw new SettingsError(`${k}: ${r.error.issues[0]?.message ?? "invalid value"}`);
  return r.data;
}

/** Environment values for the runtime keys. */
export function envValues(config: Config): RuntimeSettings {
  return Object.fromEntries(RUNTIME_KEYS.map((k) => [k, config[k]])) as RuntimeSettings;
}

/** Environment plus the override, with "" for optional keys becoming undefined. */
export function resolveSettings(config: Config, override: Override): RuntimeSettings {
  const out: Record<string, unknown> = { ...envValues(config) };
  for (const k of RUNTIME_KEYS) {
    if (!(k in override)) continue;
    const v = override[k];
    out[k] = isOptional(k) && v === "" ? undefined : v;
  }
  return out as RuntimeSettings;
}

/**
 * Preconditions between settings, checked on the effective result (a stored override can lose its
 * precondition when .env changes). Keyed by the setting that has to give.
 */
export function problemsOf(s: RuntimeSettings, deps: { emailEnabled: boolean }): Partial<Record<RuntimeKey, string>> {
  const out: Partial<Record<RuntimeKey, string>> = {};
  if (s.REQUIRE_EMAIL_VERIFICATION && !deps.emailEnabled) out.REQUIRE_EMAIL_VERIFICATION = "Email verification needs an email driver: set EMAIL_DRIVER in .env first.";
  if (s.CAPTCHA_PROVIDER && (!s.CAPTCHA_SITE_KEY || !s.CAPTCHA_SECRET_KEY)) out.CAPTCHA_PROVIDER = "A captcha provider needs both the site key and the secret key.";
  return out;
}

const mask = (k: RuntimeKey, v: unknown): unknown => (isSecret(k) ? (typeof v === "string" && v ? `…${v.slice(-4)}` : null) : v === undefined ? null : v);
const maskAll = (vals: Record<string, unknown>): MaskedValues => Object.fromEntries(RUNTIME_KEYS.map((k) => [k, mask(k, vals[k])])) as MaskedValues;

export function createInstanceSettings(config: Config, log: Logger, deps: { emailEnabled: boolean; pollMs?: number }): InstanceSettings {
  const box = createSecretBox(config.BETTER_AUTH_SECRET, "instance-settings");
  const env = envValues(config);
  let db: Db | undefined;
  let stored: Override = {}; // every readable stored override
  let applied: Override = {}; // the ones in force
  let ignored: Partial<Record<RuntimeKey, string>> = {};
  let current: RuntimeSettings = { ...env };
  let meta: { updatedAt: Date | null; updatedBy: string | null } = { updatedAt: null, updatedBy: null };
  let lastSeen = "";
  let timer: NodeJS.Timeout | undefined;
  const subscribers = new Set<(s: RuntimeSettings) => void>();

  /** Stored shape: plain values, secrets as { enc, last4 }. */
  function decode(value: Record<string, unknown> | undefined): { override: Override; unreadable: RuntimeKey[] } {
    const override: Override = {};
    const unreadable: RuntimeKey[] = [];
    for (const k of RUNTIME_KEYS) {
      if (!value || !(k in value)) continue;
      const raw = value[k];
      if (isSecret(k)) {
        const enc = (raw as { enc?: unknown } | null)?.enc;
        if (typeof enc !== "string") continue;
        try {
          override[k] = box.decrypt(enc);
        } catch {
          unreadable.push(k);
        }
        continue;
      }
      const r = RUNTIME_SETTINGS[k].schema.safeParse(raw);
      if (r.success) override[k] = r.data;
    }
    return { override, unreadable };
  }
  function encode(override: Override): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of RUNTIME_KEYS) {
      if (!(k in override)) continue;
      const v = override[k];
      out[k] = isSecret(k) && typeof v === "string" ? { enc: box.encrypt(v), last4: v.slice(-4) } : v;
    }
    return out;
  }

  function apply(next: Override, unreadable: RuntimeKey[], row: { updatedAt: Date; updatedBy: string | null } | undefined) {
    const ign: Partial<Record<RuntimeKey, string>> = {};
    for (const k of unreadable) ign[k] = "The stored value cannot be decrypted (BETTER_AUTH_SECRET changed?). Enter it again.";
    // drop overrides whose precondition fails, one at a time, until the result is consistent
    const use: Override = { ...next };
    for (let i = 0; i < RUNTIME_KEYS.length; i++) {
      const problems = problemsOf(resolveSettings(config, use), deps);
      const bad = (Object.keys(problems) as RuntimeKey[]).find((k) => k in use);
      if (!bad) break;
      ign[bad] = `${problems[bad]} The environment's value applies.`;
      delete use[bad];
    }
    const before = JSON.stringify(current);
    stored = next;
    applied = use;
    ignored = ign;
    current = resolveSettings(config, use);
    meta = { updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedBy ?? null };
    if (JSON.stringify(current) !== before) for (const fn of subscribers) fn(current);
  }

  async function load() {
    if (!db) return;
    const row = await db.query.instanceSettings.findFirst({ where: eq(schema.instanceSettings.key, KEY) });
    const seen = JSON.stringify([row?.value ?? null, row?.updatedAt ?? null]);
    if (seen === lastSeen) return;
    lastSeen = seen;
    const { override, unreadable } = decode(row?.value);
    apply(override, unreadable, row);
    const keys = Object.keys(applied) as RuntimeKey[];
    log.info({ keys, by: meta.updatedBy }, keys.length ? "instance settings override in force" : "instance settings: environment only");
    for (const [k, reason] of Object.entries(ignored)) log.warn({ key: k, reason }, "stored instance setting ignored");
  }

  const state = (): SettingsState => ({
    values: maskAll(current as Record<string, unknown>),
    env: maskAll(env as Record<string, unknown>),
    override: Object.fromEntries((Object.keys(applied) as RuntimeKey[]).map((k) => [k, mask(k, applied[k])])),
    source: Object.fromEntries(RUNTIME_KEYS.map((k) => [k, k in applied ? "db" : "env"])) as SettingsState["source"],
    ignored: { ...ignored },
    groups: SETTING_GROUPS.map(([id, title]) => ({ id, title, keys: RUNTIME_KEYS.filter((k) => RUNTIME_SETTINGS[k].group === id) })),
    help: Object.fromEntries(RUNTIME_KEYS.map((k) => [k, RUNTIME_SETTINGS[k].help])) as Record<RuntimeKey, string>,
    updatedAt: meta.updatedAt?.toISOString() ?? null,
    updatedBy: meta.updatedBy,
  });

  return {
    get: () => current,
    state,
    subscribe(fn) {
      subscribers.add(fn);
      return () => void subscribers.delete(fn);
    },
    refresh: load,
    async attach(database) {
      db = database;
      await load();
      const pollMs = deps.pollMs ?? 5000;
      if (pollMs > 0) {
        timer = setInterval(() => void load().catch((err) => log.warn({ err }, "instance settings refresh failed")), pollMs);
        timer.unref();
      }
    },
    async set(patch, actor) {
      if (!db) throw new Error("not attached to the database yet");
      const row = await db.query.instanceSettings.findFirst({ where: eq(schema.instanceSettings.key, KEY) });
      const next: Override = decode(row?.value).override;
      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of RUNTIME_KEYS) {
        if (!(k in patch)) continue;
        const v = patch[k];
        if (v === undefined) continue;
        const from = k in next ? next[k] : env[k];
        if (v === null) {
          if (!(k in next)) continue;
          delete next[k];
        } else {
          const parsed = parseValue(k, v);
          if (parsed === from) continue;
          // the environment's own value is not an override
          if (parsed === env[k] || (isOptional(k) && parsed === "" && env[k] === undefined)) delete next[k];
          else next[k] = parsed;
        }
        const to = k in next ? next[k] : env[k];
        changed[k] = isSecret(k) ? { from: from ? "set" : "unset", to: to ? "set" : "unset" } : { from: from ?? null, to: to ?? null };
      }
      if (!Object.keys(changed).length) throw new SettingsError("Nothing to change");
      const problems = problemsOf(resolveSettings(config, next), deps);
      const messages = Object.values(problems);
      if (messages.length) throw new SettingsError(messages.join(" "));
      const value = encode(next);
      await db.transaction(async (tx) => {
        if (Object.keys(value).length) {
          await tx
            .insert(schema.instanceSettings)
            .values({ key: KEY, value, updatedBy: actor.email })
            .onConflictDoUpdate({ target: schema.instanceSettings.key, set: { value, updatedBy: actor.email, updatedAt: new Date() } });
        } else {
          await tx.delete(schema.instanceSettings).where(eq(schema.instanceSettings.key, KEY));
        }
        await tx.insert(schema.adminEvents).values({ type: "settings.changed", actorId: actor.id, userId: actor.id, email: actor.email, payload: { changed } });
      });
      log.info({ keys: Object.keys(changed), by: actor.email }, "instance settings changed");
      lastSeen = "";
      await load();
      return state();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
