/**
 * LLM_TRACE=langfuse on the OpenTelemetry SDK (ai/langfuse.ts): what a job's model calls look like as spans, read from
 * an in-memory exporter in place of the OTLP endpoint. No network, no Langfuse project.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateText, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { createLlmTracer, withLlmContext } from "../src/ai/trace.js";
import type { Logger } from "../src/log.js";

const warnings: unknown[] = [];
const log = {
  child: () => log,
  info: () => {},
  debug: () => {},
  warn: (o: unknown) => warnings.push(o),
} as unknown as Logger;

const config = {
  LLM_TRACE: "langfuse",
  LLM_TRACE_MAX_CHARS: 1000,
  LANGFUSE_PUBLIC_KEY: "pk-lf-test",
  LANGFUSE_SECRET_KEY: "sk-lf-test",
  LANGFUSE_BASE_URL: "http://127.0.0.1:9",
};

const usage = { inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

/** InMemorySpanExporter forgets its spans on shutdown; the sink's shutdown is what flushes them, so keep them. */
class KeepingExporter extends InMemorySpanExporter {
  override shutdown() {
    return Promise.resolve();
  }
}

async function run(doGenerate: () => Promise<unknown>) {
  const exporter = new KeepingExporter();
  const scored: unknown[] = [];
  const tracer = await createLlmTracer(config, log, {
    langfuse: { exporter, scores: { create: (s) => scored.push(s), shutdown: async () => {} } },
  });
  const model = wrapLanguageModel({ model: new MockLanguageModelV4({ doGenerate: doGenerate as never }), middleware: tracer.middleware! });
  return { exporter, scored, tracer, model };
}

describe("Langfuse sink", () => {
  it("puts a job's calls in one trace: a root span for the stage, a generation per call carrying the session", async () => {
    const { exporter, tracer, model } = await run(async () => ({
      content: [{ type: "text", text: "ok" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    }));
    await withLlmContext({ projectId: "p1", stage: "analyze", jobId: "j1" }, async () => {
      await withLlmContext({ call: "analyze.map", promptVersion: "map-v3" }, () => generateText({ model, prompt: "first" }));
      await withLlmContext({ call: "analyze.score" }, () => generateText({ model, prompt: "second" }));
    });
    await withLlmContext({ projectId: "p1", stage: "analyze", jobId: "j2" }, () => generateText({ model, prompt: "other job" }));
    await tracer.shutdown();

    const spans = exporter.getFinishedSpans();
    const byName = (n: string) => spans.filter((s) => s.name === n);
    // a call without a name is named for its stage too: the roots are the spans, not the generations
    const roots = byName("analyze").filter((s) => s.attributes["langfuse.observation.type"] === "span");
    assert.equal(roots.length, 2, "one root per job");
    const [map] = byName("analyze.map");
    const [score] = byName("analyze.score");
    assert.ok(map && score);
    const j1 = roots.find((r) => r.attributes["langfuse.trace.metadata.jobId"] === "j1")!;
    assert.equal(map.spanContext().traceId, j1.spanContext().traceId);
    assert.equal(score.spanContext().traceId, j1.spanContext().traceId);
    assert.equal(map.parentSpanContext?.spanId, j1.spanContext().spanId);
    const other = roots.find((s) => s !== j1)!;
    assert.notEqual(other.spanContext().traceId, j1.spanContext().traceId, "another job is another trace");

    for (const s of [j1, map, score]) {
      assert.equal(s.attributes["session.id"], "p1");
      assert.equal(s.attributes["langfuse.trace.name"], "analyze");
      assert.deepEqual(s.attributes["langfuse.trace.tags"], ["reelsaw", "analyze"]);
    }
    assert.equal(map.attributes["langfuse.observation.type"], "generation");
    assert.equal(map.attributes["langfuse.observation.model.name"], "mock-model-id");
    assert.equal(map.attributes["langfuse.version"], "map-v3");
    assert.deepEqual(JSON.parse(String(map.attributes["langfuse.observation.usage_details"])), { input: 11, output: 5 });
    assert.equal(map.attributes["langfuse.observation.output"], "ok");
    assert.equal(score.attributes["langfuse.version"], undefined);
  });

  it("records a failed call as an ERROR generation and still throws", async () => {
    const { exporter, tracer, model } = await run(async () => {
      throw new Error("rate limited");
    });
    await assert.rejects(
      withLlmContext({ projectId: "p2", stage: "refine", call: "refine.entities" }, () => generateText({ model, prompt: "x", maxRetries: 0 })),
      /rate limited/,
    );
    await tracer.shutdown();
    const [gen] = exporter.getFinishedSpans().filter((s) => s.name === "refine.entities");
    assert.ok(gen);
    assert.equal(gen.attributes["langfuse.observation.level"], "ERROR");
    assert.match(String(gen.attributes["langfuse.observation.status_message"]), /rate limited/);
    assert.equal(gen.attributes["session.id"], "p2");
  });

  it("sends decision scores to the project's session", async () => {
    const { scored, tracer } = await run(async () => ({ content: [], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }));
    assert.equal(tracer.scoring, true);
    tracer.score("p3", [{ id: "decision-7", name: "fix.accepted", value: 1, metadata: { kind: "fix.accept" } }]);
    await tracer.shutdown();
    assert.deepEqual(scored, [{ id: "decision-7", sessionId: "p3", name: "fix.accepted", value: 1, dataType: "BOOLEAN", metadata: { kind: "fix.accept" } }]);
  });

  it("leaves the global tracer provider alone", async () => {
    const before = trace.getTracerProvider();
    const { tracer } = await run(async () => ({ content: [], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }));
    assert.equal(trace.getTracerProvider(), before);
    await tracer.shutdown();
  });
});
