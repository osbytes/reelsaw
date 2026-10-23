/** The rows asset_refs should hold for a clip and a project (pure). Run: node --import tsx --test test/asset-refs.test.ts */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { refsForClip, refsForProject } from "../src/library/refs.js";

const sorted = (rows: ReturnType<typeof refsForClip>) => [...rows].sort((a, b) => `${a.role}${a.assetId}`.localeCompare(`${b.role}${b.assetId}`));

describe("refsForClip", () => {
  it("a clip with nothing of its own has no rows (it inherits the project's)", () => {
    assert.deepEqual(refsForClip("p", { id: "c", bumpers: null }), []);
    assert.deepEqual(refsForClip("p", { id: "c", bumpers: { introSec: 3 } as never }), []);
  });

  it("its own intro and outro strings become rows; none, inherit and default do not", () => {
    assert.deepEqual(sorted(refsForClip("p", { id: "c", bumpers: { intro: "a", outro: "b" } })), [
      { assetId: "a", projectId: "p", clipId: "c", role: "intro" },
      { assetId: "b", projectId: "p", clipId: "c", role: "outro" },
    ]);
    assert.deepEqual(refsForClip("p", { id: "c", bumpers: { intro: null, outro: "none" } }), []);
    assert.deepEqual(refsForClip("p", { id: "c", bumpers: { intro: "inherit", outro: "default" } }), []);
  });

  it("asset and audio layers are layer rows, text layers are not", () => {
    const layers = [
      { kind: "asset", id: "l1", assetId: "logo", start: 0, end: 5, x: 0.5, y: 0.5 },
      { kind: "text", id: "l2", text: "hi", start: 0, end: 5, x: 0.5, y: 0.5 },
      { kind: "audio", id: "l3", assetId: "whoosh", start: 1, end: 2 },
    ];
    assert.deepEqual(sorted(refsForClip("p", { id: "c", layers })), [
      { assetId: "logo", projectId: "p", clipId: "c", role: "layer" },
      { assetId: "whoosh", projectId: "p", clipId: "c", role: "layer" },
    ]);
  });

  it("legacy overlays and audio rows read as layers", () => {
    const rows = refsForClip("p", {
      id: "c",
      overlays: [{ id: "o1", assetId: "sticker", start: 0, end: 4, x: 0.5, y: 0.5 }, { id: "o2", kind: "text", text: "t", start: 0, end: 4, x: 0.5, y: 0.5 }],
      audio: [{ id: "m1", assetId: "song", start: 0, end: 10 }],
    });
    assert.deepEqual(sorted(rows).map((r) => [r.assetId, r.role]), [["song", "layer"], ["sticker", "layer"]]);
    // a single-object audio column from before several tracks
    assert.deepEqual(refsForClip("p", { id: "c", audio: { assetId: "old", start: 0, end: 10 } as never }).map((r) => r.assetId), ["old"]);
  });

  it("layers win over the old columns once a clip has them", () => {
    const rows = refsForClip("p", { id: "c", layers: [], overlays: [{ id: "o1", assetId: "stale", start: 0, end: 4, x: 0.5, y: 0.5 }] });
    assert.deepEqual(rows, []);
  });

  it("the same asset twice in one role is one row; in two roles is two", () => {
    const rows = refsForClip("p", {
      id: "c",
      bumpers: { intro: "a" },
      layers: [
        { kind: "asset", id: "l1", assetId: "a", start: 0, end: 5, x: 0.5, y: 0.5 },
        { kind: "asset", id: "l2", assetId: "a", start: 5, end: 9, x: 0.5, y: 0.5 },
      ],
    });
    assert.deepEqual(sorted(rows).map((r) => r.role), ["intro", "layer"]);
  });
});

describe("refsForProject", () => {
  it("names the settings' intro and outro with no clip", () => {
    assert.deepEqual(refsForProject({ id: "p", settings: { introAssetId: "a", outroAssetId: "b" } }), [
      { assetId: "a", projectId: "p", clipId: null, role: "intro" },
      { assetId: "b", projectId: "p", clipId: null, role: "outro" },
    ]);
  });
  it("nothing for none, null or missing settings", () => {
    assert.deepEqual(refsForProject({ id: "p", settings: { introAssetId: null } }), []);
    assert.deepEqual(refsForProject({ id: "p", settings: null }), []);
    assert.deepEqual(refsForProject({ id: "p" }), []);
  });
  it("inherit vs own: the project row and the clip's own row are separate rows", () => {
    const project = refsForProject({ id: "p", settings: { introAssetId: "a" } });
    const inheriting = refsForClip("p", { id: "c1", bumpers: null });
    const own = refsForClip("p", { id: "c2", bumpers: { intro: "b" } });
    assert.equal(project.length + inheriting.length + own.length, 2);
    assert.equal(own[0]!.assetId, "b");
  });
});
