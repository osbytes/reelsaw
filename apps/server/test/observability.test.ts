/**
 * The observability fixes from the Sentry / PostHog / Langfuse review: AI SDK spans that never carry content, readable
 * model-call failures, quiet cache misses, a worker pool that fits its job slots, and decisions as eval scores.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { OpenTelemetry } from "@ai-sdk/otel";
import { contextAttributes, withoutContent } from "../src/ai/otel-ai.js";
import { llmErrorFields, withLlmContext, llmContext } from "../src/ai/trace.js";
import { isStorageMissing, StorageObjectMissing, withStorageLogging, type Storage } from "../src/storage/index.js";
import { poolForJobSlots } from "../src/queue/workers.js";
import { decisionScores, type ScoredDecision } from "../src/decisions/scores.js";
import { DownloadFailedError, errorKind } from "../src/pipeline/common.js";
import type { Logger } from "../src/log.js";

describe("AI SDK telemetry integration", () => {
  it("every lifecycle event reaches the integration with recording off, whatever the call asked for", () => {
    const seen: Array<Record<string, unknown>> = [];
    class Inner {
      onStart(e: Record<string, unknown>) {
        seen.push(e);
      }
      experimental_onStreamTranscriptionStart(e: Record<string, unknown>) {
        seen.push(e);
      }
      executeTool(o: { execute: () => number }) {
        return o.execute();
      }
    }
    const wrapped = withoutContent(new Inner());
    wrapped.onStart({ recordInputs: true, recordOutputs: undefined, prompt: "the transcript", functionId: "analyze.map" });
    wrapped.experimental_onStreamTranscriptionStart({ recordInputs: undefined });
    assert.equal(wrapped.executeTool({ execute: () => 7 }), 7, "non-event methods pass through untouched");
    assert.equal(seen.length, 2);
    for (const e of seen) {
      assert.equal(e.recordInputs, false);
      assert.equal(e.recordOutputs, false);
    }
    assert.equal(seen[0]!.functionId, "analyze.map", "the rest of the event is kept");
  });
  it("a real generateText through @ai-sdk/otel makes spans with the call, model, tokens and ids, never the prompt or answer", async () => {
    const { tracing } = createRequire(import.meta.url)("@opentelemetry/sdk-node");
    const exporter = new tracing.InMemorySpanExporter();
    const provider = new tracing.BasicTracerProvider({ spanProcessors: [new tracing.SimpleSpanProcessor(exporter)] });
    const integration = withoutContent(
      new OpenTelemetry({ tracer: provider.getTracer("t"), agentSpanName: "functionId", enrichSpan: () => contextAttributes(llmContext()) }),
    );
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "THE ANSWER ABOUT THE SECRET" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } },
        warnings: [],
      }),
    });
    await withLlmContext({ projectId: "p9", stage: "analyze" }, () =>
      // no recordInputs / recordOutputs here on purpose: the wrapper is what keeps them off
      generateText({ model, prompt: "A TRANSCRIPT WITH A SECRET", telemetry: { functionId: "analyze.map", integrations: [integration] } }),
    );
    const spans = exporter.getFinishedSpans();
    assert.ok(spans.length >= 1, "spans were made");
    assert.ok(
      spans.some((s: { name: string }) => s.name === "invoke_agent analyze.map"),
      `named for the call: ${spans.map((s: { name: string }) => s.name)}`,
    );
    const all = JSON.stringify(spans.map((s: { name: string; attributes: unknown }) => ({ name: s.name, attributes: s.attributes })));
    assert.doesNotMatch(all, /SECRET/, "neither the prompt nor the answer is on any span");
    assert.match(all, /"reelsaw.projectId":"p9"/);
    assert.match(all, /"gen_ai.usage.input_tokens":11/);
  });
  it("spans carry the LLM context ids, prompt version included", () => {
    withLlmContext({ projectId: "p1", stage: "analyze", jobId: "j1" }, () =>
      withLlmContext({ step: "map:3", promptVersion: "map-7" }, () => {
        assert.deepEqual(contextAttributes(llmContext()), {
          "reelsaw.projectId": "p1",
          "reelsaw.stage": "analyze",
          "reelsaw.jobId": "j1",
          "reelsaw.step": "map:3",
          "reelsaw.promptVersion": "map-7",
        });
      }),
    );
    assert.deepEqual(contextAttributes({}), {});
  });
});

describe("llmErrorFields", () => {
  it("names the class, status and provider code of a gateway failure", () => {
    const err = Object.assign(new Error("Bearer sk-… was rejected"), {
      name: "AI_APICallError",
      statusCode: 429,
      isRetryable: true,
      responseBody: JSON.stringify({ error: { type: "rate_limit_exceeded", message: "slow down" } }),
    });
    assert.deepEqual(llmErrorFields(err), { errName: "AI_APICallError", statusCode: 429, retryable: true, errCode: "rate_limit_exceeded" });
  });
  it("copes with plain errors, non-errors and junk bodies", () => {
    assert.deepEqual(llmErrorFields(new Error("x")), { errName: "Error" });
    assert.deepEqual(llmErrorFields("nope"), {});
    assert.deepEqual(llmErrorFields(Object.assign(new Error("x"), { responseBody: "{not json" })), { errName: "Error" });
  });
});

describe("storage logging", () => {
  const recorder = () => {
    const lines: Array<{ level: string; msg: string }> = [];
    const at = (level: string) => (_o: unknown, msg: string) => lines.push({ level, msg });
    const log = { debug: at("debug"), warn: at("warn") } as unknown as Logger; // only these two are called
    return { lines, log };
  };
  const failing = (err: unknown): Storage => ({ driver: "s3", ensureLocal: () => Promise.reject(err) }) as unknown as Storage; // only ensureLocal is exercised

  it("a missing object (a cache probe) is debug; anything else stays warn", async () => {
    const { lines, log } = recorder();
    const s3Missing = Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
    await withStorageLogging(failing(s3Missing), log)
      .ensureLocal("cache/asr/x.json", "/tmp/x")
      .catch(() => {});
    await withStorageLogging(failing(new StorageObjectMissing("k")), log)
      .ensureLocal("k", "/tmp/k")
      .catch(() => {});
    await withStorageLogging(failing(new Error("ENOSPC")), log)
      .ensureLocal("k", "/tmp/k")
      .catch(() => {});
    assert.deepEqual(
      lines.map((l) => `${l.level} ${l.msg}`),
      ["debug storage object missing", "debug storage object missing", "warn storage operation failed"],
    );
    assert.equal(isStorageMissing(new Error("x")), false);
  });
});

describe("worker pool sizing", () => {
  it("fits the job slots so the boot warning (slots > 2 x pool) never fires on the default", () => {
    for (const slots of [1, 13, 21, 40]) assert.ok(slots <= poolForJobSlots(slots) * 2);
    assert.equal(poolForJobSlots(21), 15);
  });
});

describe("failure kinds", () => {
  it("a transient download failure is named, not a bare Error", () => {
    assert.equal(errorKind(new DownloadFailedError("Could not download: proxy")), "DownloadFailedError");
  });
});

describe("decisionScores", () => {
  const d = (over: Partial<ScoredDecision>): ScoredDecision => ({
    id: 41,
    kind: "clip.delete",
    explicit: true,
    clipId: "c1",
    context: { origin: "ai", text: "the words of the clip" },
    before: { score: 0.82, title: "A title" },
    models: { language: "openai/gpt-4o-mini" },
    backfilled: false,
    ...over,
  });

  it("deleting an AI clip is a miss; restoring it a keep; the score id is the decision's", () => {
    const [del] = decisionScores(d({}));
    assert.deepEqual(del, {
      id: "decision-41",
      name: "clip.kept",
      value: 0,
      metadata: { kind: "clip.delete", clipId: "c1", origin: "ai", aiScore: 0.82, models: ["language=openai/gpt-4o-mini"] },
    });
    assert.equal(decisionScores(d({ kind: "clip.restore" }))[0]!.value, 1);
  });
  it("never carries the clip text or title", () => {
    const json = JSON.stringify(decisionScores(d({ kind: "clip.edit", context: { origin: "ai", fields: ["bounds", "title"], text: "secret words" } })));
    assert.doesNotMatch(json, /secret words|A title/);
  });
  it("an edit says which part missed", () => {
    const names = decisionScores(d({ kind: "clip.edit", context: { origin: "ai", fields: ["bounds", "hook"] } })).map((s) => s.name);
    assert.deepEqual(names, ["clip.untouched", "clip.bounds_kept", "clip.copy_kept"]);
  });
  it("fixes score the refine prompts; a person's own items, implicit and backfilled rows score nothing", () => {
    assert.equal(decisionScores(d({ kind: "fix.accept", context: { flagKind: "disfluency", subkind: "llm" } }))[0]!.name, "fix.accepted");
    assert.equal(decisionScores(d({ kind: "fix.reject", context: { flagKind: "entity" } }))[0]!.value, 0);
    assert.deepEqual(decisionScores(d({ kind: "fix.reject", context: { subkind: "manual" } })), []);
    assert.deepEqual(decisionScores(d({ context: { origin: "manual" } })), []);
    assert.deepEqual(decisionScores(d({ kind: "clip.edit", context: { origin: "manual", fields: ["bounds"] } })), []);
    assert.deepEqual(decisionScores(d({ kind: "clip.replaced", explicit: false })), []);
    assert.deepEqual(decisionScores(d({ backfilled: true })), []);
    assert.deepEqual(decisionScores(d({ kind: "fix.delete" })), []);
  });
});
