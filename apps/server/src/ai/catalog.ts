/**
 * What models each configured provider offers, for the admin's model picker (Settings → Models), and
 * downloads onto self-hosted servers (Ollama `/api/pull`, Speaches `POST /v1/models/{id}`) with progress.
 *
 * Only providers whose key or base URL is in the environment answer with a live list; the rest are
 * shown as unavailable with the variable to set. Listings are cached for a few minutes per provider
 * and leave this module a page at a time (`page`): a Speaches registry alone lists hundreds of models.
 * Keys never leave this module: listings carry model ids, names, sizes and prices.
 */
import { objectKeys } from "ts-extras";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import { providerKeyEnv, envCredentialSource, type CredentialSource } from "./registry.js";
import { OPENCODE_PLANS, opencodeUserAgent, type OpenCodePlan } from "./opencode.js";
import { aliasesOf, credentialOwner, OPENCODE_DEFAULT_BASE_URL } from "./provider-ids.js";
import type { WordTimestampVerdict } from "./word-timestamps.js";
import { anthropicRetirement, expirationRetirement, gatewayRetirement, listsExpiration, openAiRetirement, type ModelRetirement } from "./retirement.js";
import { createFuzzy, formatBytes, formatNumber } from "@reelsaw/shared";
// `get` here is the module's own fetch helper, so lodash's is named for what it is
import { get as lodashGet, isArray, isString } from "lodash-es";
import { msg } from "@lingui/core/runtime-macro";
import { t } from "../i18n.js";

/** A model's list price per million input / output tokens, in dollars, as the model picker shows it: "$0.15 / $0.60 per 1M tokens". */
function perMillionTokens(input: number, output: number): string {
  const usd = (n: number) => formatNumber(n, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return t(msg({ id: "models.price_per_million", message: msg`${{ input: usd(input) }} / ${{ output: usd(output) }} per 1M tokens` }));
}

export type CatalogKind = "language" | "transcription";

export interface CatalogModel {
  /** full id as the pipeline uses it: "<provider>:<model>" */
  id: string;
  label: string;
  /** one short line: size, price, family */
  note?: string | undefined;
  /** self-hosted servers: present on disk (false = listed by the registry, can be pulled) */
  installed?: boolean;
  sizeBytes?: number;
  /** section within its provider (one of the provider's `groups`); models of a section stay together */
  group?: string;
  /** the provider's listing says this model is going away (ai/retirement.ts) */
  retirement?: ModelRetirement;
}

export interface CatalogProvider {
  provider: string;
  title: string;
  kind: CatalogKind;
  /** key / base URL present, so its models can run */
  available: boolean;
  /** when unavailable: what to set */
  reason?: string;
  /** "live": asked the provider; "installed": asked a self-hosted server; "static": a built-in list */
  source: "live" | "installed" | "static";
  selfHosted?: { baseUrl: string; server: "ollama" | "speaches" | "openai-compatible"; canPull: boolean };
  models: CatalogModel[];
  /** model-id prefixes this provider owns when there are several (OpenCode: `opencode`, `opencode-go`); absent = `provider` alone */
  prefixes?: string[];
  /** sections of `models`, in order, each with an optional line shown under its heading */
  groups?: Array<{ name: string; notice?: string }>;
  /** the listing failed; models may be a static fallback */
  error?: string;
  /** the listing carries retirement dates (OpenAI, Anthropic, the AI Gateway, OpenRouter-style routers); absent = it says nothing */
  lifecycle?: boolean;
}

/** One provider with one page of its models: the listing (or the matches for `q`) from `cursor`, at most `limit` long. */
export interface CatalogProviderPage extends CatalogProvider {
  /** models in the whole listing, or matches when searching */
  total: number;
  /** pass back as `cursor` (with the same provider and q) for the models after this page; null at the end */
  nextCursor: string | null;
  /** self-hosted servers: how many models are on the server, out of the whole listing */
  installedCount?: number;
}

export interface CatalogPage {
  providers: CatalogProviderPage[];
  /** the page size used, per provider */
  limit: number;
  /** the search, trimmed; null when browsing */
  q: string | null;
}

export interface CatalogPageOptions {
  /** only this provider (to page through it); unknown names are refused */
  provider?: string | undefined;
  /** fuzzy search over id, label, provider title and note; providers without a match are left out, the rest ranked by their best match */
  q?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  /** ids shown first in their provider when browsing (the models in use), so the first page always has them */
  pin?: readonly string[] | undefined;
  refresh?: boolean | undefined;
}

export const CATALOG_PAGE_DEFAULT = 50;
export const CATALOG_PAGE_MAX = 100;

export interface PullJob {
  id: string;
  provider: string;
  model: string;
  status: "running" | "done" | "failed" | "cancelled";
  /** bytes, when the server reports them (Ollama); Speaches gives no progress */
  completed: number;
  total: number;
  message: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface ModelCatalog {
  /** Every provider with its whole listing. Internal: screens, MCP and the CLI read `page`, which bounds it. */
  list(kind: CatalogKind, opts?: { refresh?: boolean | undefined }): Promise<CatalogProvider[]>;
  /**
   * Every provider (or one) with a page of its models: the picker's provider column and model list, list_models and
   * `reelsaw models`. A self-hosted Speaches server lists hundreds of downloadable models, so the listing is never
   * sent whole. Pages are offsets into the cached listing, which holds still for CACHE_MS.
   */
  page(kind: CatalogKind, opts?: CatalogPageOptions): Promise<CatalogPage>;
  /**
   * Try credentials before they are saved: list the provider's models with them. Returns how many
   * models answered per kind, or the error the provider gave (bad key, unreachable server).
   */
  probe(
    provider: string,
    creds: { apiKey?: string | undefined; baseUrl?: string | undefined },
  ): Promise<{ ok: boolean; language: number; transcription: number; error?: string }>;
  /** Start a download on a self-hosted server; one per model at a time. Returns the job to poll. */
  pull(provider: string, model: string): Promise<PullJob>;
  pulls(): PullJob[];
  cancelPull(id: string): boolean;
}

const CACHE_MS = 5 * 60_000;

/** what a model search matches on, the model's own name counting most */
const SEARCH_KEYS = [
  { name: "label", weight: 3 },
  { name: "id", weight: 2 },
  { name: "title", weight: 1 },
  { name: "note", weight: 0.5 },
];

/** self-hosted and available providers first, then the ones that need a key */
const byShown = (a: CatalogProvider, b: CatalogProvider) =>
  Number(!!b.selfHosted) - Number(!!a.selfHosted) || Number(b.available) - Number(a.available) || a.title.localeCompare(b.title);

/** Ollama models worth suggesting when the server has none of them yet (sizes are the default quantisation). */
const OLLAMA_SUGGESTIONS: Array<[string, string]> = [
  ["qwen2.5:14b", "9.0 GB · strong at JSON; what the local benchmark used"],
  ["qwen2.5:7b", "4.7 GB · faster, weaker verifier"],
  ["llama3.1:8b", "4.9 GB"],
  ["gemma3:12b", "8.1 GB"],
  ["mistral-nemo:12b", "7.1 GB"],
  ["phi4:14b", "9.1 GB"],
];

const STATIC: Record<string, Array<[string, string, CatalogKind]>> = {
  deepgram: [
    ["nova-3", "smart formatting", "transcription"],
    ["nova-2", "previous generation", "transcription"],
  ],
  assemblyai: [
    ["best", "highest accuracy", "transcription"],
    ["nano", "cheapest", "transcription"],
  ],
};

const TITLES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  groq: "Groq",
  deepgram: "Deepgram",
  assemblyai: "AssemblyAI",
  gateway: "Vercel AI Gateway",
  opencode: "OpenCode (Zen + Go)",
};

/**
 * Fallback for model lists that say nothing about what a model does (OpenAI, Groq, a plain
 * OpenAI-compatible server): guess speech-to-text from the id, so the picker can file it under
 * Transcription. Listing only: whether a model actually works here (word timestamps) is tested, never
 * guessed (ai/word-timestamps.ts), and servers that report modalities or tasks (OpenRouter, Speaches,
 * the AI Gateway) are taken at their word instead.
 */
export function looksLikeSpeechModel(id: string): boolean {
  return /whisper|transcri|speech-to-text|(^|[-_/])(stt|asr)([-_.]|$)/i.test(id);
}

/** What an OpenAI-compatible /models entry says it outputs (OpenRouter: architecture.output_modalities); undefined when it says nothing. */
function outputModalities(m: { architecture?: { output_modalities?: unknown } }): string[] | undefined {
  const o = m.architecture?.output_modalities;
  return Array.isArray(o) ? o.map(String) : undefined;
}

/** What an OpenCode /models entry says about a model; only the fields the picker reads. */
export interface OpenCodeModelEntry {
  id: string;
  name?: string;
  /** chat, decision, image, embedding, video, realtime */
  type?: string;
  /** the APIs OpenCode serves the model on natively, e.g. { "chat-completions": { base_url } } */
  api?: Record<string, unknown>;
  cost?: { text?: { input?: { price?: number }; output?: { price?: number } } };
}

/**
 * Whether Reelsaw can run an OpenCode model, decided by OpenCode's own listing, never by its name.
 * Reelsaw speaks Chat Completions to OpenCode, like to any OpenAI-compatible server. A model served
 * natively on another API (Anthropic messages, OpenAI responses, Google) reaches Chat Completions only
 * through OpenCode's translation, which loses structured output (MiniMax M3 on Go answered with its
 * reasoning in front of the JSON and ignored the schema), so it is left out. Free models (priced 0)
 * only run inside the OpenCode app ("Free-tier chat models require OpenCode").
 */
export function isUsableOpenCodeModel(m: OpenCodeModelEntry): boolean {
  if (m.type !== "chat" || !m.api || !("chat-completions" in m.api)) return false;
  const price = m.cost?.text;
  return !(price?.input?.price === 0 && price?.output?.price === 0);
}

/** The model with what its provider's listing says about retiring it, when it says anything. */
function withRetirement(m: CatalogModel, retirement: ModelRetirement | undefined): CatalogModel {
  return retirement ? { ...m, retirement } : m;
}

/** The AI Gateway's public listing: the only place it gives retirement dates (the SDK's /config drops them). */
const GATEWAY_PUBLIC_MODELS = "https://ai-gateway.vercel.sh/v1/models";

/** Keep the chat-capable OpenAI models out of a /v1/models dump that also lists TTS, embeddings, images. */
function isOpenAiLanguageModel(id: string) {
  if (!/^(gpt-|o[1-9]|chatgpt-)/.test(id)) return false;
  return !/(realtime|audio|tts|transcribe|embedding|image|search|instruct|moderation|dall-e|whisper)/.test(id);
}

export function createModelCatalog(
  config: Config,
  log: Logger,
  credentials: CredentialSource = envCredentialSource(config),
  /** the stored word-timestamp test results for transcription model ids, in one read (AiService.wordTimestampVerdicts) */
  verdictsOf: (ids: string[]) => Promise<Map<string, WordTimestampVerdict>> = async () => new Map(),
): ModelCatalog {
  const compat = config.OPENAI_COMPATIBLE_NAME;
  const cache = new Map<string, { at: number; value: CatalogProvider }>();
  const jobs = new Map<string, PullJob & { abort: AbortController }>();
  let seq = 0;

  const keyFor = (provider: string) => credentials.get(provider).apiKey;
  const missing = (provider: string) => `needs an API key: enter one here, or set ${(providerKeyEnv[provider] ?? []).join(" or ")} in .env`;
  const get = async (url: string, headers: Record<string, string> = {}, timeoutMs = 10_000) => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401 || res.status === 403) throw new Error(`the key was rejected (HTTP ${res.status})`);
    if (!res.ok) throw new Error(`${url.replace(/\?.*$/, "")} returned HTTP ${res.status}`);
    return (await res.json()) as any;
  };
  const root = (base: string) => base.replace(/\/+$/, "").replace(/\/v1$/, "");
  /**
   * Gateway model id → retirement, from the public listing. Null when it cannot be read: the gateway's models
   * still list (from the SDK), only without dates, and that is logged rather than failing the picker.
   */
  const gatewayRetirements = async (): Promise<Map<string, ModelRetirement> | null> => {
    try {
      const data: unknown = lodashGet(await get(GATEWAY_PUBLIC_MODELS), "data");
      if (!isArray(data)) throw new Error("the listing has no data array");
      const out = new Map<string, ModelRetirement>();
      for (const m of data) {
        const id: unknown = lodashGet(m, "id");
        const r = gatewayRetirement(m);
        if (isString(id) && r) out.set(id, r);
      }
      return out;
    } catch (err) {
      log.warn({ err, url: GATEWAY_PUBLIC_MODELS }, "gateway retirement dates unavailable");
      return null;
    }
  };

  async function selfHosted(provider: string, baseUrl: string, apiKey: string | undefined, kind: CatalogKind): Promise<CatalogProvider> {
    const base = baseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const out: CatalogProvider = {
      provider,
      title: provider === "openai" ? `OpenAI-compatible server (${base})` : `${compat} (${base})`,
      kind,
      available: true,
      source: "installed",
      models: [],
    };
    try {
      type Listed = { id: string; architecture?: { output_modalities?: unknown } };
      const listed = ((await get(`${base}/models`, headers)) as { data?: Listed[] }).data ?? [];
      const installed = listed.map((m) => m.id);
      // Ollama: native API has sizes and can pull
      const ollama = await get(`${root(base)}/api/tags`, headers, 5000).catch(() => null);
      if (ollama?.models) {
        out.selfHosted = { baseUrl: base, server: "ollama", canPull: true };
        if (kind === "language") {
          for (const m of ollama.models as Array<{
            name: string;
            size: number;
            details?: { parameter_size?: string; quantization_level?: string; family?: string };
          }>) {
            if (/embed/i.test(m.name)) continue;
            out.models.push({
              id: `${provider}:${m.name}`,
              label: m.name,
              installed: true,
              sizeBytes: m.size,
              note: [formatBytes(m.size), m.details?.parameter_size, m.details?.quantization_level].filter(Boolean).join(" · "),
            });
          }
          const have = new Set(out.models.map((m) => m.label.replace(/:latest$/, "")));
          for (const [name, note] of OLLAMA_SUGGESTIONS)
            if (!have.has(name) && !have.has(name.replace(/:latest$/, "")))
              out.models.push({ id: `${provider}:${name}`, label: name, installed: false, note: `${note} · not installed` });
        }
        return out;
      }
      // Speaches: a registry of downloadable speech-recognition models next to the installed ones
      const registry = await get(`${base}/registry?task=automatic-speech-recognition`, headers, 5000).catch(() => null);
      if (registry?.data) {
        out.selfHosted = { baseUrl: base, server: "speaches", canPull: true };
        if (kind === "transcription") {
          const have = new Set(installed);
          for (const id of installed) out.models.push({ id: `${provider}:${id}`, label: id, installed: true });
          for (const m of registry.data as Array<{ id: string }>)
            if (!have.has(m.id)) out.models.push({ id: `${provider}:${m.id}`, label: m.id, installed: false, note: "not installed" });
        }
        return out;
      }
      out.selfHosted = { baseUrl: base, server: "openai-compatible", canPull: false };
      // routers that describe their models (OpenRouter) list speech models only under the modality filter;
      // other servers ignore the parameter and answer the plain list again
      const speechListed =
        kind === "transcription"
          ? (((await get(`${base}/models?output_modalities=transcription`, headers).catch(() => null)) as { data?: Listed[] } | null)?.data ?? [])
          : [];
      const seen = new Set<string>();
      // OpenRouter (and routers that copy its listing) send expiration_date on every model, null when none is set
      if (listsExpiration([...speechListed, ...listed])) out.lifecycle = true;
      for (const m of [...speechListed, ...listed]) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const outputs = outputModalities(m);
        const speech = outputs ? outputs.includes("transcription") : looksLikeSpeechModel(m.id);
        if (kind === "transcription" ? speech : !speech && !/embed/i.test(m.id))
          out.models.push(withRetirement({ id: `${provider}:${m.id}`, label: m.id, installed: true }, expirationRetirement(m)));
      }
      return out;
    } catch (err) {
      out.error = `cannot list ${base}: ${(err as Error).message}`;
      return out;
    }
  }

  async function cloud(provider: string, kind: CatalogKind, override?: { apiKey?: string | undefined }): Promise<CatalogProvider> {
    const title = TITLES[provider] ?? provider;
    const apiKey = override?.apiKey ?? keyFor(provider);
    const out: CatalogProvider = { provider, title, kind, available: !!apiKey, source: "live", models: [] };
    const aliases = aliasesOf(provider);
    if (aliases.length) out.prefixes = [provider, ...aliases];
    if (!out.available) {
      out.reason = missing(provider);
      out.source = "static";
    }
    if (STATIC[provider]) {
      out.source = "static";
      for (const [id, note, k] of STATIC[provider]!) if (k === kind) out.models.push({ id: `${provider}:${id}`, label: id, note });
      return out;
    }
    if (!out.available) return out;
    const key = apiKey!;
    try {
      if (provider === "openai") {
        const data = ((await get("https://api.openai.com/v1/models", { authorization: `Bearer ${key}` })) as { data: Array<{ id: string }> }).data;
        out.lifecycle = true;
        const fits = kind === "language" ? isOpenAiLanguageModel : looksLikeSpeechModel;
        for (const m of [...data].sort((a, b) => a.id.localeCompare(b.id)))
          if (fits(m.id)) out.models.push(withRetirement({ id: `openai:${m.id}`, label: m.id }, openAiRetirement(m)));
      } else if (provider === "anthropic") {
        if (kind === "language") {
          const data = (
            (await get("https://api.anthropic.com/v1/models?limit=100", { "x-api-key": key, "anthropic-version": "2023-06-01" })) as {
              data: Array<{ id: string; display_name?: string }>;
            }
          ).data;
          out.lifecycle = true;
          for (const m of data) out.models.push(withRetirement({ id: `anthropic:${m.id}`, label: m.id, note: m.display_name }, anthropicRetirement(m)));
        }
      } else if (provider === "google") {
        if (kind === "language") {
          const data = (await get(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`)) as {
            models: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>;
          };
          for (const m of data.models ?? []) {
            if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
            const id = m.name.replace(/^models\//, "");
            if (/embedding|aqa|imagen|veo|tts|live|image/i.test(id)) continue;
            out.models.push({ id: `google:${id}`, label: id, note: m.displayName });
          }
        }
      } else if (provider === "groq") {
        const data = (
          (await get("https://api.groq.com/openai/v1/models", { authorization: `Bearer ${key}` })) as { data: Array<{ id: string; owned_by?: string }> }
        ).data;
        for (const m of data.sort((a, b) => a.id.localeCompare(b.id))) {
          const stt = looksLikeSpeechModel(m.id);
          if ((kind === "transcription") !== stt) continue;
          if (kind === "language" && /tts|guard|embed/i.test(m.id)) continue;
          out.models.push({ id: `groq:${m.id}`, label: m.id, note: m.owned_by });
        }
      } else if (provider === "gateway") {
        const { createGateway } = await import("@ai-sdk/gateway");
        const gw = createGateway({ apiKey: key });
        // the model listing is public; only an authenticated call proves the key
        await gw.getCredits().catch((err) => {
          throw new Error(
            /40[13]|unauthori|forbidden|invalid/i.test(String((err as Error).message))
              ? `the gateway rejected the key (${(err as Error).message})`
              : (err as Error).message,
          );
        });
        const [{ models }, retiring] = await Promise.all([gw.getAvailableModels(), gatewayRetirements()]);
        if (retiring) out.lifecycle = true;
        for (const m of models) {
          // the gateway types its models; untyped ones predate the field and are language models
          if ((m.modelType ?? "language") !== kind) continue;
          const price = kind === "language" && m.pricing ? perMillionTokens(Number(m.pricing.input) * 1e6, Number(m.pricing.output) * 1e6) : undefined;
          out.models.push(
            withRetirement(
              { id: `gateway:${m.id}`, label: m.id, note: [m.name !== m.id ? m.name : "", price].filter(Boolean).join(" · ") || undefined },
              retiring?.get(m.id),
            ),
          );
        }
      } else if (provider === "opencode") {
        await listOpenCode(out, key, kind);
      }
    } catch (err) {
      out.error = `cannot list ${title}: ${(err as Error).message}`;
      log.warn({ provider, err }, "model listing failed");
    }
    return out;
  }

  /**
   * One key, two plans: Zen and Go are listed side by side as sections of one provider. A plan the key
   * cannot use (no Go subscription, no Zen credits) leaves its section empty with a note; only both
   * failing is an error, so Save and connect accepts a key that works on either. A plan that cannot be
   * reached or answers garbage fails on its own, like one that answers an HTTP error.
   * Language models only: the transcription listing gets no sections (OpenCode has no speech models).
   */
  async function listOpenCode(out: CatalogProvider, key: string, kind: CatalogKind) {
    if (kind !== "language") return;
    const plans = objectKeys(OPENCODE_PLANS);
    out.groups = plans.map((p) => ({ name: OPENCODE_PLANS[p].group, ...(OPENCODE_PLANS[p].notice ? { notice: OPENCODE_PLANS[p].notice } : {}) }));
    const root = (config.OPENCODE_BASE_URL || OPENCODE_DEFAULT_BASE_URL).replace(/\/+$/, "");
    const headers = { authorization: `Bearer ${key}`, "user-agent": opencodeUserAgent(config.REELSAW_VERSION) };
    const rejected = (status: number | undefined) => status === 401 || status === 403;
    const results = await Promise.all(
      plans.map(async (plan): Promise<{ plan: OpenCodePlan; status?: number; error?: string; models: OpenCodeModelEntry[] }> => {
        try {
          const res = await fetch(root + OPENCODE_PLANS[plan].models, { headers, signal: AbortSignal.timeout(10_000) });
          if (!res.ok) return { plan, status: res.status, error: `HTTP ${res.status}`, models: [] };
          const body = (await res.json()) as { data?: OpenCodeModelEntry[] };
          if (!Array.isArray(body?.data)) return { plan, status: res.status, error: "an unexpected answer", models: [] };
          return { plan, status: res.status, models: body.data.filter(isUsableOpenCodeModel).sort((a, b) => a.id.localeCompare(b.id)) };
        } catch (err) {
          return { plan, error: (err as Error).message, models: [] };
        }
      }),
    );
    if (results.every((r) => r.error)) {
      // a rejected key is the actionable reason, whichever plan said it
      const r = results.find((x) => rejected(x.status));
      if (r) throw new Error(`the key was rejected (HTTP ${r.status})`);
      throw new Error(results.map((x) => `${OPENCODE_PLANS[x.plan].group}: ${x.error}`).join("; "));
    }
    for (const r of results) {
      const plan = OPENCODE_PLANS[r.plan];
      if (r.error) {
        const group = out.groups.find((g) => g.name === plan.group)!;
        group.notice = t(
          rejected(r.status)
            ? msg({ id: "models.group_key_refused", message: msg`This key cannot use ${{ group: plan.group }} (HTTP ${{ status: r.status }}).` })
            : msg({ id: "models.group_list_failed", message: msg`${{ group: plan.group }} could not be listed: ${{ error: r.error }}.` }),
        );
        continue;
      }
      for (const m of r.models) {
        const input = m.cost?.text?.input?.price;
        const output = m.cost?.text?.output?.price;
        // Go draws list prices from the subscription's allowance; Zen bills them
        const price = input !== undefined && output !== undefined ? perMillionTokens(input, output) : "";
        out.models.push({
          id: `${r.plan}:${m.id}`,
          label: m.id,
          group: plan.group,
          note: [m.name && m.name !== m.id ? m.name : "", price].filter(Boolean).join(" · ") || undefined,
        });
      }
    }
  }

  async function providerFor(
    provider: string,
    kind: CatalogKind,
    override?: { apiKey?: string | undefined; baseUrl?: string | undefined },
  ): Promise<CatalogProvider> {
    const creds = override ?? credentials.get(provider);
    if (provider === "openai" && creds.baseUrl) return selfHosted("openai", creds.baseUrl, creds.apiKey, kind);
    if (provider === compat) {
      if (!creds.baseUrl)
        return {
          provider,
          title: "Ollama / OpenAI-compatible server",
          kind,
          available: false,
          reason: "needs the server's base URL, e.g. http://host.docker.internal:11434/v1: enter it here, or set OPENAI_COMPATIBLE_BASE_URL in .env",
          source: "static",
          models: [],
        };
      return selfHosted(provider, creds.baseUrl, creds.apiKey, kind);
    }
    return cloud(provider, kind, override);
  }

  async function pullOllama(job: PullJob & { abort: AbortController }, base: string, apiKey: string | undefined) {
    const res = await fetch(`${root(base)}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model: job.model, stream: true }),
      signal: job.abort.signal,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => "")}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const j = JSON.parse(line) as { status?: string; error?: string; total?: number; completed?: number };
        if (j.error) throw new Error(j.error);
        if (j.status) job.message = j.status;
        if (typeof j.total === "number") job.total = j.total;
        if (typeof j.completed === "number") job.completed = j.completed;
      }
    }
  }

  async function pullSpeaches(job: PullJob & { abort: AbortController }, base: string, apiKey: string | undefined) {
    job.message = "downloading (Speaches reports no progress)";
    const res = await fetch(`${base}/models/${job.model}`, {
      method: "POST",
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: job.abort.signal,
    });
    if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }

  async function list(kind: CatalogKind, opts: { refresh?: boolean | undefined } = {}): Promise<CatalogProvider[]> {
    // aliases (opencode-go) are listed inside their owner, not as providers of their own
    const providers = [...new Set([compat, ...Object.keys(providerKeyEnv)])].filter((p) => credentialOwner(p) === p);
    const out = await Promise.all(
      providers.map(async (p) => {
        const k = `${kind}:${p}:${credentials.version()}`;
        const hit = cache.get(k);
        if (hit && !opts.refresh && Date.now() - hit.at < CACHE_MS) return hit.value;
        const v = await providerFor(p, kind);
        if (!v.error) cache.set(k, { at: Date.now(), value: v });
        return v;
      }),
    );
    // what the word-timestamp test said, for models that took it (not cached: a Test press changes it)
    if (kind === "transcription") {
      const verdicts = await verdictsOf(out.flatMap((p) => p.models.map((m) => m.id))).catch(() => new Map<string, WordTimestampVerdict>());
      const note = (m: CatalogModel) => {
        const v = verdicts.get(m.id);
        return v ? { ...m, note: [m.note, v.wordLevel ? "word timestamps: passed" : "no word timestamps"].filter(Boolean).join(" · ") } : m;
      };
      return out.map((p) => ({ ...p, models: p.models.map(note) })).sort(byShown);
    }
    return out.sort(byShown);
  }

  return {
    list,
    async page(kind, opts = {}) {
      const limit = Math.min(CATALOG_PAGE_MAX, Math.max(1, Math.floor(opts.limit ?? CATALOG_PAGE_DEFAULT)));
      const offset = opts.cursor ? Number(opts.cursor) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`cursor "${opts.cursor}" is not one this listing gave out`);
      const q = opts.q?.trim() ?? "";
      const all = await list(kind, { refresh: opts.refresh });
      // an alias (opencode-go) pages through its owner's listing
      const only = opts.provider ? credentialOwner(opts.provider) : undefined;
      if (only && !all.some((p) => p.provider === only)) throw new Error(`no provider "${opts.provider}"; one of ${all.map((p) => p.provider).join(", ")}`);
      const pinned = new Set(opts.pin ?? []);
      const ranked = all
        .filter((p) => !only || p.provider === only)
        .map((p) => {
          let models = p.models;
          let best = 1;
          if (q) {
            const hits = createFuzzy(
              p.models.map((m) => ({ m, id: m.id, label: m.label, title: p.title, note: m.note ?? "" })),
              SEARCH_KEYS,
            ).search(q);
            models = hits.map((h) => h.item.m);
            best = hits[0]?.score ?? 1;
          } else if (pinned.size) {
            models = [...models.filter((m) => pinned.has(m.id)), ...models.filter((m) => !pinned.has(m.id))];
            // pinned models lead their own section, so sections stay together across pages
            if (p.groups) {
              const order = new Map(p.groups.map((g, i) => [g.name, i]));
              models = [...models].sort((a, b) => (order.get(a.group ?? "") ?? 0) - (order.get(b.group ?? "") ?? 0));
            }
          }
          const end = offset + limit;
          const page: CatalogProviderPage = {
            ...p,
            models: models.slice(offset, end),
            total: models.length,
            nextCursor: end < models.length ? String(end) : null,
            ...(p.selfHosted ? { installedCount: p.models.filter((m) => m.installed).length } : {}),
          };
          return { page, best };
        });
      // a search keeps the providers that matched, best match first (stable, so ties keep the usual order)
      const providers = q ? ranked.filter((r) => r.page.total > 0).sort((a, b) => a.best - b.best) : ranked;
      return { providers: providers.map((r) => r.page), limit, q: q || null };
    },
    async probe(provider, creds) {
      const [l, t] = await Promise.all([providerFor(provider, "language", creds), providerFor(provider, "transcription", creds)]);
      const error = l.error ?? t.error ?? (!l.available ? l.reason : undefined);
      return { ok: !error, language: l.models.length, transcription: t.models.length, ...(error ? { error } : {}) };
    },
    async pull(provider, model) {
      const existing = [...jobs.values()].find((j) => j.provider === provider && j.model === model && j.status === "running");
      if (existing) return existing;
      const { baseUrl: base, apiKey } = provider === "openai" || provider === compat ? credentials.get(provider) : {};
      if (!base)
        throw new Error(
          `"${provider}" is not a self-hosted server here; models are downloaded only onto Ollama or Speaches (a base URL under Settings → Models, or OPENAI_COMPATIBLE_BASE_URL / OPENAI_BASE_URL)`,
        );
      const b = base.replace(/\/+$/, "");
      const server = (await providerFor(provider, "language")).selfHosted?.server ?? (await providerFor(provider, "transcription")).selfHosted?.server;
      if (server !== "ollama" && server !== "speaches") throw new Error(`${b} is neither Ollama nor Speaches, so it cannot download models on request`);
      const job: PullJob & { abort: AbortController } = {
        id: `pull-${++seq}`,
        provider,
        model,
        status: "running",
        completed: 0,
        total: 0,
        message: "starting",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        abort: new AbortController(),
      };
      jobs.set(job.id, job);
      void (server === "ollama" ? pullOllama(job, b, apiKey) : pullSpeaches(job, b, apiKey))
        .then(() => {
          job.status = "done";
          job.message = "installed";
          if (job.total) job.completed = job.total;
          log.info({ provider, model }, "model downloaded");
        })
        .catch((err) => {
          job.status = job.abort.signal.aborted ? "cancelled" : "failed";
          job.message = job.abort.signal.aborted ? "cancelled" : (err as Error).message;
          log.warn({ provider, model, err }, "model download failed");
        })
        .finally(() => {
          job.finishedAt = new Date().toISOString();
          for (const k of [...cache.keys()]) if (k.split(":")[1] === provider) cache.delete(k);
          // keep the last few for the UI; drop the rest
          const done = [...jobs.values()].filter((j) => j.status !== "running").sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
          for (const j of done.slice(0, Math.max(0, done.length - 10))) jobs.delete(j.id);
        });
      return job;
    },
    pulls: () => [...jobs.values()].map(({ abort: _a, ...j }) => j),
    cancelPull(id) {
      const j = jobs.get(id);
      if (j?.status !== "running") return false;
      j.abort.abort();
      return true;
    },
  };
}
