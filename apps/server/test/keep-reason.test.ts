/** Which clips survive a re-analyze. Run: node --import tsx --test test/keep-reason.test.ts (no stack needed) */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keepReason } from "../src/projects/service.js";

const ai = { origin: "ai" as const, editedAt: null, layoutOverride: null, layoutSections: null, style: null, bumpers: null };

describe("keepReason", () => {
  it("replaces an untouched AI pick", () => assert.equal(keepReason(ai), null));
  it("keeps clips the user made", () => {
    assert.equal(keepReason({ ...ai, origin: "manual" }), "manual");
    assert.equal(keepReason({ ...ai, origin: "manual-ai" }), "manual");
  });
  it("keeps any user edit", () => {
    assert.equal(keepReason({ ...ai, editedAt: new Date() }), "edited");
    assert.equal(keepReason({ ...ai, layoutOverride: "fit" }), "edited");
    assert.equal(keepReason({ ...ai, layoutSections: [{ start: 0, end: 5, mode: "fit" }] as never }), "edited");
    assert.equal(keepReason({ ...ai, style: { fontSize: 60 } as never }), "edited");
    assert.equal(keepReason({ ...ai, bumpers: { intro: null } }), "edited");
  });
  it("treats empty overrides as untouched", () => {
    assert.equal(keepReason({ ...ai, layoutSections: [] }), null);
    assert.equal(keepReason({ ...ai, style: {} as never }), null);
  });
});
