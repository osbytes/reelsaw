import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { createProviderRegistry, customProvider, type LanguageModel, type TranscriptionModel } from "ai";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";

/**
 * Models are addressed as "<provider>:<model>" and the two roles are independent, e.g.
 *   AI_MODEL=anthropic:claude-sonnet-4-5   TRANSCRIPTION_MODEL=deepgram:nova-3
 * Language: openai, anthropic, google, groq, gateway, <compat>   Transcription: openai, groq, deepgram, assemblyai, gateway
 */
export interface AiService {
  languageModel(id?: string): Promise<LanguageModel>;
  transcriptionModel(id?: string): Promise<TranscriptionModel>;
  /** Provider-specific options that request word-level timestamps for a transcription model id. */
  transcriptionOptions(id?: string): Record<string, Record<string, unknown>>;
  /** Static validation of configured models + required keys. No network calls. */
  check(): Promise<void>;
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

export function createAi(config: Config, log: Logger, middleware?: LanguageModelMiddleware | null): AiService {
  type Registry = ReturnType<typeof createProviderRegistry<Record<string, any>, ":">>;
  let registry: Promise<Registry> | undefined;

  // Provider packages are imported lazily: their default instances read env at import time.
  async function build(): Promise<Registry> {
    const [{ createOpenAI }, { anthropic }, { google }, { groq }, { deepgram }, { assemblyai }, { gateway }] = await Promise.all([
      import("@ai-sdk/openai"),
      import("@ai-sdk/anthropic"),
      import("@ai-sdk/google"),
      import("@ai-sdk/groq"),
      import("@ai-sdk/deepgram"),
      import("@ai-sdk/assemblyai"),
      import("@ai-sdk/gateway"),
    ]);
    const openai = createOpenAI({
      ...(config.OPENAI_API_KEY ? { apiKey: config.OPENAI_API_KEY } : {}),
      ...(config.OPENAI_BASE_URL ? { baseURL: config.OPENAI_BASE_URL } : {}),
    });
    // OpenAI itself prefers the Responses API; OpenAI-compatible servers (Ollama, vLLM, LM Studio,
    // Speaches…) usually only implement Chat Completions, so default to chat when a base URL is set.
    const mode = config.OPENAI_API_MODE ?? (config.OPENAI_BASE_URL ? "chat" : "responses");
    const openaiProvider =
      mode === "chat"
        ? customProvider({
            fallbackProvider: openai,
            // customProvider does `modelId in languageModels`, so the proxy must answer `has` as well
            languageModels: new Proxy({} as Record<string, LanguageModel>, { has: () => true, get: (_t, id: string) => openai.chat(id) }),
          })
        : openai;
    const providers: Record<string, any> = { openai: openaiProvider, anthropic, google, groq, deepgram, assemblyai, gateway };
    if (config.OPENAI_COMPATIBLE_BASE_URL) {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      providers[config.OPENAI_COMPATIBLE_NAME] = createOpenAICompatible({
        name: config.OPENAI_COMPATIBLE_NAME,
        baseURL: config.OPENAI_COMPATIBLE_BASE_URL,
        apiKey: config.OPENAI_COMPATIBLE_API_KEY ?? "none",
        // send response_format json_schema (Ollama, vLLM, LM Studio all support it); without this the
        // schema is silently dropped and small models answer in whatever shape they like
        supportsStructuredOutputs: config.OPENAI_COMPATIBLE_STRUCTURED_OUTPUTS,
      });
    }
    return createProviderRegistry(providers);
  }
  const reg = () => (registry ??= build());

  async function resolve(kind: "language" | "transcription", id: string) {
    const provider = providerOf(id);
    const modelId = id.slice(provider.length + 1);
    if (!provider || !modelId) throw new Error(`"${id}" must look like provider:model (e.g. openai:gpt-4o-mini)`);
    const r = await reg();
    try {
      return kind === "language" ? r.languageModel(id as `${string}:${string}`) : r.transcriptionModel(id as `${string}:${string}`);
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      const known = Object.keys(providerKeyEnv).concat(config.OPENAI_COMPATIBLE_BASE_URL ? [config.OPENAI_COMPATIBLE_NAME] : []);
      if (/No such provider/i.test(msg)) throw new Error(`unknown provider "${provider}" in "${id}". Known providers: ${known.join(", ")}`);
      if (kind === "transcription")
        throw new Error(`provider "${provider}" has no transcription models ("${id}"). Use e.g. openai:whisper-1, deepgram:nova-3, assemblyai:best, groq:whisper-large-v3-turbo. (${msg})`);
      throw new Error(`cannot resolve ${kind} model "${id}": ${msg}`);
    }
  }

  function requireKeys(id: string) {
    const keys = providerKeyEnv[providerOf(id)];
    if (keys && !keys.some((k) => process.env[k])) throw new Error(`"${id}" needs ${keys.join(" or ")} to be set`);
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
    const baseURL = provider === "openai" ? config.OPENAI_BASE_URL : provider === config.OPENAI_COMPATIBLE_NAME ? config.OPENAI_COMPATIBLE_BASE_URL : undefined;
    if (!baseURL) return;
    const base = baseURL.replace(/\/+$/, "");
    const apiKey = provider === "openai" ? config.OPENAI_API_KEY : config.OPENAI_COMPATIBLE_API_KEY;
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

  return {
    languageModel: async (id = config.AI_MODEL) => {
      const model = (await resolve("language", id)) as Exclude<LanguageModel, string>;
      // LLM_TRACE capture (logs / Langfuse) wraps every model handed out
      return middleware ? (wrapLanguageModel({ model: model as Parameters<typeof wrapLanguageModel>[0]["model"], middleware }) as LanguageModel) : model;
    },
    transcriptionModel: async (id = config.TRANSCRIPTION_MODEL) => (await resolve("transcription", id)) as TranscriptionModel,
    transcriptionOptions: (id = config.TRANSCRIPTION_MODEL) => {
      const p = providerOf(id);
      return { [p]: wordTimestampOptions[p] ?? {} };
    },
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
