/**
 * What reaches Sentry and PostHog: the product-event allowlist, error kinds, MCP client names, quota refusals,
 * the heartbeat monitor and the orphan-span sampler. No docker needed.
 * Run: pnpm --filter @reelsaw/server exec node --import tsx --test test/telemetry-events.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SpanKind } from "@opentelemetry/api";
import { productEvent } from "../src/uow.js";
import { errorKind } from "../src/pipeline/common.js";
import { QuotaError, QuotaExceededError, trackQuotaRefusal } from "../src/quota.js";
import { JobInterruptedError } from "../src/queue/reconcile.js";
import { mcpClientName } from "../src/mcp.js";
import { heartbeatMonitor } from "../src/ops/workers.js";
import { dropOrphanClientSpans } from "../src/otel.js";

describe("productEvent", () => {
  it("never passes a title or an error message to PostHog", () => {
    const created = productEvent("project.created", { title: "My private video", sourceType: "url" });
    assert.deepEqual(created, { event: "project.created", properties: { sourceType: "url" } });
    const failed = productEvent("project.failed", {
      stage: "ingest",
      error: "Download failed: https://example.com/secret",
      errorKind: "NonRetryableError",
      runSec: 12,
    });
    assert.deepEqual(failed, { event: "project.failed", properties: { stage: "ingest", errorKind: "NonRetryableError", runSec: 12 } });
    const clip = productEvent("clip.failed", { clipId: "c1", error: "ffmpeg exited with 1: …", errorKind: "Error" });
    assert.deepEqual(clip?.properties, { clipId: "c1", errorKind: "Error" });
  });

  it("a run stopped by deleting the project is project.cancelled", () => {
    const e = productEvent("project.failed", {
      stage: "analyze",
      error: "Stopped because the project was deleted. Retry to continue.",
      cancelled: true,
      runSec: 40,
    });
    assert.equal(e?.event, "project.cancelled");
    assert.equal(e?.properties.error, undefined);
  });

  it("drops a long string even under an allowed key, and ignores events that are not product events", () => {
    assert.deepEqual(productEvent("project.failed", { stage: "x".repeat(65) })?.properties, {});
    assert.equal(productEvent("stage.started", { stage: "ingest" }), null);
    assert.equal(productEvent("clip.retrying", { clipId: "c1" }), null);
  });
});

describe("errorKind", () => {
  it("names the failure's class, never its message", () => {
    assert.equal(errorKind(new QuotaExceededError("This video is 57 minutes…")), "QuotaExceededError");
    assert.equal(errorKind(new JobInterruptedError()), "JobInterruptedError");
    class StageTimeout extends Error {}
    assert.equal(errorKind(new StageTimeout("slow")), "StageTimeout");
    assert.equal(errorKind(new Error("plain")), "Error");
    assert.equal(errorKind("a string"), "unknown");
  });
});

describe("quota refusals", () => {
  it("carry the limit that refused, and the event has no message", () => {
    const sent: Array<[string, string, Record<string, unknown> | undefined]> = [];
    const telemetry = { capture: (e: string, id: string, p?: Record<string, unknown>) => void sent.push([e, id, p]) };
    trackQuotaRefusal(telemetry, "u1", new QuotaError("You have 20 requests queued…", undefined, "MAX_LIVE_JOBS_PER_USER"), "web");
    trackQuotaRefusal(
      telemetry,
      "u1",
      new QuotaError("Monthly limit…", { key: "MAX_SOURCE_MINUTES_PER_MONTH", primary: { kind: "upgrade", label: "Upgrade", href: "https://x" } }),
      "mcp",
    );
    assert.deepEqual(sent, [
      ["quota.refused", "u1", { key: "MAX_LIVE_JOBS_PER_USER", surface: "web" }],
      ["quota.refused", "u1", { key: "MAX_SOURCE_MINUTES_PER_MONTH", surface: "mcp", offer: "upgrade" }],
    ]);
  });
});

describe("mcpClientName", () => {
  it("keeps the User-Agent's product token only", () => {
    assert.equal(mcpClientName("claude-code/2.1.4 (darwin; arm64)"), "claude-code");
    assert.equal(mcpClientName("Cursor/1.2"), "cursor");
    assert.equal(mcpClientName("node"), "node");
    assert.equal(mcpClientName(null), "unknown");
    assert.equal(mcpClientName("  spaced"), "unknown");
    assert.equal(mcpClientName("a".repeat(80)).length, 40);
  });
});

describe("heartbeatMonitor", () => {
  it("one monitor per pinned worker, else per role", () => {
    assert.equal(heartbeatMonitor({ WORKER_ID: "worker-a", RUN_HTTP: false, RUN_WORKERS: true }), "heartbeat-worker-a");
    assert.equal(heartbeatMonitor({ WORKER_ID: undefined, RUN_HTTP: false, RUN_WORKERS: true }), "heartbeat-worker");
    assert.equal(heartbeatMonitor({ WORKER_ID: " ", RUN_HTTP: true, RUN_WORKERS: false }), "heartbeat-api");
  });
});

describe("dropOrphanClientSpans", () => {
  it("drops a parentless client span and defers everything else", () => {
    const inner = { shouldSample: () => ({ decision: 2 }) };
    const s = dropOrphanClientSpans(inner, 0);
    assert.deepEqual(s.shouldSample({}, "t", "S3.GetObject", SpanKind.CLIENT, {}, []), { decision: 0 });
    assert.deepEqual(s.shouldSample({}, "t", "GET /api/trpc/projects.list", SpanKind.SERVER, {}, []), { decision: 2 });
    assert.deepEqual(s.shouldSample({}, "t", "pipeline.render", SpanKind.INTERNAL, {}, []), { decision: 2 });
  });
});
