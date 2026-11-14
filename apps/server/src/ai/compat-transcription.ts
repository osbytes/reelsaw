/**
 * Transcription on an OpenAI-compatible server (OpenRouter, Speaches, vLLM, LocalAI…): OpenAI's multipart
 * `POST /audio/transcriptions`, parsed here instead of by @ai-sdk/openai.
 *
 * @ai-sdk/openai-compatible has no transcription models, and the OpenAI provider's parser assumes OpenAI's own
 * answers: it prefers `segments` over `words` when both come back (OpenRouter's verbose_json sends both, so the
 * pipeline would get phrases instead of the words it asked for), and it rejects segments without whisper's full
 * shape (id, seek, tokens, avg_logprob…), which OpenRouter's (start, end, text, speaker) are not. This model asks
 * for the same thing and reads what compatible servers actually return: words when present, else segments.
 *
 * Options are OpenAI's names under `providerOptions.openai` (AiService.transcriptionOptionsKey): the request is
 * OpenAI's, whatever vendor the model id names.
 */
import { APICallError, type TranscriptionModelV4, type TranscriptionModelV4CallOptions } from "@ai-sdk/provider";

export interface CompatTranscriptionSettings {
  /** provider name shown in errors and traces, e.g. "openrouter" */
  provider: string;
  baseURL: string;
  apiKey?: string | undefined;
  fetch?: typeof fetch;
}

interface Answer {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
  usage?: unknown;
  words?: Array<{ word?: unknown; start?: unknown; end?: unknown }>;
  segments?: Array<{ text?: unknown; start?: unknown; end?: unknown }>;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Words when the server returned any, else its segments; entries without numeric times are dropped. */
export function segmentsOf(a: Answer): Array<{ text: string; startSecond: number; endSecond: number }> {
  const timed = (text: unknown, start: unknown, end: unknown) => {
    const s = num(start);
    const e = num(end);
    return s === undefined || e === undefined ? [] : [{ text: String(text ?? ""), startSecond: s, endSecond: e }];
  };
  const words = (a.words ?? []).flatMap((w) => timed(w.word, w.start, w.end));
  if (words.length) return words;
  return (a.segments ?? []).flatMap((s) => timed(s.text, s.start, s.end));
}

export function compatTranscriptionModel(settings: CompatTranscriptionSettings, modelId: string): TranscriptionModelV4 {
  const doFetch = settings.fetch ?? fetch;
  const url = `${settings.baseURL.replace(/\/+$/, "")}/audio/transcriptions`;
  return {
    specificationVersion: "v4",
    provider: `${settings.provider}.transcription`,
    modelId,
    async doGenerate(options: TranscriptionModelV4CallOptions) {
      const o = (options.providerOptions?.openai ?? {}) as Record<string, unknown>;
      const bytes = typeof options.audio === "string" ? Buffer.from(options.audio, "base64") : options.audio;
      const ext = options.mediaType.split("/")[1]?.replace("mpeg", "mp3") || "bin";
      const form = new FormData();
      form.append("model", modelId);
      form.append("file", new Blob([bytes], { type: options.mediaType }), `audio.${ext}`);
      form.append("response_format", typeof o.responseFormat === "string" ? o.responseFormat : "verbose_json");
      for (const g of Array.isArray(o.timestampGranularities) ? o.timestampGranularities : []) form.append("timestamp_granularities[]", String(g));
      for (const k of ["language", "prompt", "temperature"] as const) if (o[k] != null) form.append(k, String(o[k]));

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(options.headers ?? {})) if (v != null) headers[k] = v;
      if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
      const res = await doFetch(url, { method: "POST", headers, body: form, ...(options.abortSignal ? { signal: options.abortSignal } : {}) });
      const raw = await res.text();
      const responseHeaders = Object.fromEntries(res.headers.entries());
      if (!res.ok)
        throw new APICallError({
          message: `${res.status} ${res.statusText}: ${raw.slice(0, 300)}`,
          url,
          requestBodyValues: { model: modelId },
          statusCode: res.status,
          responseHeaders,
          responseBody: raw,
          isRetryable: res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500,
        });
      let answer: Answer;
      try {
        answer = JSON.parse(raw) as Answer;
      } catch {
        throw new APICallError({
          message: `not JSON: ${raw.slice(0, 200)}`,
          url,
          requestBodyValues: { model: modelId },
          statusCode: res.status,
          responseBody: raw,
        });
      }
      const language = typeof answer.language === "string" && /^[a-z]{2}$/i.test(answer.language) ? answer.language.toLowerCase() : undefined;
      return {
        text: typeof answer.text === "string" ? answer.text : "",
        segments: segmentsOf(answer),
        language,
        durationInSeconds: num(answer.duration),
        warnings: [],
        ...(answer.usage && typeof answer.usage === "object" ? { usage: answer.usage as never } : {}),
        response: { timestamp: new Date(), modelId, headers: responseHeaders, body: answer },
      };
    },
  };
}
