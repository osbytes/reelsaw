/**
 * AI SDK spans. AI SDK 7 emits telemetry only through a registered integration, so `telemetry: { isEnabled, functionId }`
 * on a call does nothing until `registerAiTelemetry()` has run (services.ts, when OTEL_ENABLED). The integration is
 * `@ai-sdk/otel`: GenAI semantic-convention spans (`invoke_agent analyze.map`, then one span per model call) with model,
 * tokens, finish reason and latency, under the job or request span that made the call.
 *
 * Prompts and answers never go on a span, whatever a call site passes: transcripts and titles are user content, and
 * telemetry.ts promises they stay home. `LLM_TRACE` (logs, Langfuse) is where prompt bodies are kept, by the operator's
 * choice. Each span carries the ids of the LLM context instead (project, clip, stage, job, call, prompt version), so a
 * slow or failed call is found from the project and the other way round.
 */
import { OpenTelemetry } from "@ai-sdk/otel";
import { registerTelemetry, type Telemetry } from "ai";
import { llmContext, type LlmContext } from "./trace.js";

/** The LLM context as span attributes (`reelsaw.*`); unset fields are left out. */
export function contextAttributes(ctx: LlmContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx)) if (typeof v === "string" && v) out[`reelsaw.${k}`] = v;
  return out;
}

/**
 * `inner` with every lifecycle event marked "do not record inputs or outputs" before it sees it. The AI SDK copies the
 * call's `recordInputs` / `recordOutputs` onto each event (create-telemetry-dispatcher), and the integration reads them
 * there, so overriding them on the event is the one place that holds for every call site, including ones that pass
 * no telemetry options at all.
 */
export function withoutContent<T extends object>(inner: T): T {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string" || !/^(on|experimental_on)[A-Z]/.test(prop)) return value;
      return (event: unknown) => {
        const safe =
          event && typeof event === "object"
            ? Object.assign(Object.create(Object.getPrototypeOf(event)), event, { recordInputs: false, recordOutputs: false })
            : event;
        return value.call(target, safe);
      };
    },
  });
}

let registered = false;
/** Register the OpenTelemetry integration once per process. No-op when OpenTelemetry is off (the caller checks). */
export function registerAiTelemetry(): void {
  if (registered) return;
  registered = true;
  const integration: Telemetry = new OpenTelemetry({
    // `invoke_agent analyze.map`, not `invoke_agent openai/gpt-4o-mini`: the call is what a reader looks for
    agentSpanName: "functionId",
    usage: true,
    // span creation runs inside the caller's async context, so the job's LLM context is readable here
    enrichSpan: () => contextAttributes(llmContext()),
  });
  registerTelemetry(withoutContent(integration));
}
