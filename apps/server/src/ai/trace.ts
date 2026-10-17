/**
 * LLM call capture, configured by LLM_TRACE (comma-separated sinks):
 *   none      – nothing (default)
 *   logs      – one structured log line per call: prompt, response, tokens, latency, error
 *               (LLM_TRACE_MAX_CHARS truncates prompt/response; logs also land in LOG_FILE)
 *   langfuse  – a Langfuse trace per job and a generation per call (LANGFUSE_PUBLIC_KEY,
 *               LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL), for replaying and comparing analysis runs
 *
 * Implemented as AI SDK language-model middleware, so every generateText call is captured without
 * touching call sites. Context (project, clip, stage, job, call name) comes from AsyncLocalStorage:
 * workers wrap each job in `withLlmContext`, helpers add the call name.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { LanguageModelMiddleware } from "ai";
import type { Logger } from "../log.js";

export interface LlmContext {
  projectId?: string;
  clipId?: string;
  stage?: string;
  jobId?: string;
  /** what this call is for: "analyze.map", "analyze.score", "refine.entities", … */
  call?: string;
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
}
export interface LlmTracer {
  sinks: TraceSink[];
  middleware: LanguageModelMiddleware | null;
  /** Called after every call (usage accounting), independent of LLM_TRACE. Set once the database is up. */
  onUsage: ((u: LlmUsage) => void) | null;
  check(): Promise<void>;
  shutdown(): Promise<void>;
}

interface TraceConfig {
  LLM_TRACE: string;
  LLM_TRACE_MAX_CHARS: number;
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL: string;
}

type Prompt = Array<{ role: string; content: unknown }>;
function promptText(prompt: Prompt): Array<{ role: string; content: string }> {
  return prompt.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: { type?: string; text?: string }) => (p.type === "text" ? p.text : `[${p.type}]`)).join("") : String(m.content),
  }));
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [+${s.length - n} chars]` : s);

export async function createLlmTracer(config: TraceConfig, log: Logger): Promise<LlmTracer> {
  const sinks = config.LLM_TRACE.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is TraceSink => s === "logs" || s === "langfuse");
  const tracer: LlmTracer = { sinks, middleware: null, onUsage: null, check: async () => {}, shutdown: async () => {} };

  let langfuse: import("langfuse").Langfuse | undefined;
  const traces = new Map<string, ReturnType<import("langfuse").Langfuse["trace"]>>();
  if (sinks.includes("langfuse")) {
    if (!config.LANGFUSE_PUBLIC_KEY || !config.LANGFUSE_SECRET_KEY) throw new Error("LLM_TRACE includes langfuse but LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are not set");
    const { Langfuse } = await import("langfuse");
    langfuse = new Langfuse({ publicKey: config.LANGFUSE_PUBLIC_KEY, secretKey: config.LANGFUSE_SECRET_KEY, baseUrl: config.LANGFUSE_BASE_URL, flushAt: 10, flushInterval: 5000 });
    langfuse.on("error", (err: unknown) => log.warn({ err }, "langfuse export error"));
  }
  const traceLog = log.child({ module: "llm" });
  // one Langfuse trace per job (or per project+stage outside jobs), so a run reads as one timeline
  const traceFor = (c: LlmContext) => {
    const key = c.jobId ?? `${c.projectId ?? "none"}:${c.stage ?? "none"}`;
    let t = traces.get(key);
    if (!t) {
      t = langfuse!.trace({ name: c.stage ?? "llm", sessionId: c.projectId, metadata: { projectId: c.projectId, clipId: c.clipId, jobId: c.jobId }, tags: ["reelsaw", ...(c.stage ? [c.stage] : [])] });
      traces.set(key, t);
      if (traces.size > 500) traces.delete(traces.keys().next().value!);
    }
    return t;
  };

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
        tracer.onUsage?.({ ctx, model: model.modelId, inputTokens: usage.input, outputTokens: usage.output, ms, ok: true });
        if (sinks.includes("logs")) {
          traceLog.info(
            { ...ctx, model: model.modelId, provider: model.provider, ms, usage, settings, prompt: input.map((m) => ({ role: m.role, content: clip(m.content, config.LLM_TRACE_MAX_CHARS) })), response: clip(output, config.LLM_TRACE_MAX_CHARS) },
            "llm call",
          );
        }
        if (langfuse) {
          traceFor(ctx).generation({ name: ctx.call ?? ctx.stage ?? "generate", model: model.modelId, modelParameters: settings as Record<string, string | number>, input, output, startTime, endTime: new Date(), usageDetails: usage, metadata: { ...ctx, provider: model.provider } });
        }
        return res;
      } catch (err) {
        const ms = Date.now() - startTime.getTime();
        tracer.onUsage?.({ ctx, model: model.modelId, inputTokens: 0, outputTokens: 0, ms, ok: false });
        if (sinks.includes("logs")) traceLog.warn({ ...ctx, model: model.modelId, ms, err, prompt: input.map((m) => ({ role: m.role, content: clip(m.content, config.LLM_TRACE_MAX_CHARS) })) }, "llm call failed");
        if (langfuse) traceFor(ctx).generation({ name: ctx.call ?? ctx.stage ?? "generate", model: model.modelId, input, startTime, endTime: new Date(), level: "ERROR", statusMessage: (err as Error).message?.slice(0, 1000), metadata: ctx });
        throw err;
      }
    },
  };

  tracer.middleware = middleware;
  tracer.check = async () => {
      if (!langfuse) return;
      // fail fast on wrong keys/URL instead of silently dropping traces
      const res = await fetch(`${config.LANGFUSE_BASE_URL.replace(/\/$/, "")}/api/public/projects`, {
        headers: { Authorization: `Basic ${Buffer.from(`${config.LANGFUSE_PUBLIC_KEY}:${config.LANGFUSE_SECRET_KEY}`).toString("base64")}` },
        signal: AbortSignal.timeout(8000),
      }).catch((err: Error) => {
        throw new Error(`cannot reach Langfuse at ${config.LANGFUSE_BASE_URL}: ${err.message}`);
      });
      if (res.status === 401 || res.status === 403) throw new Error(`Langfuse rejected the keys (HTTP ${res.status}); check LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY`);
      if (!res.ok) throw new Error(`Langfuse check failed: HTTP ${res.status}`);
  };
  tracer.shutdown = async () => {
    await langfuse?.shutdownAsync().catch(() => {});
  };
  return tracer;
}
