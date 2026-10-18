import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROJECT_EVENT_TYPES } from "@reelsaw/shared";
import { escapeLike } from "../src/search.js";
import { decodeNotice, encodeProgressNotice, isProgressNotice, progressEvent, PROGRESS_NOTICE_MAX, type ProgressNotice } from "../src/events.js";
import { scopesFor, INVALIDATION } from "../../web/src/lib/invalidation.js";

describe("palette search", () => {
  it("escapes LIKE wildcards and the escape character", () => {
    assert.equal(escapeLike("100%_done\\"), "100\\%\\_done\\\\");
    assert.equal(escapeLike("plain"), "plain");
  });
});

describe("event invalidation table", () => {
  const ev = (type: (typeof PROJECT_EVENT_TYPES)[number], payload = {}) => scopesFor({ type, payload });
  it("covers every event type", () => {
    for (const t of PROJECT_EVENT_TYPES) assert.ok(t in INVALIDATION, t);
  });
  it("clip events never touch the transcript", () => {
    for (const t of ["clip.created", "clip.rendering", "clip.done", "clip.failed", "clip.retrying"] as const) assert.ok(!ev(t).includes("transcript"), t);
  });
  it("progress refreshes nothing", () => assert.deepEqual(ev("stage.progress"), []));
  it("only transcribe and refine completions refresh the transcript", () => {
    assert.ok(ev("stage.completed", { stage: "refine" }).includes("transcript"));
    assert.ok(ev("stage.completed", { stage: "transcribe" }).includes("transcript"));
    assert.ok(!ev("stage.completed", { stage: "render" }).includes("transcript"));
  });
  it("a saved transcript edit refreshes the transcript, and clips only when it re-renders", () => {
    assert.deepEqual(ev("stage.started", { stage: "review", rerendered: 0 }), ["transcript"]);
    assert.ok(ev("stage.started", { stage: "review", rerendered: 2 }).includes("project"));
  });
});

describe("progress NOTIFY payload", () => {
  const tick = { projectId: "p1", stage: "render", progress: 0.123456789, message: "Rendering clip 3", clipId: "c9" };
  it("round-trips inline and becomes a live-only stage.progress message", () => {
    const json = encodeProgressNotice(tick);
    assert.deepEqual(JSON.parse(json), { kind: "progress", projectId: "p1", clipId: "c9", stage: "render", progress: 0.1235, message: "Rendering clip 3" });
    const n = decodeNotice(json)!;
    assert.ok(isProgressNotice(n));
    const e = progressEvent(n as ProgressNotice, new Date("2026-01-01T00:00:00Z"));
    assert.equal(e.id, 0);
    assert.equal(e.type, "stage.progress");
    assert.deepEqual(e.payload, { stage: "render", progress: 0.1235, message: "Rendering clip 3", clipId: "c9" });
  });
  it("stays within the size cap however long the message is", () => {
    const json = encodeProgressNotice({ ...tick, message: "x".repeat(20_000) });
    assert.ok(Buffer.byteLength(json) <= PROGRESS_NOTICE_MAX);
    assert.ok(decodeNotice(json));
  });
  it("still decodes id notices and rejects junk", () => {
    assert.deepEqual(decodeNotice('{"id":5,"projectId":"p1"}'), { id: 5, projectId: "p1" });
    assert.equal(decodeNotice("not json"), null);
    assert.equal(decodeNotice('{"kind":"progress","projectId":"p"}'), null);
  });
});
