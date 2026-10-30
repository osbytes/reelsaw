/**
 * Where each AI provider's credentials come from. The environment (OPENAI_API_KEY, OPENAI_BASE_URL,
 * …) is the default; an admin can enter a key or a base URL in Settings → Models, which is stored
 * encrypted in `provider_settings` (ai/crypto.ts) and overrides the environment for that provider.
 * Keys never go back to the browser: the UI sees "set here · …ab12" or "from .env".
 *
 * Like ai/models.ts, every process polls the table so a key saved through the API reaches workers
 * within seconds; `version()` lets the model registry rebuild its provider instances when anything
 * changed.
 */
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { schema } from "../db/index.js";
import type { Logger } from "../log.js";
import { createSecretBox } from "./crypto.js";

export interface ProviderCredentials {
  apiKey?: string;
  baseUrl?: string;
}

export interface ProviderDescriptor {
  provider: string;
  title: string;
  /** env var(s) that carry the key; empty = no key needed (self-hosted servers) */
  keyEnv: string[];
  /** env var that carries the base URL; present only for providers that can be self-hosted */
  baseUrlEnv?: string;
  /** what the key looks like, for the UI placeholder */
  keyHint?: string;
  docsUrl?: string;
}

export interface ProviderState extends ProviderDescriptor {
  /** a usable key is known (env or stored) */
  hasKey: boolean;
  keySource: "env" | "db" | null;
  /** last characters of the stored key */
  keyLast4: string | null;
  baseUrl: string | null;
  baseUrlSource: "env" | "db" | null;
  /** a stored key could not be decrypted (BETTER_AUTH_SECRET changed): ignored until re-entered */
  unreadable: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ProviderSettings {
  /** The descriptors, in the order the UI lists them (self-hosted first). */
  describe(): ProviderDescriptor[];
  /** Credentials in force for `provider` (stored over environment). */
  get(provider: string): ProviderCredentials;
  /** Bumps whenever credentials change, so cached provider instances are rebuilt. */
  version(): number;
  state(): ProviderState[];
  refresh(): Promise<void>;
  /** Store a key and/or base URL (null clears that field; a row with nothing left is deleted). */
  set(provider: string, patch: { apiKey?: string | null | undefined; baseUrl?: string | null | undefined }, actor: { id: string; email: string }): Promise<void>;
  stop(): void;
}

export function providerDescriptors(config: Pick<Config, "OPENAI_COMPATIBLE_NAME">): ProviderDescriptor[] {
  return [
    { provider: config.OPENAI_COMPATIBLE_NAME, title: "Ollama / OpenAI-compatible server", keyEnv: [], baseUrlEnv: "OPENAI_COMPATIBLE_BASE_URL", docsUrl: "https://ollama.com/library" },
    { provider: "openai", title: "OpenAI", keyEnv: ["OPENAI_API_KEY"], baseUrlEnv: "OPENAI_BASE_URL", keyHint: "sk-…", docsUrl: "https://platform.openai.com/api-keys" },
    { provider: "anthropic", title: "Anthropic", keyEnv: ["ANTHROPIC_API_KEY"], keyHint: "sk-ant-…", docsUrl: "https://console.anthropic.com/settings/keys" },
    { provider: "google", title: "Google", keyEnv: ["GOOGLE_GENERATIVE_AI_API_KEY"], keyHint: "AIza…", docsUrl: "https://aistudio.google.com/app/apikey" },
    { provider: "groq", title: "Groq", keyEnv: ["GROQ_API_KEY"], keyHint: "gsk_…", docsUrl: "https://console.groq.com/keys" },
    { provider: "gateway", title: "Vercel AI Gateway", keyEnv: ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"], keyHint: "vck_…", docsUrl: "https://vercel.com/ai-gateway" },
    { provider: "deepgram", title: "Deepgram", keyEnv: ["DEEPGRAM_API_KEY"], docsUrl: "https://console.deepgram.com/" },
    { provider: "assemblyai", title: "AssemblyAI", keyEnv: ["ASSEMBLYAI_API_KEY"], docsUrl: "https://www.assemblyai.com/app" },
  ];
}

/** Environment-only credentials (the eval runner and tests use this; the app layers the database on top). */
export function envCredentials(config: Config, provider: string): ProviderCredentials {
  const d = providerDescriptors(config).find((p) => p.provider === provider);
  if (!d) return {};
  const apiKey = provider === config.OPENAI_COMPATIBLE_NAME ? config.OPENAI_COMPATIBLE_API_KEY : d.keyEnv.map((k) => (config as unknown as Record<string, string | undefined>)[k] ?? process.env[k]).find(Boolean);
  const baseUrl = provider === "openai" ? config.OPENAI_BASE_URL : provider === config.OPENAI_COMPATIBLE_NAME ? config.OPENAI_COMPATIBLE_BASE_URL : undefined;
  return { ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) };
}

export function createProviderSettings(config: Config, log: Logger, opts: { pollMs?: number } = {}): ProviderSettings & { attach(db: Db): Promise<void> } {
  const box = createSecretBox(config.BETTER_AUTH_SECRET);
  const descriptors = providerDescriptors(config);
  let db: Db | undefined;
  let rows = new Map<string, { apiKey?: string; baseUrl?: string; last4: string | null; unreadable: boolean; updatedAt: Date; updatedBy: string | null }>();
  let ver = 0;
  let lastSeen = "";
  let timer: NodeJS.Timeout | undefined;

  async function load() {
    if (!db) return;
    const all = await db.query.providerSettings.findMany();
    const seen = JSON.stringify(all.map((r) => [r.provider, r.apiKeyEnc, r.baseUrl, r.updatedAt]));
    if (seen === lastSeen) return;
    lastSeen = seen;
    const next = new Map<string, (typeof rows extends Map<string, infer V> ? V : never)>();
    for (const r of all) {
      let apiKey: string | undefined;
      let unreadable = false;
      if (r.apiKeyEnc) {
        try {
          apiKey = box.decrypt(r.apiKeyEnc);
        } catch {
          unreadable = true;
          log.warn({ provider: r.provider }, "stored API key cannot be decrypted (BETTER_AUTH_SECRET changed?); using the environment until it is entered again");
        }
      }
      next.set(r.provider, { ...(apiKey ? { apiKey } : {}), ...(r.baseUrl ? { baseUrl: r.baseUrl } : {}), last4: r.apiKeyHint, unreadable, updatedAt: r.updatedAt, updatedBy: r.updatedBy });
    }
    rows = next;
    ver++;
    log.info({ providers: [...rows.keys()] }, "provider credentials loaded");
  }

  return {
    describe: () => descriptors,
    get(provider) {
      const env = envCredentials(config, provider);
      const row = rows.get(provider);
      return { ...env, ...(row?.apiKey ? { apiKey: row.apiKey } : {}), ...(row?.baseUrl ? { baseUrl: row.baseUrl } : {}) };
    },
    version: () => ver,
    state() {
      return descriptors.map((d) => {
        const env = envCredentials(config, d.provider);
        const row = rows.get(d.provider);
        const keySource = row?.apiKey ? "db" : env.apiKey ? "env" : null;
        return {
          ...d,
          hasKey: !!(row?.apiKey ?? env.apiKey),
          keySource,
          keyLast4: row?.apiKey ? row.last4 : null,
          baseUrl: row?.baseUrl ?? env.baseUrl ?? null,
          baseUrlSource: row?.baseUrl ? "db" : env.baseUrl ? "env" : null,
          unreadable: !!row?.unreadable,
          updatedAt: row?.updatedAt?.toISOString() ?? null,
          updatedBy: row?.updatedBy ?? null,
        };
      });
    },
    refresh: load,
    async attach(database) {
      db = database;
      await load();
      const pollMs = opts.pollMs ?? 5000;
      if (pollMs > 0) {
        timer = setInterval(() => void load().catch((err) => log.warn({ err }, "provider credentials refresh failed")), pollMs);
        timer.unref();
      }
    },
    async set(provider, patch, actor) {
      if (!db) throw new Error("not attached to the database yet");
      if (!descriptors.some((d) => d.provider === provider)) throw new Error(`unknown provider "${provider}"`);
      const { eq } = await import("drizzle-orm");
      const existing = await db.query.providerSettings.findFirst({ where: eq(schema.providerSettings.provider, provider) });
      const apiKeyEnc = patch.apiKey === undefined ? (existing?.apiKeyEnc ?? null) : patch.apiKey ? box.encrypt(patch.apiKey) : null;
      const apiKeyHint = patch.apiKey === undefined ? (existing?.apiKeyHint ?? null) : patch.apiKey ? patch.apiKey.slice(-4) : null;
      const baseUrl = patch.baseUrl === undefined ? (existing?.baseUrl ?? null) : patch.baseUrl ? patch.baseUrl.replace(/\/+$/, "") : null;
      await db.transaction(async (tx) => {
        if (apiKeyEnc || baseUrl) {
          await tx
            .insert(schema.providerSettings)
            .values({ provider, apiKeyEnc, apiKeyHint, baseUrl, updatedBy: actor.email })
            .onConflictDoUpdate({ target: schema.providerSettings.provider, set: { apiKeyEnc, apiKeyHint, baseUrl, updatedBy: actor.email, updatedAt: new Date() } });
        } else {
          await tx.delete(schema.providerSettings).where(eq(schema.providerSettings.provider, provider));
        }
        await tx.insert(schema.adminEvents).values({ type: "provider.changed", actorId: actor.id, userId: actor.id, email: actor.email, payload: { provider, key: patch.apiKey === undefined ? "kept" : patch.apiKey ? "set" : "cleared", baseUrl: patch.baseUrl === undefined ? "kept" : (baseUrl ?? "cleared") } });
      });
      lastSeen = "";
      await load();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
