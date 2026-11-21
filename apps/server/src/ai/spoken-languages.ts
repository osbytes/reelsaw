/**
 * Which spoken languages the transcription model in force takes: the project language picker, the
 * `list_languages` tool and `reelsaw languages` all read this. The list is the model's to say, never
 * one typed here:
 *   - a self-hosted OpenAI-compatible server (Speaches) lists each model's `language` in `GET /models`;
 *   - Deepgram lists each model's languages in `GET /v1/models`;
 *   - the others (OpenAI, Groq, AssemblyAI, the AI Gateway) say nothing, and Whisper's set is assumed
 *     (WHISPER_SPOKEN_LANGUAGES, generated from Whisper's own table), as is any listing that fails.
 * Answers are cached per model and credentials for a while: the list changes only with the model.
 */
import { languageLabel, spokenCanonical, spokenLanguageCode, WHISPER_SPOKEN_LANGUAGES } from "@reelsaw/shared";
import type { Services } from "../services.js";
import { providerOf, redactUrl } from "./registry.js";

export interface SpokenLanguages {
  /** the transcription model the list is for */
  model: string;
  /** "model": the model's server listed them; "whisper": it says nothing (or the listing failed), so Whisper's set */
  source: "model" | "whisper";
  /** canonical codes (BCP 47 primary subtags) with their English names, sorted by name */
  languages: Array<{ code: string; name: string }>;
}

type Deps = Pick<Services, "models" | "providers" | "config" | "log">;

const OK_MS = 60 * 60_000;
const FAILED_MS = 60_000;
const cache = new Map<string, { at: number; ms: number; value: Promise<SpokenLanguages> }>();

/** Canonical, de-duplicated codes; "multi" (Deepgram's code-switching mode) and anything that is not one language drop out. */
export function canonicalCodes(raw: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const r of raw) {
    const c = typeof r === "string" ? spokenCanonical(r) : undefined;
    if (c) out.add(c);
  }
  return [...out];
}

function result(model: string, source: SpokenLanguages["source"], codes: readonly string[]): SpokenLanguages {
  const languages = codes.map((code) => ({ code, name: languageLabel(code) })).sort((a, b) => a.name.localeCompare(b.name, "en"));
  return { model, source, languages };
}

/**
 * GET JSON. Credentials in the URL (an admin-entered base URL may carry user:pass@) move to a Basic header: fetch
 * refuses such a URL and would quote it, credentials and all, in its error.
 */
async function getJson(raw: string, headers: Record<string, string>): Promise<unknown> {
  const url = new URL(raw);
  if (url.username || url.password) {
    const basic = btoa(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`);
    if (!headers.authorization) headers = { ...headers, authorization: `Basic ${basic}` };
    url.username = "";
    url.password = "";
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Speaches: `{ data: [{ id, language: ["en", …] }] }`; servers that say nothing give undefined. */
export function compatModelLanguages(body: unknown, modelId: string): string[] | undefined {
  const data = (body as { data?: Array<{ id?: unknown; language?: unknown }> } | null)?.data;
  const hit = Array.isArray(data) ? data.find((m) => m?.id === modelId) : undefined;
  return Array.isArray(hit?.language) ? canonicalCodes(hit.language) : undefined;
}

/**
 * Deepgram: `{ stt: [{ name, canonical_name: "nova-3-general", architecture: "nova-3", languages, batch }] }`.
 * A model id names an architecture ("nova-3") or one canonical model ("nova-3-medical"); its languages
 * are those of every batch model it names.
 */
export function deepgramModelLanguages(body: unknown, modelId: string): string[] | undefined {
  const stt = (body as { stt?: Array<Record<string, unknown>> } | null)?.stt;
  if (!Array.isArray(stt)) return undefined;
  // not `name`: Deepgram reuses it across architectures ("general" is a nova-2 and a nova-3 model)
  const named = stt.filter((m) => m && m.batch !== false && (m.architecture === modelId || m.canonical_name === modelId));
  return named.length ? canonicalCodes(named.flatMap((m) => (Array.isArray(m.languages) ? m.languages : []))) : undefined;
}

async function ask(svc: Deps, model: string): Promise<string[] | undefined> {
  const provider = providerOf(model);
  const modelId = model.slice(provider.length + 1);
  const { baseUrl, apiKey } = svc.providers.get(provider);
  if ((provider === "openai" || provider === svc.config.OPENAI_COMPATIBLE_NAME) && baseUrl) {
    const body = await getJson(`${baseUrl.replace(/\/+$/, "")}/models`, apiKey ? { authorization: `Bearer ${apiKey}` } : {});
    return compatModelLanguages(body, modelId);
  }
  if (provider === "deepgram" && apiKey) {
    return deepgramModelLanguages(await getJson("https://api.deepgram.com/v1/models", { authorization: `Token ${apiKey}` }), modelId);
  }
  return undefined;
}

/** The languages `model` (default: the transcription model in force) takes. Never throws: a failed listing is Whisper's set. */
export function spokenLanguages(svc: Deps, model: string = svc.models.get().transcription): Promise<SpokenLanguages> {
  const key = `${model}\n${svc.providers.version()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ms) return hit.value;
  const entry = { at: Date.now(), ms: OK_MS, value: Promise.resolve(result(model, "whisper", WHISPER_SPOKEN_LANGUAGES)) };
  entry.value = ask(svc, model).then(
    (codes) => (codes?.length ? result(model, "model", codes) : result(model, "whisper", WHISPER_SPOKEN_LANGUAGES)),
    (err: unknown) => {
      entry.ms = FAILED_MS;
      // getJson strips credentials before fetching; redactUrl covers a URL quoted by a parse error
      svc.log.warn({ model, err: redactUrl((err as Error).message) }, "listing the transcription model's languages failed; assuming Whisper's");
      return result(model, "whisper", WHISPER_SPOKEN_LANGUAGES);
    },
  );
  cache.set(key, entry);
  return entry.value;
}

/**
 * The language to send `model`: `lang` as a code when the model takes it, else undefined, so it detects. A model
 * rejects a language it does not know (OpenAI and Groq answer 400 for every chunk), and a setting must never fail a
 * run. Checked only against an authoritative list: the model's own, or Whisper's for a Whisper model; any other
 * model is sent the code and left to say.
 */
export async function languageForModel(svc: Deps, model: string, lang: string | null | undefined): Promise<string | undefined> {
  const code = spokenLanguageCode(lang);
  if (!code) return undefined;
  const listed = await spokenLanguages(svc, model);
  if (listed.source === "whisper" && !/whisper/i.test(model)) return code;
  if (listed.languages.some((l) => l.code === code)) return code;
  svc.log.info({ model, language: code }, "the model does not take this language; letting it detect");
  return undefined;
}

/** Tests: forget cached answers. */
export function clearSpokenLanguagesCache() {
  cache.clear();
}
