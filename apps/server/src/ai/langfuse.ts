/**
 * The Langfuse sink of LLM_TRACE (ai/trace.ts) on the OpenTelemetry-based SDK (@langfuse/tracing, @langfuse/otel,
 * @langfuse/client). Langfuse no longer accepts traces from the legacy `langfuse` package's ingestion endpoint.
 *
 * Spans go through a tracer provider of their own, never registered globally: the app's OpenTelemetry setup (Sentry,
 * OTLP) keeps the global provider, nothing of Langfuse's reaches it, and none of its spans (AI SDK, HTTP, database)
 * reach Langfuse. Only what this module starts is exported.
 *
 * One trace per job (or per project and stage outside jobs), so a run reads as one timeline: a root span named for the
 * stage, then one generation per model call under it, each with its own start and end. The trace's name, session (the
 * project id, where decision scores land), tags and metadata are written onto every observation: v4 filters and
 * aggregates by observation, so a generation without the session id would drop out of the session's cost.
 */
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { Logger } from "../log.js";
import type { DecisionScore } from "../decisions/scores.js";
import type { LlmContext } from "./trace.js";

export interface LangfuseConfig {
  LANGFUSE_PUBLIC_KEY: string;
  LANGFUSE_SECRET_KEY: string;
  LANGFUSE_BASE_URL: string;
}

export interface GenerationRecord {
  name: string;
  model: string;
  startTime: Date;
  endTime: Date;
  input: unknown;
  output?: string;
  modelParameters?: Record<string, string | number>;
  usageDetails?: Record<string, number>;
  version?: string;
  metadata: Record<string, unknown>;
  error?: string;
}

export interface LangfuseSink {
  generation(ctx: LlmContext, g: GenerationRecord): void;
  score(projectId: string, scores: DecisionScore[]): void;
  shutdown(): Promise<void>;
}

/** Test seams: where spans go instead of the OTLP endpoint, and where scores go instead of the scores API. */
export interface LangfuseDeps {
  exporter?: SpanExporter;
  scores?: {
    create(s: { id: string; sessionId: string; name: string; value: number; dataType: "BOOLEAN"; metadata: unknown }): void;
    shutdown(): Promise<void>;
  };
}

/** At most this many open traces are remembered; an older job's next call starts a new trace. */
const MAX_TRACES = 500;

const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

export async function createLangfuseSink(config: LangfuseConfig, log: Logger, deps: LangfuseDeps = {}): Promise<LangfuseSink> {
  const [{ LangfuseSpanProcessor }, tracing, { BasicTracerProvider }] = await Promise.all([
    import("@langfuse/otel"),
    import("@langfuse/tracing"),
    import("@opentelemetry/sdk-trace-base"),
  ]);
  const { startObservation, setLangfuseTracerProvider, LangfuseOtelSpanAttributes: A } = tracing;
  const processor = new LangfuseSpanProcessor({
    publicKey: config.LANGFUSE_PUBLIC_KEY,
    secretKey: config.LANGFUSE_SECRET_KEY,
    baseUrl: config.LANGFUSE_BASE_URL,
    flushAt: 10,
    flushInterval: 5,
    ...(deps.exporter ? { exporter: deps.exporter } : {}),
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  setLangfuseTracerProvider(provider);

  let scoreClient = deps.scores;
  if (!scoreClient) {
    const { LangfuseClient } = await import("@langfuse/client");
    const client = new LangfuseClient({ publicKey: config.LANGFUSE_PUBLIC_KEY, secretKey: config.LANGFUSE_SECRET_KEY, baseUrl: config.LANGFUSE_BASE_URL });
    scoreClient = { create: (s) => client.score.create(s), shutdown: () => client.shutdown() };
  }
  const scores = scoreClient;

  type Root = ReturnType<typeof startObservation>;
  const roots = new Map<string, Root>();

  /** The trace-level attributes every observation of this context carries. */
  const traceAttributes = (c: LlmContext) => {
    const meta = defined({ projectId: c.projectId, clipId: c.clipId, jobId: c.jobId }) as Record<string, string>;
    return {
      [A.TRACE_NAME]: c.stage ?? "llm",
      [A.TRACE_TAGS]: ["reelsaw", ...(c.stage ? [c.stage] : [])],
      ...(c.projectId ? { [A.TRACE_SESSION_ID]: c.projectId } : {}),
      ...Object.fromEntries(Object.entries(meta).map(([k, v]) => [`${A.TRACE_METADATA}.${k}`, v])),
    };
  };

  const rootFor = (c: LlmContext, startTime: Date): Root => {
    const key = c.jobId ?? `${c.projectId ?? "none"}:${c.stage ?? "none"}`;
    let root = roots.get(key);
    if (!root) {
      // a marker for the run, ended at once: an open span is never exported, and a job has no single end to wait for
      root = startObservation(c.stage ?? "llm", { metadata: defined({ projectId: c.projectId, clipId: c.clipId, jobId: c.jobId }) }, { startTime });
      root.otelSpan.setAttributes(traceAttributes(c));
      root.end(startTime);
      roots.set(key, root);
      if (roots.size > MAX_TRACES) roots.delete(roots.keys().next().value!);
    }
    return root;
  };

  return {
    generation(ctx, g) {
      try {
        const root = rootFor(ctx, g.startTime);
        const gen = startObservation(
          g.name,
          {
            model: g.model,
            input: g.input,
            ...(g.output !== undefined ? { output: g.output } : {}),
            ...(g.modelParameters ? { modelParameters: g.modelParameters } : {}),
            ...(g.usageDetails ? { usageDetails: g.usageDetails } : {}),
            ...(g.version ? { version: g.version } : {}),
            ...(g.error ? { level: "ERROR" as const, statusMessage: g.error } : {}),
            metadata: g.metadata,
          },
          { asType: "generation", startTime: g.startTime, parentSpanContext: root.otelSpan.spanContext() },
        );
        gen.otelSpan.setAttributes(traceAttributes(ctx));
        gen.end(g.endTime);
      } catch (err) {
        log.warn({ err, call: g.name }, "langfuse generation failed");
      }
    },
    score(projectId, list) {
      for (const s of list) {
        try {
          // the score's id is the decision's, so a retried commit hook overwrites instead of counting twice
          scores.create({ id: s.id, sessionId: projectId, name: s.name, value: s.value, dataType: "BOOLEAN", metadata: s.metadata });
        } catch (err) {
          log.warn({ err, projectId, score: s.name }, "langfuse score failed");
        }
      }
    },
    async shutdown() {
      // flushes what the processor and the score queue still hold
      await Promise.all([provider.shutdown().catch(() => {}), scores.shutdown().catch(() => {})]);
      setLangfuseTracerProvider(null);
    },
  };
}
