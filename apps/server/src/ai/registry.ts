import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { createProviderRegistry, customProvider, type LanguageModel, type TranscriptionModel } from "ai";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import type { ProviderGate } from "./gate.js";

/**
 * Models are addressed as "<provider>:<model>" and the two roles are independent, e.g.
 *   AI_MODEL=anthropic:claude-sonnet-4-5   TRANSCRIPTION_MODEL=deepgram:nova-3
 * Language: openai, anthropic, google, groq, gateway, <compat>   Transcription: openai, groq, deepgram, assemblyai, gateway
 */
export interface AiService {
  languageModel(id?: string): Promise<LanguageModel>;
  transcriptionModel(id?: string): Promise<TranscriptionModel>;
  /**
   * Provider-specific options that request word-level timestamps for a transcription model id,
   * keyed by the vendor the options belong to (see `underlyingProvider`).
   */
  transcriptionOptions(id?: string): Record<string, Record<string, unknown>>;
  /** Static validation of configured models + required keys. No network calls. */
  check(): Promise<void>;
  /**
   * Can `id` run here? Resolves it against the configured providers, checks the vendor's key is set
   * and, for a self-hosted server, that it is reachable and has the model installed (Speaches pulls
   * missing whisper models itself). Throws a sentence that says what to do.
   */
  verify(kind: "language" | "transcription", id: string): Promise<void>;
}

/** Transcription models known to return word timestamps, which the pipeline needs; others fail at "no words". */
export function supportsWordTimestamps(id: string): boolean {
  const vendor = underlyingProvider(id);
  const model = id.slice(providerOf(id).length + 1).replace(/^[^/]+\//, "");
  if (vendor === "openai") return /whisper/i.test(model); // whisper-1 and Speaches' faster-whisper-*; gpt-4o-transcribe gives segments only
  return ["groq", "deepgram", "assemblyai"].includes(vendor);
}

/** Keys and base URLs in force, and a version that changes when they do (ai/providers.ts). */
export interface CredentialSource {
  get(provider: string): { apiKey?: string; baseUrl?: string };
  version(): number;
}

/** The environment only: what the eval runner and tests use. */
export function envCredentialSource(config: Config): CredentialSource {
  return {
    get(provider) {
      const compat = provider === config.OPENAI_COMPATIBLE_NAME;
      const apiKey = compat ? config.OPENAI_COMPATIBLE_API_KEY : (providerKeyEnv[provider] ?? []).map((k) => (config as unknown as Record<string, string | undefined>)[k] ?? process.env[k]).find(Boolean);
      const baseUrl = provider === "openai" ? config.OPENAI_BASE_URL : compat ? config.OPENAI_COMPATIBLE_BASE_URL : undefined;
      return { ...(apiKey ? { apiKey } : {}), ...(baseUrl ? { baseUrl } : {}) };
    },
    version: () => 0,
  };
}

/** Env var(s) that must be present for each built-in provider (compat/custom providers need none). */
export const providerKeyEnv: Record<string, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  deepgram: ["DEEPGRAM_API_KEY"],
  assemblyai: ["ASSEMBLYAI_API_KEY"],
  gateway: ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"],
};

const wordTimestampOptions: Record<string, Record<string, unknown>> = {
  openai: { timestampGranularities: ["word"] },
  groq: { timestampGranularities: ["word", "segment"], responseFormat: "verbose_json" },
  deepgram: { smartFormat: true, punctuate: true },
  assemblyai: {},
};

export function providerOf(id: string): string {
  return id.split(":")[0]!;
}

/**
 * The vendor whose options a model understands. Direct providers are themselves; through the
 * Vercel AI Gateway the model id carries the vendor ("gateway:openai/whisper-1" → "openai"), and
 * the gateway forwards `providerOptions.<vendor>` unchanged. Microsoft models are served via Azure.
 */
export function underlyingProvider(id: string): string {
  const provider = providerOf(id);
  if (provider !== "gateway") return provider;
  const vendor = id.slice(provider.length + 1).split("/")[0] ?? "";
  return vendor === "microsoft" ? "azure" : vendor;
}

/**
 * OpenAI's strict structured outputs (the AI SDK default, also what the AI Gateway forwards) reject
 * any schema with a non-required property, and ours have some on purpose (`caption` defaults to "",
 * `confidence` / `relevance` are optional so weaker models can omit them). Ask for the lenient
 * json_schema mode instead: the model still gets the schema, the pipeline keeps its own salvage
 * and validation. Other providers ignore the option.
 */
const lenientJsonSchema: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({ ...params, providerOptions: { ...params.providerOptions, openai: { strictJsonSchema: false, ...(params.providerOptions?.openai ?? {}) } } }),
};

export function createAi(
  config: Config,
  log: Logger,
  middleware?: LanguageModelMiddleware | null,
  /** the models in force now (ai/models.ts); the environment when not given */
  current: () => { language: string; transcription: string } = () => ({ language: config.AI_MODEL, transcription: config.TRANSCRIPTION_MODEL }),
  /** where keys and base URLs come from (ai/providers.ts); the environment when not given */
  credentials: CredentialSource = envCredentialSource(config),
  /** per-provider concurrency gate (ai/gate.ts); none in evals and tests */
  gate?: ProviderGate | null,
): AiService {
  type Registry = ReturnType<typeof createProviderRegistry<Record<string, any>, ":">>;
  let registry: { version: number; value: Promise<Registry> } | undefined;
  const compat = config.OPENAI_COMPATIBLE_NAME;

  // Provider packages are imported lazily: their default instances read env at import time. Instances
  // are built from the credentials in force and rebuilt when those change (an admin saved a key).
  async function build(): Promise<Registry> {
    const [{ createOpenAI }, { createAnthropic }, { createGoogle }, { createGroq }, { createDeepgram }, { createAssemblyAI }, { createGateway }] = await Promise.all([
      import("@ai-sdk/openai"),
      import("@ai-sdk/anthropic"),
      import("@ai-sdk/google"),
      import("@ai-sdk/groq"),
      import("@ai-sdk/deepgram"),
      import("@ai-sdk/assemblyai"),
      import("@ai-sdk/gateway"),
    ]);
    const c = (p: string) => credentials.get(p);
    const key = (p: string) => (c(p).apiKey ? { apiKey: c(p).apiKey } : {});
    const openaiCreds = c("openai");
    const openai = createOpenAI({ ...key("openai"), ...(openaiCreds.baseUrl ? { baseURL: openaiCreds.baseUrl } : {}) });
    // OpenAI itself prefers the Responses API; OpenAI-compatible servers (Ollama, vLLM, LM Studio,
    // Speaches…) usually only implement Chat Completions, so default to chat when a base URL is set.
    const mode = config.OPENAI_API_MODE ?? (openaiCreds.baseUrl ? "chat" : "responses");
    const openaiProvider =
      mode === "chat"
        ? customProvider({
            fallbackProvider: openai,
            // customProvider does `modelId in languageModels`, so the proxy must answer `has` as well
            languageModels: new Proxy({} as Record<string, LanguageModel>, { has: () => true, get: (_t, id: string) => openai.chat(id) }),
          })
        : openai;
    const providers: Record<string, any> = {
      openai: openaiProvider,
      anthropic: createAnthropic(key("anthropic")),
      google: createGoogle(key("google")),
      groq: createGroq(key("groq")),
      deepgram: createDeepgram(key("deepgram")),
      assemblyai: createAssemblyAI(key("assemblyai")),
      gateway: createGateway(key("gateway")),
    };
    const compatCreds = c(compat);
    if (compatCreds.baseUrl) {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      providers[compat] = createOpenAICompatible({
        name: compat,
        baseURL: compatCreds.baseUrl,
        apiKey: compatCreds.apiKey ?? "none",
        // send response_format json_schema (Ollama, vLLM, LM Studio all support it); without this the
        // schema is silently dropped and small models answer in whatever shape they like
        supportsStructuredOutputs: config.OPENAI_COMPATIBLE_STRUCTURED_OUTPUTS,
      });
    }
    return createProviderRegistry(providers);
  }
  const reg = () => {
    const version = credentials.version();
    if (!registry || registry.version !== version) registry = { version, value: build() };
    return registry.value;
  };

  async function resolve(kind: "language" | "transcription", id: string) {
    const provider = providerOf(id);
    const modelId = id.slice(provider.length + 1);
    if (!provider || !modelId) throw new Error(`"${id}" must look like provider:model (e.g. openai:gpt-4o-mini)`);
    const r = await reg();
    try {
      return kind === "language" ? r.languageModel(id as `${string}:${string}`) : r.transcriptionModel(id as `${string}:${string}`);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      const known = Object.keys(providerKeyEnv).concat(credentials.get(compat).baseUrl ? [compat] : []);
      if (/No such provider/i.test(msg)) {
        if (provider === compat) throw new Error(`"${id}" needs a base URL for the ${compat} server (OPENAI_COMPATIBLE_BASE_URL, or enter it under Settings → Models)`);
        throw new Error(`unknown provider "${provider}" in "${id}". Known providers: ${known.join(", ")}`);
      }
      if (kind === "transcription")
        throw new Error(`provider "${provider}" has no transcription models ("${id}"). Use e.g. openai:whisper-1, deepgram:nova-3, assemblyai:best, groq:whisper-large-v3-turbo. (${msg})`);
      throw new Error(`cannot resolve ${kind} model "${id}": ${msg}`);
    }
  }

  function requireKeys(id: string) {
    const provider = providerOf(id);
    const keys = providerKeyEnv[provider];
    // a self-hosted OpenAI-compatible server needs no key
    if (provider === "openai" && credentials.get("openai").baseUrl) return;
    if (keys && !credentials.get(provider).apiKey) throw new Error(`"${id}" needs an API key for ${provider}: enter one under Settings → Models, or set ${keys.join(" or ")}`);
  }

  /**
   * Self-hosted OpenAI-compatible servers (Ollama, Speaches, vLLM…) are reachable from here, so verify
   * them at boot: server answers `GET /models`, and the model is installed. Speaches exposes a registry
   * and can download on demand, so missing whisper models are pulled automatically; Ollama models must
   * be pulled by the operator, which the error says.
   */
  async function checkSelfHosted(id: string) {
    const provider = providerOf(id);
    const modelId = id.slice(provider.length + 1);
    if (provider !== "openai" && provider !== compat) return;
    const { baseUrl: baseURL, apiKey } = credentials.get(provider);
    if (!baseURL) return;
    const base = baseURL.replace(/\/+$/, "");
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : undefined;
    const get = async (path: string) => {
      try {
        return await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
      } catch (err) {
        throw new Error(`cannot reach ${base} (${(err as Error).message}). Is the server running and the URL correct from inside this container?`);
      }
    };
    const res = await get("/models");
    if (!res.ok) throw new Error(`${base}/models returned HTTP ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id: string }> };
    const installed = (body.data ?? []).map((m) => m.id);
    if (installed.includes(modelId)) return;

    // Speaches: pull from its registry on demand
    const reg = await get(`/registry?task=automatic-speech-recognition`).catch(() => undefined);
    if (reg?.ok) {
      log.info({ model: modelId, server: base }, "transcription model not installed; downloading via POST /models (first boot only)");
      const dl = await fetch(`${base}/models/${modelId}`, { method: "POST", headers, signal: AbortSignal.timeout(15 * 60_000) }).catch((err) => {
        throw new Error(`download of ${modelId} from ${base} failed: ${(err as Error).message}`);
      });
      if (!dl.ok && dl.status !== 409) throw new Error(`download of ${modelId} from ${base} failed: HTTP ${dl.status} ${await dl.text().catch(() => "")}`);
      return;
    }
    const hint = /11434/.test(base) ? ` Run: ollama pull ${modelId}` : "";
    throw new Error(`model "${modelId}" is not installed on ${base}. Installed: ${installed.join(", ") || "(none)"}.${hint}`);
  }

  async function verify(kind: "language" | "transcription", id: string) {
    await resolve(kind, id);
    requireKeys(id);
    if (kind === "transcription" && !supportsWordTimestamps(id)) throw new Error(`"${id}" does not return word timestamps, which cuts and captions need. Use whisper-1 (also through the gateway), a Speaches faster-whisper model, deepgram:nova-3, assemblyai:best or groq:whisper-large-v3-turbo.`);
    await checkSelfHosted(id);
  }

  return {
    languageModel: async (id = current().language) => {
      const model = (await resolve("language", id)) as Exclude<LanguageModel, string>;
      // every model handed out: lenient OpenAI schemas, then LLM_TRACE capture (logs / Langfuse) when on
      const chain = middleware ? [lenientJsonSchema, middleware] : [lenientJsonSchema];
      // the provider gate goes outermost, so a call's traced latency doesn't include its wait for a slot
      if (gate) chain.unshift(gate.middleware(providerOf(id)));
      return wrapLanguageModel({ model: model as Parameters<typeof wrapLanguageModel>[0]["model"], middleware: chain }) as LanguageModel;
    },
    transcriptionModel: async (id = current().transcription) => (await resolve("transcription", id)) as TranscriptionModel,
    transcriptionOptions: (id = current().transcription) => {
      const p = underlyingProvider(id);
      return { [p]: wordTimestampOptions[p] ?? {} };
    },
    verify,
    async check() {
      const errors: string[] = [];
      for (const [label, kind, id] of [
        ["AI_MODEL", "language", config.AI_MODEL],
        ["TRANSCRIPTION_MODEL", "transcription", config.TRANSCRIPTION_MODEL],
      ] as const) {
        try {
          await resolve(kind, id);
          requireKeys(id);
          await checkSelfHosted(id);
        } catch (err) {
          errors.push(`${label}: ${(err as Error).message}`);
        }
      }
      if (errors.length) throw new Error(errors.join("\n"));
    },
  };
}
