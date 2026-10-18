/**
 * Side panel detection on synthetic samples: a speaker beside an app screen or title card is framed
 * as a stack (panel on top, speaker below); anything doubtful stays a face crop.
 * Run: pnpm --filter @reelsaw/server test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { voteTrace, detectContentRegion, contentReason, frameVote, type PBox, type RegionSample } from "../src/pipeline/content-region.js";
import { contentSide } from "@reelsaw/shared";
import { newLayoutDiag, decideLayout, segmentLayouts, type FaceSample } from "../src/pipeline/layout.js";

const cfg = { LAYOUT_MIN_FACE_RATIO: 0.6, LAYOUT_MIN_FACE_SIZE: 0.18 };
const face = (x1: number, x2: number, h = 0.35): PBox & { score: number } => ({ x1, x2, y1: 0.2, y2: 0.2 + h, score: 0.9 });
const line = (x1: number, x2: number, y: number): PBox => ({ x1, x2, y1: y, y2: y + 0.035 });
/** `n` lines of text stacked from y0 in the column x1..x2 */
const column = (x1: number, x2: number, y0: number, n: number, gap = 0.08): PBox[] => Array.from({ length: n }, (_, i) => line(x1, x2, y0 + i * gap));

function frames(count: number, make: (i: number) => Partial<RegionSample> & { box?: PBox & { score: number } }): Array<RegionSample & FaceSample> {
  return Array.from({ length: count }, (_, i) => {
    const m = make(i);
    const box = m.box ?? face(0.15, 0.4);
    return { t: i / 4, box, boxes: [box], text: m.text ?? [], ...(m.divider ? { divider: m.divider } : {}) } as RegionSample & FaceSample;
  });
}

describe("content region", () => {
  it("app screen on the right: text beside the speaker, backed by a divider", () => {
    const s = frames(40, () => ({ text: column(0.72, 0.95, 0.1, 10), divider: { x: 0.68, s: 0.5 } }));
    const d = decideLayout(s, cfg);
    assert.equal(d.layout, "stack");
    assert.equal(contentSide(d.content!), "right");
    assert.equal(d.content?.x1, 0.68);
    assert.equal(d.content?.x2, 1);
    assert.match(d.reason, /^app panel beside the speaker \(right 32%\)$/);
  });

  it("title card on the left: a few lines, a divider confirms them", () => {
    const s = frames(40, () => ({ box: face(0.62, 0.86), text: column(0.07, 0.45, 0.36, 3, 0.12), divider: { x: 0.495, s: 0.49 } }));
    const d = decideLayout(s, cfg);
    assert.equal(d.layout, "stack");
    assert.equal(contentSide(d.content!), "left");
    assert.equal(d.content?.x2, 0.495);
    assert.match(d.reason, /^title card beside the speaker \(left 50%\)$/);
  });

  it("text alone is enough when it fills the height, and the panel starts at the text", () => {
    const s = frames(40, () => ({ box: face(0.55, 0.85), text: column(0.05, 0.3, 0.08, 10) }));
    const p = detectContentRegion(s);
    assert.equal(contentSide(p.content!), "left");
    assert.equal(p.evidence, "text");
    assert.ok(p.content!.x2 > 0.25 && p.content!.x2 < 0.35);
  });

  it("a strong straight edge with no readable text (charts, photos) still counts", () => {
    const s = frames(40, () => ({ divider: { x: 0.66, s: 0.55 } }));
    const p = detectContentRegion(s);
    assert.equal(contentSide(p.content!), "right");
    assert.equal(p.evidence, "divider");
  });

  it("an ordinary room edge (weak divider) is not a panel", () => {
    const s = frames(40, () => ({ divider: { x: 0.7, s: 0.27 } }));
    assert.equal(detectContentRegion(s).panel, undefined);
    assert.equal(decideLayout(s, cfg).layout, "face");
  });

  it("text under the speaker (a lower-third caption) is not a panel", () => {
    const s = frames(40, () => ({ text: [line(0.1, 0.5, 0.78), line(0.12, 0.48, 0.84)] }));
    const d = decideLayout(s, cfg);
    assert.equal(d.layout, "face");
    assert.equal(d.content, undefined);
  });

  it("text on both sides of the speaker is not a panel", () => {
    const s = frames(40, () => ({ box: face(0.4, 0.62), text: [...column(0.72, 0.95, 0.1, 10), ...column(0.03, 0.3, 0.1, 10)], divider: { x: 0.68, s: 0.5 } }));
    assert.equal(decideLayout(s, cfg).layout, "face");
  });

  it("a panel narrower than 22% of the frame is not worth a half of the screen", () => {
    const s = frames(40, () => ({ text: column(0.84, 0.98, 0.1, 10), divider: { x: 0.82, s: 0.5 } }));
    const p = detectContentRegion(s);
    assert.equal(p.content, undefined);
    assert.equal(decideLayout(s, cfg).layout, "face");
  });

  it("a panel that is on screen for under 60% of the frames keeps the face crop", () => {
    const s = frames(40, (i) => (i < 20 ? { text: column(0.72, 0.95, 0.1, 10), divider: { x: 0.68, s: 0.5 } } : {}));
    const p = detectContentRegion(s);
    assert.equal(p.content, undefined);
    assert.match(p.rejected ?? "", /only 50%/);
  });

  it("a face under 20% of the frame height is left to the existing stack rules", () => {
    const s = frames(40, () => ({ box: face(0.15, 0.3, 0.19), text: column(0.72, 0.95, 0.1, 10), divider: { x: 0.68, s: 0.5 } }));
    assert.equal(detectContentRegion(s).rejected, "face under 20% tall");
  });

  it("a panel edge that wanders is not trusted", () => {
    const s = frames(40, (i) => ({ text: column(0.72, 0.95, 0.1, 10), divider: { x: 0.6 + (i % 4) * 0.06, s: 0.5 } }));
    assert.equal(detectContentRegion(s).panel, undefined);
  });

  it("frameVote ignores a panel that would overlap the speaker", () => {
    const s = frames(1, () => ({ box: face(0.5, 0.75), divider: { x: 0.6, s: 0.5 } }))[0]!;
    assert.equal(frameVote(s), null);
  });

  it("the panel appearing mid-clip becomes its own segment", () => {
    const s = frames(80, (i) => (i < 24 ? {} : { box: face(0.15, 0.4), text: column(0.72, 0.95, 0.1, 10), divider: { x: 0.68, s: 0.5 } }));
    const segs = segmentLayouts(s, cfg, [], 20);
    assert.deepEqual(segs.map((x) => x.decision.layout), ["face", "stack"]);
    assert.ok(Math.abs(segs[1]!.start - 6) < 0.6);
  });

  it("a short gap in the evidence inside a continuous card is held (divider stays at the same x)", () => {
    const card = { box: face(0.62, 0.86), text: column(0.07, 0.45, 0.36, 3, 0.12), divider: { x: 0.495, s: 0.49 } };
    // 3 s where OCR lost the title and the divider is soft (0.35): no vote on its own
    const s = frames(80, (i) => (i >= 28 && i < 40 ? { box: face(0.62, 0.86), divider: { x: 0.495, s: 0.35 } } : card));
    const segs = segmentLayouts(s, cfg, [], 20);
    assert.deepEqual(segs.map((x) => x.decision.layout), ["stack"]);
    assert.equal(contentSide(segs[0]!.decision.content!), "left");
  });

  it("a gap with no divider is not held", () => {
    const card = { box: face(0.62, 0.86), text: column(0.07, 0.45, 0.36, 3, 0.12), divider: { x: 0.495, s: 0.49 } };
    const s = frames(80, (i) => (i >= 28 && i < 40 ? { box: face(0.43, 0.58) } : card));
    assert.deepEqual(segmentLayouts(s, cfg, [], 20).map((x) => x.decision.layout), ["stack", "face", "stack"]);
  });

  it("a panel that ends before the clip does is not extended over the short tail", () => {
    const card = { box: face(0.62, 0.86), text: column(0.07, 0.45, 0.36, 3, 0.12), divider: { x: 0.495, s: 0.49 } };
    const s = frames(80, (i) => (i < 72 ? card : { box: face(0.43, 0.58) })); // card gone for the last 2 s
    const segs = segmentLayouts(s, cfg, [18], 20);
    assert.deepEqual(segs.map((x) => x.decision.layout), ["stack", "face"]);
    assert.ok(Math.abs(segs[0]!.end - 18) < 0.3);
  });

  it("a panel that appears under 2.5 s before the end stays a face crop", () => {
    const s = frames(80, (i) => (i < 72 ? { box: face(0.43, 0.58) } : { box: face(0.62, 0.86), text: column(0.07, 0.45, 0.36, 3, 0.12), divider: { x: 0.495, s: 0.49 } }));
    assert.deepEqual(segmentLayouts(s, cfg, [], 20).map((x) => x.decision.layout), ["face"]);
  });

  it("no face means fit, never a panel stack", () => {
    const s = frames(40, () => ({ text: column(0.1, 0.3, 0.1, 6), divider: { x: 0.5, s: 0.5 } })).map((x) => ({ ...x, box: null, boxes: [] }));
    assert.deepEqual(segmentLayouts(s as never, cfg, [], 10).map((x) => x.decision.layout), ["fit"]);
  });

  it("reports why a candidate run was dropped", () => {
    const s = frames(80, (i) => (i < 4 ? { box: face(0.62, 0.86), text: column(0.07, 0.45, 0.36, 3, 0.12), divider: { x: 0.495, s: 0.49 } } : { box: face(0.43, 0.58) }));
    const diag = newLayoutDiag();
    segmentLayouts(s, cfg, [], 20, undefined, diag);
    assert.equal(diag.candidates.length, 1);
    assert.equal(diag.candidates[0]!.kept, false);
    assert.match(diag.candidates[0]!.reason ?? "", /shorter than/);
    assert.equal(voteTrace(s[0]!).vote, "text+divider");
    assert.equal(voteTrace(s[10]!).vote, null);
  });

  it("contentReason names what it found", () => {
    assert.equal(contentReason({ x1: 0.68, y1: 0, x2: 1, y2: 1 }, { evidence: "divider", lines: 0 }), "content beside the speaker (right 32%)");
  });
});
