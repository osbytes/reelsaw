import { test } from "node:test";
import assert from "node:assert/strict";
import { clipMeta, clipsText, type MetaClip } from "../../web/src/lib/clipMeta.ts";
import { cutState } from "../../web/src/lib/cutState.ts";

const modeLabel = { face: "Follow speaker", split: "Two stacked" };
const base: MetaClip = { layout: "face", layoutOverride: null, diagnostics: null, bumpers: null };
const proj = { modeLabel, projectHasIntro: true, projectHasOutro: true };
const diag = (over: Partial<NonNullable<MetaClip["diagnostics"]>> = {}) => ({
  cuts: { applied: [], skipped: [] },
  bumpers: { introSec: 3, outroSec: 3 },
  ...over,
});

test("auto framing, inherited intro/outro with rendered lengths, pauses trimmed", () => {
  const m = clipMeta({ ...base, diagnostics: diag({ pauses: { cuts: 4, removedSec: 1.94 } }) }, proj);
  assert.equal(m.text, "Auto · Follow speaker · intro 3 s · outro 3 s · 1.9 s trimmed");
  assert.equal(m.warn, false);
});

test("not rendered yet: inherited bumpers show without lengths, nothing for what the project lacks", () => {
  assert.equal(clipMeta(base, proj).text, "Auto · Follow speaker · intro · outro");
  assert.equal(clipMeta(base, { ...proj, projectHasOutro: false }).text, "Auto · Follow speaker · intro");
  assert.equal(clipMeta({ ...base, layout: null }, { ...proj, projectHasIntro: false, projectHasOutro: false }).text, "");
});

test("the clip's own choice, opting out, and a skipped part", () => {
  assert.match(clipMeta({ ...base, bumpers: { intro: "a1", introSec: 4 } }, proj).text, /intro 4 s \(this clip\)/);
  assert.equal(clipMeta({ ...base, bumpers: { intro: null } }, proj).text, "Auto · Follow speaker · no intro · outro");
  assert.equal(clipMeta({ ...base, bumpers: { intro: null } }, { ...proj, projectHasIntro: false }).text, "Auto · Follow speaker · outro");
  const skipped = clipMeta({ ...base, diagnostics: diag({ bumpers: { introSec: 0, outroSec: 3, skipped: ["intro: too long"] } }) }, proj);
  assert.equal(skipped.text, "Auto · Follow speaker · ▲ intro skipped · outro 3 s");
  assert.equal(skipped.warn, true);
});

test("set framing across sections and kept cuts", () => {
  const m = clipMeta(
    {
      ...base,
      layoutOverride: "split",
      layoutSegments: [{ layout: "face" }, { layout: "face" }, { layout: "split" }],
      diagnostics: diag({ cuts: { applied: [1, 2], skipped: [{ start: 3, reason: "echo" }] } }),
    },
    proj,
  );
  assert.equal(m.text, "Follow speaker → Two stacked (set) · intro 3 s · outro 3 s · 2 cuts · ▲ 1 cut kept");
  assert.match(m.title, /echo/);
});

test("a cut applied without a seam check is called out, apart from cuts kept in the audio", () => {
  const applied = [
    { start: 1, end: 2, verified: true },
    { start: 5, end: 7, verified: false, reason: "re-alignment could not find it" },
    { start: 9, end: 10 },
  ];
  const m = clipMeta({ ...base, diagnostics: diag({ cuts: { applied, skipped: [{ start: 3, reason: "echo" }] } }) }, proj);
  assert.equal(m.text, "Auto · Follow speaker · intro 3 s · outro 3 s · 3 cuts · ▲ 1 cut unverified · ▲ 1 cut kept");
  assert.equal(m.warn, true);
  assert.match(m.title, /without a seam check[^\n]*\n\s+re-alignment could not find it/);
  assert.equal(clipMeta({ ...base, diagnostics: diag({ cuts: { applied: [{ start: 1, end: 2, verified: true }], skipped: [] } }) }, proj).warn, false);
});

test("cutState: applied, unverified and kept, worst across clips", () => {
  const d = {
    cuts: {
      applied: [
        { start: 5, end: 7, verified: false, reason: "r" },
        { start: 20, end: 21, verified: true },
      ],
      skipped: [{ start: 30, end: 31, reason: "echo" }],
    },
  };
  const clip = { startSec: 0, endSec: 40, diagnostics: d };
  assert.deepEqual(cutState({ start: 5.1, end: 6.9 }, [clip]), { state: "unverified", reason: "r" });
  assert.deepEqual(cutState({ start: 20, end: 21 }, [clip]), { state: "applied" });
  assert.deepEqual(cutState({ start: 30, end: 31 }, [clip]), { state: "skipped", reason: "echo" });
  assert.equal(cutState({ start: 35, end: 36 }, [clip]), null);
  assert.equal(cutState({ start: 5, end: 6 }, [{ startSec: 0, endSec: 40, diagnostics: null }]), null);
  assert.equal(cutState({ start: 20, end: 21 }, [clip, { startSec: 0, endSec: 40, diagnostics: d }])?.state, "applied");
});

test("clipsText joins clips with a rule", () => {
  assert.equal(
    clipsText([
      { title: "A", caption: "c", hashtags: ["x", "y"] },
      { title: "B", caption: "", hashtags: [] },
    ]),
    "A\n\nc\n\n#x #y\n\n---\n\nB",
  );
});
