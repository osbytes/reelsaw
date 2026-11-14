import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { createProviderRegistry, customProvider, type LanguageModel, type TranscriptionModel } from "ai";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import type { ProviderGate } from "./gate.js";
import { isStale, memoryVerdictStore, probeWordTimestamps, verdictKey, type VerdictStore, type WordTimestampVerdict } from "./word-timestamps.js";

/**
 * Models are addressed as "<provider>:<model>" and the two roles are independent, e.g.
 *   AI_MODEL=anthropic:claude-sonnet-4-5   TRANSCRIPTION_MODEL=deepgram:nova-3
 * Language: openai, anthropic, google, groq, gateway, <compat>   Transcription: openai, groq, deepgram, assemblyai, gateway, <compat>
 */
export interface AiService {
  languageModel(id?: string): Promise<LanguageModel>;
  transcriptionModel(id?: string): Promise<TranscriptionModel>;
  /**
   * Provider-specific options that request word-level timestamps for a transcription model id,
   * keyed by `transcriptionOptionsKey`.
   */
  transcriptionOptions(id?: string): Record<string, Record<string, unknown>>;
  /**
   * The `providerOptions` key the transcription model reads: the vendor for direct and gateway models
   * (`underlyingProvider`), "openai" for the compatible provider, which speaks OpenAI's
   * `/audio/transcriptions` whatever the model id says ("openrouter:deepgram/nova-3" included).
   */
  transcriptionOptionsKey(id?: string): string;
  /** Static validation of configured models + required keys, and for a self-hosted server a `GET /models` reachability and installed-model check (see `verify`). */
  check(effective?: { language: string; transcription: string }): Promise<void>;
  /**
   * Can `id` run here? Resolves it against the configured providers, checks the vendor's key is set
   * and, for a self-hosted server, that it is reachable and has the model installed (Speaches pulls
   * missing models itself). A transcription model must also return word timestamps, which a short
   * test transcription decides (ai/word-timestamps.ts); `fresh` repeats that test instead of using
   * the stored verdict. Throws a sentence that says what to do.
   */
  verify(kind: "language" | "transcription", id: string, opts?: { fresh?: boolean }): Promise<void>;
  /** The stored word-timestamp verdict for a transcription model, if it was tested (model picker notes). */
  wordTimestampVerdict(id: string): Promise<WordTimestampVerdict | undefined>;
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
      const apiKey = compat
        ? config.OPENAI_COMPATIBLE_API_KEY
        : (providerKeyEnv[provider] ?? []).map((k) => (config as unknown as Record<string, string | undefined>)[k] ?? process.env[k]).find(Boolean);
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

/**
 * How to ask each API for word timestamps. These are request options, not claims that a model
 * honours them: whether it does is tested (ai/word-timestamps.ts).
 */
const wordTimestampOptions: Record<string, Record<string, unknown>> = {
  openai: { timestampGranularities: ["word"] },
  groq: { timestampGranularities: ["word", "segment"], responseFormat: "verbose_json" },
  deepgram: { smartFormat: true, punctuate: true },
  assemblyai: {},
};

/**
 * Compatible servers answer `/audio/transcriptions` in OpenAI's shape only roughly, and two gaps
 * break the AI SDK's OpenAI transcription model:
 *  - it takes `segments` over `words` when both are present, so a server that always adds segments
 *    (OpenRouter's verbose_json) would hand the pipeline phrases instead of the words it asked for;
 *  - it validates segments against OpenAI's full whisper shape (id, seek, tokens, avg_logprob…), and
 *    OpenRouter's segments carry only start, end, text (and speaker), so the whole answer is rejected.
 * So for the compatible provider: words win when present, and bare segments get OpenAI's remaining
 * fields as neutral values. Anything else passes through untouched.
 */
export async function compatTranscriptionFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!res.ok || !/\/audio\/transcriptions(\?|$)/.test(url) || !/json/i.test(res.headers.get("content-type") ?? "")) return res;
  const body = (await res
    .clone()
    .json()
    .catch(() => undefined)) as { words?: unknown[]; segments?: Array<Record<string, unknown>> } | undefined;
  if (!body || !Array.isArray(body.segments)) return res;
  if (Array.isArray(body.words) && body.words.length) delete body.segments;
  else
    body.segments = body.segments.map((s, i) =>
      "tokens" in s || "type" in s
        ? s
        : { id: i, seek: 0, tokens: [], temperature: 0, avg_logprob: 0, compression_ratio: 0, no_speech_prob: 0, ...s, text: String(s.text ?? "") },
    );
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(JSON.stringify(body), { status: res.status, statusText: res.statusText, headers });
}

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
  transformParams: async ({ params }) => ({
    ...params,
    providerOptions: { ...params.providerOptions, openai: { strictJsonSchema: false, ...(params.providerOptions?.openai ?? {}) } },
  }),
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
  /** word-timestamp verdicts (ai/word-timestamps.ts); shared through the database in the app, per process otherwise */
  verdicts: VerdictStore = memoryVerdictStore(),
): AiService {
  type Registry = ReturnType<typeof createProviderRegistry<Record<string, any>, ":">>;
  let registry: { version: number; value: Promise<Registry> } | undefined;
  const compat = config.OPENAI_COMPATIBLE_NAME;

  // Provider packages are imported lazily: their default instances read env at import time. Instances
  // are built from the credentials in force and rebuilt when those change (an admin saved a key).
  async function build(): Promise<Registry> {
    const [{ createOpenAI }, { createAnthropic }, { createGoogle }, { createGroq }, { createDeepgram }, { createAssemblyAI }, { createGateway }] =
      await Promise.all([
        import("@ai-sdk/openai"),
        import("@ai-sdk/anthropic"),
        import("@ai-sdk/google"),
        import("@ai-sdk/groq"),
        import("@ai-sdk/deepgram"),
        import("@ai-sdk/assemblyai"),
        import("@ai-sdk/gateway"),
      ]);
    const c = (p: string) => credentials.get(p);
    const key = (p: string) => {
      const apiKey = c(p).apiKey;
      return apiKey ? { apiKey } : {};
    };
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
      const chat = createOpenAICompatible({
        name: compat,
        baseURL: compatCreds.baseUrl,
        apiKey: compatCreds.apiKey ?? "none",
        // send response_format json_schema (Ollama, vLLM, LM Studio all support it); without this the
        // schema is silently dropped and small models answer in whatever shape they like
        supportsStructuredOutputs: config.OPENAI_COMPATIBLE_STRUCTURED_OUTPUTS,
      });
      // @ai-sdk/openai-compatible has no transcription models, but OpenAI's multipart
      // /audio/transcriptions is what compatible servers implement (OpenRouter, Speaches, vLLM, LocalAI),
      // so speech goes through the OpenAI provider pointed at the same server. Its options are read
      // under the "openai" key (transcriptionOptionsKey).
      const speech = createOpenAI({ name: compat, baseURL: compatCreds.baseUrl, apiKey: compatCreds.apiKey ?? "none", fetch: compatTranscriptionFetch });
      providers[compat] = customProvider({
        fallbackProvider: chat,
        // customProvider does `modelId in transcriptionModels`, so the proxy must answer `has` as well
        transcriptionModels: new Proxy({} as Record<string, TranscriptionModel>, { has: () => true, get: (_t, id: string) => speech.transcription(id) }),
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
        if (provider === compat)
          throw new Error(`"${id}" needs a base URL for the ${compat} server (OPENAI_COMPATIBLE_BASE_URL, or enter it under Settings → Models)`);
        throw new Error(`unknown provider "${provider}" in "${id}". Known providers: ${known.join(", ")}`);
      }
      if (kind === "transcription")
        throw new Error(
          `provider "${provider}" has no transcription models ("${id}"). Use e.g. openai:whisper-1, deepgram:nova-3, assemblyai:best, groq:whisper-large-v3-turbo. (${msg})`,
        );
      throw new Error(`cannot resolve ${kind} model "${id}": ${msg}`);
    }
  }

  function requireKeys(id: string) {
    const provider = providerOf(id);
    const keys = providerKeyEnv[provider];
    // a self-hosted OpenAI-compatible server needs no key
    if (provider === "openai" && credentials.get("openai").baseUrl) return;
    if (keys && !credentials.get(provider).apiKey)
      throw new Error(`"${id}" needs an API key for ${provider}: enter one under Settings → Models, or set ${keys.join(" or ")}`);
  }

  /**
   * Self-hosted OpenAI-compatible servers (Ollama, Speaches, vLLM…) are reachable from here, so verify
   * them at boot: server answers `GET /models`, and the model is installed. Speaches exposes a registry
   * and can download on demand, so missing whisper models are pulled automatically; Ollama models must
   * be pulled by the operator, which the error says.
   */
  async function checkSelfHosted(kind: "language" | "transcription", id: string) {
    const provider = providerOf(id);
    const modelId = id.slice(provider.length + 1);
    if (provider !== "openai" && provider !== compat) return;
    const { baseUrl: baseURL, apiKey } = credentials.get(provider);
    if (!baseURL) return;
    const base = baseURL.replace(/\/+$/, "");
    // admin-entered URLs may carry user:pass@; only the redacted form is ever logged or put in an error
    const shown = redactUrl(base);
    const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const get = async (path: string) => {
      try {
        return await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
      } catch (err) {
        throw new Error(`cannot reach ${shown} (${(err as Error).message}). Is the server running and the URL correct from inside this container?`);
      }
    };
    const res = await get("/models");
    if (!res.ok) throw new Error(`${shown}/models returned HTTP ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id: string }> };
    const installed = (body.data ?? []).map((m) => m.id);
    if (installed.includes(modelId)) return;
    if (kind === "transcription") {
      // OpenRouter lists only text models in a plain /models; speech models need the modality filter.
      // Servers without the filter ignore the parameter and answer the same list.
      const speech = await get("/models?output_modalities=transcription").catch(() => undefined);
      const ids = speech?.ok ? (((await speech.json().catch(() => ({}))) as { data?: Array<{ id: string }> }).data ?? []).map((m) => m.id) : [];
      if (ids.includes(modelId)) return;
    }

    // Speaches: pull from its registry on demand
    const reg = await get(`/registry?task=automatic-speech-recognition`).catch(() => undefined);
    if (reg?.ok) {
      // Speaches answers the POST only once the files are in its cache and reports no progress meanwhile, so
      // boot (and the HTTP port) waits here for minutes on a first install; a heartbeat says the wait is this
      log.info(
        { model: modelId, server: shown, timeoutMin: 15 },
        "transcription model not installed; downloading it via POST /models (first boot only; hundreds of MB to GBs, the app answers once it is done)",
      );
      const started = Date.now();
      const elapsedSec = () => Math.round((Date.now() - started) / 1000);
      const heartbeat = setInterval(
        () =>
          log.info({ model: modelId, server: shown, elapsedSec: elapsedSec() }, "still downloading the transcription model; boot continues when it finishes"),
        20_000,
      );
      try {
        const dl = await fetch(`${base}/models/${encodeURIComponent(modelId)}`, { method: "POST", headers, signal: AbortSignal.timeout(15 * 60_000) }).catch(
          (err) => {
            throw new Error(`download of ${modelId} from ${shown} failed after ${elapsedSec()}s: ${(err as Error).message}`);
          },
        );
        if (!dl.ok && dl.status !== 409)
          throw new Error(`download of ${modelId} from ${shown} failed after ${elapsedSec()}s: HTTP ${dl.status} ${await dl.text().catch(() => "")}`);
        log.info({ model: modelId, server: shown, elapsedSec: elapsedSec(), status: dl.status }, "transcription model downloaded");
      } finally {
        clearInterval(heartbeat);
      }
      return;
    }
    const hint = /11434/.test(shown) ? ` Run: ollama pull ${modelId}` : "";
    throw new Error(`model "${modelId}" is not installed on ${shown}. Installed: ${installed.join(", ") || "(none)"}.${hint}`);
  }

  const optionsKey = (id: string) => (providerOf(id) === compat ? "openai" : underlyingProvider(id));
  const transcriptionOptions = (id: string) => {
    const k = optionsKey(id);
    return { [k]: { ...(wordTimestampOptions[k] ?? {}) } };
  };
  const keyOf = (id: string) => {
    const baseUrl = credentials.get(providerOf(id)).baseUrl;
    return verdictKey(id, baseUrl ? redactUrl(baseUrl) : undefined);
  };
  /** one test transcription per model at a time, however many callers ask (boot check, settings poll, Test) */
  const probing = new Map<string, Promise<WordTimestampVerdict>>();

  /** Word timestamps are tested, not looked up: see ai/word-timestamps.ts for why and what would let this go. */
  async function checkWordTimestamps(id: string, fresh: boolean) {
    const key = keyOf(id);
    let v = fresh ? undefined : await verdicts.get(key);
    if (!v || isStale(v)) {
      let p = probing.get(key);
      if (!p) {
        p = (async () => {
          const model = (await resolve("transcription", id)) as TranscriptionModel;
          const verdict = await probeWordTimestamps(model, transcriptionOptions(id)).catch((err) => {
            throw new Error(`"${id}" failed a test transcription: ${(err as Error).message}`);
          });
          await verdicts.set(key, verdict);
          log.info(
            { model: id, wordLevel: verdict.wordLevel, segments: verdict.segments, heard: verdict.text },
            "transcription model tested for word timestamps",
          );
          return verdict;
        })().finally(() => probing.delete(key));
        probing.set(key, p);
      }
      v = await p;
    }
    if (!v.wordLevel)
      throw new Error(
        `"${id}" does not return word timestamps, which cuts and captions need: a test clip came back as ${v.segments} segment(s) ("${v.text}"). Pick another transcription model; Settings → Models shows which ones passed.`,
      );
  }

  async function verify(kind: "language" | "transcription", id: string, opts: { fresh?: boolean } = {}) {
    await resolve(kind, id);
    requireKeys(id);
    await checkSelfHosted(kind, id);
    if (kind === "transcription") await checkWordTimestamps(id, !!opts.fresh);
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
    transcriptionOptions: (id = current().transcription) => transcriptionOptions(id),
    transcriptionOptionsKey: (id = current().transcription) => optionsKey(id),
    verify,
    wordTimestampVerdict: (id) => verdicts.get(keyOf(id)),
    /**
     * Boot check of the models that will actually run (the environment's, or the admin override that
     * `models.attach` loaded). Same rules as `verify`, so a model that cannot work fails here, not at
     * the first job.
     */
    async check(effective: { language: string; transcription: string } = { language: config.AI_MODEL, transcription: config.TRANSCRIPTION_MODEL }) {
      const errors: string[] = [];
      for (const [label, kind, id] of [
        [labelOf(config.AI_MODEL, effective.language, "AI_MODEL", "language model"), "language", effective.language],
        [labelOf(config.TRANSCRIPTION_MODEL, effective.transcription, "TRANSCRIPTION_MODEL", "transcription model"), "transcription", effective.transcription],
        ...(config.ANALYZE_JUDGE_MODEL ? ([["ANALYZE_JUDGE_MODEL", "language", config.ANALYZE_JUDGE_MODEL]] as const) : []),
      ] as const) {
        try {
          await verify(kind, id);
        } catch (err) {
          errors.push(`${label}: ${(err as Error).message}`);
        }
      }
      if (errors.length) throw new Error(errors.join("\n"));
    },
  };
}

/** Label for an error: the env var when the environment's model is in force, else say it is an admin override. */
function labelOf(envId: string, effective: string, envVar: string, what: string) {
  return envId === effective ? envVar : `admin-selected ${what} (${effective})`;
}

/** A URL safe to log: userinfo (user:pass@) removed. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return raw.replace(/\/\/[^/@]*@/, "//");
  }
}
