import { test } from "node:test";
import assert from "node:assert/strict";
import { clipMeta, clipsText, type MetaClip } from "../../web/src/lib/clipMeta.ts";

const modeLabel = { face: "Follow speaker", split: "Two stacked" };
const base: MetaClip = { layout: "face", layoutOverride: null, diagnostics: null, bumpers: null };
const proj = { modeLabel, projectHasIntro: true, projectHasOutro: true };
const diag = (over: Partial<NonNullable<MetaClip["diagnostics"]>> = {}) => ({ cuts: { applied: [], skipped: [] }, bumpers: { introSec: 3, outroSec: 3 }, ...over });

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
  const m = clipMeta({ ...base, layoutOverride: "split", layoutSegments: [{ layout: "face" }, { layout: "face" }, { layout: "split" }], diagnostics: diag({ cuts: { applied: [1, 2], skipped: [{ start: 3, reason: "echo" }] } }) }, proj);
  assert.equal(m.text, "Follow speaker → Two stacked (set) · intro 3 s · outro 3 s · 2 cuts · ▲ 1 cut kept");
  assert.match(m.title, /echo/);
});

test("clipsText joins clips with a rule", () => {
  assert.equal(clipsText([{ title: "A", caption: "c", hashtags: ["x", "y"] }, { title: "B", caption: "", hashtags: [] }]), "A\n\nc\n\n#x #y\n\n---\n\nB");
});
