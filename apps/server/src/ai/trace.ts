/**
 * LLM call capture, configured by LLM_TRACE (comma-separated sinks):
 *   none      – nothing (default)
 *   logs      – one structured log line per call: prompt, response, tokens, latency, error
 *               (LLM_TRACE_MAX_CHARS truncates prompt/response; logs also land in LOG_FILE)
 *   langfuse  – a Langfuse trace per job and a generation per call (LANGFUSE_PUBLIC_KEY,
 *               LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL; ai/langfuse.ts), for replaying and comparing analysis runs; each
 *               generation carries its step's prompt version, and a user's decisions about the output (a clip
 *               deleted, a fix rejected) arrive as scores on the project's session (decisions/scores.ts)
 *
 * Implemented as AI SDK language-model middleware, so every generateText call is captured without
 * touching call sites. Context (project, clip, stage, job, call name) comes from AsyncLocalStorage:
 * workers wrap each job in `withLlmContext`, helpers add the call name.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { get, isBoolean, isNumber, isObjectLike, isString } from "lodash-es";
import type { LanguageModelMiddleware } from "ai";
import type { Logger } from "../log.js";
import { reportedCost } from "../eval/meter.js";
import type { DecisionScore } from "../decisions/scores.js";
import { createLangfuseSink, type LangfuseDeps, type LangfuseSink } from "./langfuse.js";

/** One part of a multi-part message as plain text: its text for a text part, `[type]` for anything else (an image, a file). */
function contentPartText(p: unknown): string {
  if (!p || typeof p !== "object") return "";
  const type = "type" in p && typeof p.type === "string" ? p.type : "unknown";
  return type === "text" && "text" in p && typeof p.text === "string" ? p.text : `[${type}]`;
}

export interface LlmContext {
  projectId?: string;
  clipId?: string;
  stage?: string;
  jobId?: string;
  /** what this call is for: "analyze.map", "analyze.score", "refine.entities", … */
  call?: string;
  /** the durable step the call runs in ("map:3", "score:0"), when it runs in one */
  step?: string;
  /** the prompt version of that step (MAP_PROMPT_VERSION, …): what to group by when comparing prompt changes */
  promptVersion?: string;
}

const als = new AsyncLocalStorage<LlmContext>();
/** Run `fn` with extra LLM-call context (merged with any outer context). */
export function withLlmContext<T>(ctx: LlmContext, fn: () => T): T {
  return als.run({ ...(als.getStore() ?? {}), ...ctx }, fn);
}
export const llmContext = () => als.getStore() ?? {};

export type TraceSink = "logs" | "langfuse";

export interface LlmUsage {
  ctx: LlmContext;
  model: string;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  ok: boolean;
  /** USD the provider reported (AI Gateway), else undefined */
  costUsd?: number | undefined;
}
export interface LlmTracer {
  sinks: TraceSink[];
  middleware: LanguageModelMiddleware | null;
  /** Called after every call (usage accounting), independent of LLM_TRACE. Set once the database is up. */
  onUsage: ((u: LlmUsage) => void) | null;
  /** true when `score` goes somewhere (Langfuse is a sink) */
  scoring: boolean;
  /** Eval scores on a project's session (decisions/scores.ts). Best-effort: queued with the traces, never throws. */
  score(projectId: string, scores: DecisionScore[]): void;
  check(): Promise<void>;
  shutdown(): Promise<void>;
}

interface TraceConfig {
  LLM_TRACE: string;
  LLM_TRACE_MAX_CHARS: number;
  LANGFUSE_PUBLIC_KEY?: string | undefined;
  LANGFUSE_SECRET_KEY?: string | undefined;
  LANGFUSE_BASE_URL: string;
}

type Prompt = Array<{ role: string; content: unknown }>;
function promptText(prompt: Prompt): Array<{ role: string; content: string }> {
  return prompt.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(contentPartText).join("") : String(m.content),
  }));
}
/**
 * Why a model call failed, as plain fields beside `err`: the error class, the HTTP status and the provider's error
 * type or code. Error reporting scrubs a message it thinks holds a secret (gateway errors quote headers and keys), and
 * then the class and status are all that is left to tell a rate limit from a bad request. None of these is user content.
 */
type LlmErrorFields = { errName?: string; statusCode?: number; errCode?: string; retryable?: boolean };
export function llmErrorFields(err: unknown): LlmErrorFields {
  if (!isObjectLike(err)) return {};
  const out: LlmErrorFields = {};
  const name: unknown = get(err, "name");
  const status: unknown = get(err, "statusCode");
  const retryable: unknown = get(err, "isRetryable");
  if (isString(name)) out.errName = name;
  if (isNumber(status)) out.statusCode = status;
  if (isBoolean(retryable)) out.retryable = retryable;
  const code: unknown = get(err, "code");
  const type: unknown = get(err, "type");
  const c = isString(code) ? code : isString(type) ? type : bodyCode(get(err, "responseBody"));
  if (c) out.errCode = c.slice(0, 80);
  return out;
}
function bodyCode(body: unknown): string | undefined {
  if (!isString(body) || !body.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    const c: unknown = get(parsed, "error.code") ?? get(parsed, "error.type");
    return isString(c) ? c : undefined;
  } catch {
    return undefined;
  }
}

/** Model settings Langfuse can show (it takes strings and numbers): the ones a call left unset are dropped. */
function definedSettings(s: Record<string, unknown>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(s).filter((e): e is [string, string | number] => typeof e[1] === "string" || typeof e[1] === "number"));
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [+${s.length - n} chars]` : s);

export async function createLlmTracer(config: TraceConfig, log: Logger, deps: { langfuse?: LangfuseDeps } = {}): Promise<LlmTracer> {
  const sinks = config.LLM_TRACE.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is TraceSink => s === "logs" || s === "langfuse");
  const tracer: LlmTracer = {
    sinks,
    middleware: null,
    onUsage: null,
    scoring: false,
    score: () => {},
    check: async () => {},
    shutdown: async () => {},
  };

  let langfuse: LangfuseSink | undefined;
  if (sinks.includes("langfuse")) {
    if (!config.LANGFUSE_PUBLIC_KEY || !config.LANGFUSE_SECRET_KEY)
      throw new Error("LLM_TRACE includes langfuse but LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are not set");
    langfuse = await createLangfuseSink(
      { LANGFUSE_PUBLIC_KEY: config.LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY: config.LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL: config.LANGFUSE_BASE_URL },
      log.child({ module: "llm" }),
      deps.langfuse,
    );
  }
  const traceLog = log.child({ module: "llm" });

  const middleware: LanguageModelMiddleware = {
    wrapGenerate: async ({ doGenerate, params, model }) => {
      const ctx = llmContext();
      const startTime = new Date();
      const input = promptText(params.prompt as Prompt);
      const settings = { temperature: params.temperature, maxOutputTokens: params.maxOutputTokens, responseFormat: params.responseFormat?.type };
      try {
        const res = await doGenerate();
        const output = res.content.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("");
        const usage = { input: res.usage.inputTokens.total ?? 0, output: res.usage.outputTokens.total ?? 0 };
        const ms = Date.now() - startTime.getTime();
        tracer.onUsage?.({
          ctx,
          model: model.modelId,
          inputTokens: usage.input,
          outputTokens: usage.output,
          ms,
          ok: true,
          costUsd: reportedCost(res.providerMetadata),
        });
        // tokens and latency per call are in llm_usage (and the AI SDK spans); a cut-off answer is in neither
        const fr = res.finishReason as unknown;
        const finish = typeof fr === "string" ? fr : (fr as { unified?: string } | undefined)?.unified;
        if (finish && finish !== "stop" && finish !== "tool-calls")
          traceLog.warn(
            { ...ctx, model: model.modelId, provider: model.provider, finishReason: finish, outputTokens: usage.output },
            "llm answer did not finish normally",
          );
        if (sinks.includes("logs")) {
          traceLog.info(
            {
              ...ctx,
              model: model.modelId,
              provider: model.provider,
              ms,
              usage,
              settings,
              prompt: input.map((m) => ({ role: m.role, content: clip(m.content, config.LLM_TRACE_MAX_CHARS) })),
              response: clip(output, config.LLM_TRACE_MAX_CHARS),
            },
            "llm call",
          );
        }
        if (langfuse) {
          langfuse.generation(ctx, {
            name: ctx.call ?? ctx.stage ?? "generate",
            model: model.modelId,
            modelParameters: definedSettings(settings),
            input,
            output,
            startTime,
            endTime: new Date(),
            usageDetails: usage,
            ...(ctx.promptVersion ? { version: ctx.promptVersion } : {}),
            metadata: { ...ctx, provider: model.provider, ...(finish ? { finishReason: finish } : {}) },
          });
        }
        return res;
      } catch (err) {
        const ms = Date.now() - startTime.getTime();
        tracer.onUsage?.({ ctx, model: model.modelId, inputTokens: 0, outputTokens: 0, ms, ok: false });
        const why = llmErrorFields(err);
        if (!sinks.includes("logs")) traceLog.warn({ ...ctx, model: model.modelId, provider: model.provider, ms, ...why, err }, "llm call failed");
        if (sinks.includes("logs"))
          traceLog.warn(
            {
              ...ctx,
              model: model.modelId,
              provider: model.provider,
              ms,
              ...why,
              err,
              prompt: input.map((m) => ({ role: m.role, content: clip(m.content, config.LLM_TRACE_MAX_CHARS) })),
            },
            "llm call failed",
          );
        if (langfuse)
          langfuse.generation(ctx, {
            name: ctx.call ?? ctx.stage ?? "generate",
            model: model.modelId,
            input,
            startTime,
            endTime: new Date(),
            error: (err as Error).message?.slice(0, 1000) || "model call failed",
            ...(ctx.promptVersion ? { version: ctx.promptVersion } : {}),
            metadata: { ...ctx, provider: model.provider, ...why },
          });
        throw err;
      }
    },
  };

  tracer.middleware = middleware;
  if (langfuse) {
    const lf = langfuse;
    tracer.scoring = true;
    tracer.score = (projectId, scores) => lf.score(projectId, scores);
  }
  tracer.check = async () => {
    if (!langfuse) return;
    // fail fast on wrong keys/URL instead of silently dropping traces
    const res = await fetch(`${config.LANGFUSE_BASE_URL.replace(/\/$/, "")}/api/public/projects`, {
      headers: { Authorization: `Basic ${Buffer.from(`${config.LANGFUSE_PUBLIC_KEY}:${config.LANGFUSE_SECRET_KEY}`).toString("base64")}` },
      signal: AbortSignal.timeout(8000),
    }).catch((err: Error) => {
      throw new Error(`cannot reach Langfuse at ${config.LANGFUSE_BASE_URL}: ${err.message}`);
    });
    if (res.status === 401 || res.status === 403)
      throw new Error(`Langfuse rejected the keys (HTTP ${res.status}); check LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY`);
    if (!res.ok) throw new Error(`Langfuse check failed: HTTP ${res.status}`);
  };
  tracer.shutdown = async () => {
    await langfuse?.shutdown().catch(() => {});
  };
  return tracer;
}
