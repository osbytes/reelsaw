/**
 * What models each configured provider offers, for the admin's model picker (Settings → Models), and
 * downloads onto self-hosted servers (Ollama `/api/pull`, Speaches `POST /v1/models/{id}`) with progress.
 *
 * Only providers whose key or base URL is in the environment answer with a live list; the rest are
 * shown as unavailable with the variable to set. Listings are cached for a few minutes per provider.
 * Keys never leave this module: listings carry model ids, names, sizes and prices.
 */
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import { providerKeyEnv, supportsWordTimestamps } from "./registry.js";

export type CatalogKind = "language" | "transcription";

export interface CatalogModel {
  /** full id as the pipeline uses it: "<provider>:<model>" */
  id: string;
  label: string;
  /** one short line: size, price, family */
  note?: string;
  /** self-hosted servers: present on disk (false = listed by the registry, can be pulled) */
  installed?: boolean;
  sizeBytes?: number;
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
  /** the listing failed; models may be a static fallback */
  error?: string;
}

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
  list(kind: CatalogKind, opts?: { refresh?: boolean }): Promise<CatalogProvider[]>;
  /** Start a download on a self-hosted server; one per model at a time. Returns the job to poll. */
  pull(provider: string, model: string): Promise<PullJob>;
  pulls(): PullJob[];
  cancelPull(id: string): boolean;
}

const CACHE_MS = 5 * 60_000;

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
    ["nova-3", "word timestamps, smart formatting", "transcription"],
    ["nova-2", "previous generation", "transcription"],
  ],
  assemblyai: [
    ["best", "highest accuracy", "transcription"],
    ["nano", "cheapest", "transcription"],
  ],
};

const TITLES: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", groq: "Groq", deepgram: "Deepgram", assemblyai: "AssemblyAI", gateway: "Vercel AI Gateway" };

function fmtBytes(n: number) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

/** Keep the chat-capable OpenAI models out of a /v1/models dump that also lists TTS, embeddings, images. */
function isOpenAiLanguageModel(id: string) {
  if (!/^(gpt-|o[1-9]|chatgpt-)/.test(id)) return false;
  return !/(realtime|audio|tts|transcribe|embedding|image|search|instruct|moderation|dall-e|whisper)/.test(id);
}

export function createModelCatalog(config: Config, log: Logger): ModelCatalog {
  const cache = new Map<string, { at: number; value: CatalogProvider }>();
  const jobs = new Map<string, PullJob & { abort: AbortController }>();
  let seq = 0;

  const keyFor = (provider: string) => (providerKeyEnv[provider] ?? []).find((k) => process.env[k]);
  const missing = (provider: string) => `set ${(providerKeyEnv[provider] ?? []).join(" or ")} in .env and restart`;
  const get = async (url: string, headers: Record<string, string> = {}, timeoutMs = 10_000) => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${url.replace(/\?.*$/, "")} returned HTTP ${res.status}`);
    return (await res.json()) as any;
  };
  const root = (base: string) => base.replace(/\/+$/, "").replace(/\/v1$/, "");

  async function selfHosted(provider: string, baseUrl: string, apiKey: string | undefined, kind: CatalogKind): Promise<CatalogProvider> {
    const base = baseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const out: CatalogProvider = { provider, title: provider === "openai" ? `OpenAI-compatible server (${base})` : `${config.OPENAI_COMPATIBLE_NAME} (${base})`, kind, available: true, source: "installed", models: [] };
    try {
      const installed = ((await get(`${base}/models`, headers)) as { data?: Array<{ id: string }> }).data?.map((m) => m.id) ?? [];
      // Ollama: native API has sizes and can pull
      const ollama = await get(`${root(base)}/api/tags`, headers, 5000).catch(() => null);
      if (ollama?.models) {
        out.selfHosted = { baseUrl: base, server: "ollama", canPull: true };
        if (kind === "language") {
          for (const m of ollama.models as Array<{ name: string; size: number; details?: { parameter_size?: string; quantization_level?: string; family?: string } }>) {
            if (/embed/i.test(m.name)) continue;
            out.models.push({ id: `${provider}:${m.name}`, label: m.name, installed: true, sizeBytes: m.size, note: [fmtBytes(m.size), m.details?.parameter_size, m.details?.quantization_level].filter(Boolean).join(" · ") });
          }
          const have = new Set(out.models.map((m) => m.label.replace(/:latest$/, "")));
          for (const [name, note] of OLLAMA_SUGGESTIONS) if (!have.has(name) && !have.has(name.replace(/:latest$/, ""))) out.models.push({ id: `${provider}:${name}`, label: name, installed: false, note: `${note} · not installed` });
        }
        return out;
      }
      // Speaches: a registry of downloadable whisper models next to the installed ones
      const registry = await get(`${base}/registry?task=automatic-speech-recognition`, headers, 5000).catch(() => null);
      if (registry?.data) {
        out.selfHosted = { baseUrl: base, server: "speaches", canPull: true };
        if (kind === "transcription") {
          const have = new Set(installed);
          for (const id of installed) out.models.push({ id: `${provider}:${id}`, label: id, installed: true });
          for (const m of registry.data as Array<{ id: string }>) if (!have.has(m.id) && /whisper/i.test(m.id)) out.models.push({ id: `${provider}:${m.id}`, label: m.id, installed: false, note: "not installed" });
        }
        return out;
      }
      out.selfHosted = { baseUrl: base, server: "openai-compatible", canPull: false };
      for (const id of installed) if (kind === "language" ? !/whisper|embed/i.test(id) : /whisper/i.test(id)) out.models.push({ id: `${provider}:${id}`, label: id, installed: true });
      return out;
    } catch (err) {
      out.error = `cannot list ${base}: ${(err as Error).message}`;
      return out;
    }
  }

  async function cloud(provider: string, kind: CatalogKind): Promise<CatalogProvider> {
    const title = TITLES[provider] ?? provider;
    const out: CatalogProvider = { provider, title, kind, available: !!keyFor(provider), source: "live", models: [] };
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
    const key = process.env[keyFor(provider)!]!;
    try {
      if (provider === "openai") {
        const data = ((await get("https://api.openai.com/v1/models", { authorization: `Bearer ${key}` })) as { data: Array<{ id: string }> }).data;
        const ids = data.map((m) => m.id).sort();
        if (kind === "language") for (const id of ids) if (isOpenAiLanguageModel(id)) out.models.push({ id: `openai:${id}`, label: id });
        if (kind === "transcription") for (const id of ids) if (supportsWordTimestamps(`openai:${id}`)) out.models.push({ id: `openai:${id}`, label: id, note: "word timestamps" });
      } else if (provider === "anthropic") {
        if (kind === "language") {
          const data = ((await get("https://api.anthropic.com/v1/models?limit=100", { "x-api-key": key, "anthropic-version": "2023-06-01" })) as { data: Array<{ id: string; display_name?: string }> }).data;
          for (const m of data) out.models.push({ id: `anthropic:${m.id}`, label: m.id, note: m.display_name });
        }
      } else if (provider === "google") {
        if (kind === "language") {
          const data = (await get(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`)) as { models: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> };
          for (const m of data.models ?? []) {
            if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
            const id = m.name.replace(/^models\//, "");
            if (/embedding|aqa|imagen|veo|tts|live|image/i.test(id)) continue;
            out.models.push({ id: `google:${id}`, label: id, note: m.displayName });
          }
        }
      } else if (provider === "groq") {
        const data = ((await get("https://api.groq.com/openai/v1/models", { authorization: `Bearer ${key}` })) as { data: Array<{ id: string; owned_by?: string }> }).data;
        for (const m of data.sort((a, b) => a.id.localeCompare(b.id))) {
          const stt = /whisper/i.test(m.id);
          if ((kind === "transcription") !== stt) continue;
          if (kind === "language" && /tts|guard|embed/i.test(m.id)) continue;
          out.models.push({ id: `groq:${m.id}`, label: m.id, note: m.owned_by });
        }
      } else if (provider === "gateway") {
        if (kind === "language") {
          const { createGateway } = await import("@ai-sdk/gateway");
          const { models } = await createGateway({ apiKey: key }).getAvailableModels();
          for (const m of models) {
            if (m.modelType && m.modelType !== "language") continue;
            const price = m.pricing ? `$${(Number(m.pricing.input) * 1e6).toFixed(2)} / $${(Number(m.pricing.output) * 1e6).toFixed(2)} per 1M tokens` : undefined;
            out.models.push({ id: `gateway:${m.id}`, label: m.id, note: [m.name !== m.id ? m.name : "", price].filter(Boolean).join(" · ") || undefined });
          }
        } else {
          out.source = "static";
          out.models.push({ id: "gateway:openai/whisper-1", label: "openai/whisper-1", note: "word timestamps; the gateway's other transcription models return segments only" });
        }
      }
    } catch (err) {
      out.error = `cannot list ${title}: ${(err as Error).message}`;
      log.warn({ provider, err }, "model listing failed");
    }
    return out;
  }

  async function providerFor(provider: string, kind: CatalogKind): Promise<CatalogProvider> {
    if (provider === "openai" && config.OPENAI_BASE_URL) return selfHosted("openai", config.OPENAI_BASE_URL, config.OPENAI_API_KEY, kind);
    if (provider === config.OPENAI_COMPATIBLE_NAME) {
      if (!config.OPENAI_COMPATIBLE_BASE_URL) return { provider, title: provider, kind, available: false, reason: "set OPENAI_COMPATIBLE_BASE_URL in .env and restart", source: "static", models: [] };
      return selfHosted(provider, config.OPENAI_COMPATIBLE_BASE_URL, config.OPENAI_COMPATIBLE_API_KEY, kind);
    }
    return cloud(provider, kind);
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
    const res = await fetch(`${base}/models/${job.model}`, { method: "POST", headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: job.abort.signal });
    if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }

  return {
    async list(kind, opts = {}) {
      const providers = [...new Set([...Object.keys(providerKeyEnv), ...(config.OPENAI_COMPATIBLE_BASE_URL ? [config.OPENAI_COMPATIBLE_NAME] : [])])];
      const out = await Promise.all(
        providers.map(async (p) => {
          const k = `${kind}:${p}`;
          const hit = cache.get(k);
          if (hit && !opts.refresh && Date.now() - hit.at < CACHE_MS) return hit.value;
          const v = await providerFor(p, kind);
          if (!v.error) cache.set(k, { at: Date.now(), value: v });
          return v;
        }),
      );
      // self-hosted and available providers first, then the ones that need a key
      return out.sort((a, b) => Number(!!b.selfHosted) - Number(!!a.selfHosted) || Number(b.available) - Number(a.available) || a.title.localeCompare(b.title));
    },
    async pull(provider, model) {
      const existing = [...jobs.values()].find((j) => j.provider === provider && j.model === model && j.status === "running");
      if (existing) return existing;
      const base = provider === "openai" ? config.OPENAI_BASE_URL : provider === config.OPENAI_COMPATIBLE_NAME ? config.OPENAI_COMPATIBLE_BASE_URL : undefined;
      if (!base) throw new Error(`"${provider}" is not a self-hosted server here; models are downloaded only onto Ollama or Speaches (OPENAI_COMPATIBLE_BASE_URL / OPENAI_BASE_URL)`);
      const apiKey = provider === "openai" ? config.OPENAI_API_KEY : config.OPENAI_COMPATIBLE_API_KEY;
      const b = base.replace(/\/+$/, "");
      const server = (await providerFor(provider, "language")).selfHosted?.server ?? (await providerFor(provider, "transcription")).selfHosted?.server;
      if (server !== "ollama" && server !== "speaches") throw new Error(`${b} is neither Ollama nor Speaches, so it cannot download models on request`);
      const job: PullJob & { abort: AbortController } = { id: `pull-${++seq}`, provider, model, status: "running", completed: 0, total: 0, message: "starting", startedAt: new Date().toISOString(), finishedAt: null, abort: new AbortController() };
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
          for (const k of [`language:${provider}`, `transcription:${provider}`]) cache.delete(k);
          // keep the last few for the UI; drop the rest
          const done = [...jobs.values()].filter((j) => j.status !== "running").sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
          for (const j of done.slice(0, Math.max(0, done.length - 10))) jobs.delete(j.id);
        });
      return job;
    },
    pulls: () => [...jobs.values()].map(({ abort: _a, ...j }) => j),
    cancelPull(id) {
      const j = jobs.get(id);
      if (!j || j.status !== "running") return false;
      j.abort.abort();
      return true;
    },
  };
}
