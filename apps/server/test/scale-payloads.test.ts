import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROJECT_EVENT_TYPES } from "@reelsaw/shared";
import { escapeLike } from "../src/search.js";
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
