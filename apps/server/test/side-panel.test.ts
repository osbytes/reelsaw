/**
 * Side panel detection on synthetic samples: a speaker beside an app screen or title card is framed
 * as a stack (panel on top, speaker below); anything doubtful stays a face crop.
 * Run: pnpm --filter @reelsaw/server test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectSidePanel, panelReason, frameVote, type PBox, type PanelSample } from "../src/pipeline/side-panel.js";
import { decideLayout, segmentLayouts, type FaceSample } from "../src/pipeline/layout.js";

const cfg = { LAYOUT_MIN_FACE_RATIO: 0.6, LAYOUT_MIN_FACE_SIZE: 0.18 };
const face = (x1: number, x2: number, h = 0.35): PBox & { score: number } => ({ x1, x2, y1: 0.2, y2: 0.2 + h, score: 0.9 });
const line = (x1: number, x2: number, y: number): PBox => ({ x1, x2, y1: y, y2: y + 0.035 });
/** `n` lines of text stacked from y0 in the column x1..x2 */
const column = (x1: number, x2: number, y0: number, n: number, gap = 0.08): PBox[] => Array.from({ length: n }, (_, i) => line(x1, x2, y0 + i * gap));

function frames(count: number, make: (i: number) => Partial<PanelSample> & { box?: PBox & { score: number } }): Array<PanelSample & FaceSample> {
  return Array.from({ length: count }, (_, i) => {
    const m = make(i);
    const box = m.box ?? face(0.15, 0.4);
    return { t: i / 4, box, boxes: [box], text: m.text ?? [], ...(m.divider ? { divider: m.divider } : {}) } as PanelSample & FaceSample;
  });
}

describe("side panel", () => {
  it("app screen on the right: text beside the speaker, backed by a divider", () => {
    const s = frames(40, () => ({ text: column(0.72, 0.95, 0.1, 10), divider: { x: 0.68, s: 0.5 } }));
    const d = decideLayout(s, cfg);
    assert.equal(d.layout, "stack");
    assert.equal(d.panel?.side, "right");
    assert.equal(d.panel?.x1, 0.68);
    assert.equal(d.panel?.x2, 1);
    assert.match(d.reason, /^app panel beside the speaker \(right 32%\)$/);
  });

  it("title card on the left: a few lines, a divider confirms them", () => {
    const s = frames(40, () => ({ box: face(0.62, 0.86), text: column(0.07, 0.45, 0.36, 3, 0.12), divider: { x: 0.495, s: 0.49 } }));
    const d = decideLayout(s, cfg);
    assert.equal(d.layout, "stack");
    assert.equal(d.panel?.side, "left");
    assert.equal(d.panel?.x2, 0.495);
    assert.match(d.reason, /^title card beside the speaker \(left 50%\)$/);
  });

  it("text alone is enough when it fills the height, and the panel starts at the text", () => {
    const s = frames(40, () => ({ box: face(0.55, 0.85), text: column(0.05, 0.3, 0.08, 10) }));
    const p = detectSidePanel(s);
    assert.equal(p.panel?.side, "left");
    assert.equal(p.evidence, "text");
    assert.ok(p.panel!.x2 > 0.25 && p.panel!.x2 < 0.35);
  });

  it("a strong straight edge with no readable text (charts, photos) still counts", () => {
    const s = frames(40, () => ({ divider: { x: 0.66, s: 0.55 } }));
    const p = detectSidePanel(s);
    assert.equal(p.panel?.side, "right");
    assert.equal(p.evidence, "divider");
  });

  it("an ordinary room edge (weak divider) is not a panel", () => {
    const s = frames(40, () => ({ divider: { x: 0.7, s: 0.27 } }));
    assert.equal(detectSidePanel(s).panel, undefined);
    assert.equal(decideLayout(s, cfg).layout, "face");
  });

  it("text under the speaker (a lower-third caption) is not a panel", () => {
    const s = frames(40, () => ({ text: [line(0.1, 0.5, 0.78), line(0.12, 0.48, 0.84)] }));
    const d = decideLayout(s, cfg);
    assert.equal(d.layout, "face");
    assert.equal(d.panel, undefined);
  });

  it("text on both sides of the speaker is not a panel", () => {
    const s = frames(40, () => ({ box: face(0.4, 0.62), text: [...column(0.72, 0.95, 0.1, 10), ...column(0.03, 0.3, 0.1, 10)], divider: { x: 0.68, s: 0.5 } }));
    assert.equal(decideLayout(s, cfg).layout, "face");
  });

  it("a panel narrower than 22% of the frame is not worth a half of the screen", () => {
    const s = frames(40, () => ({ text: column(0.84, 0.98, 0.1, 10), divider: { x: 0.82, s: 0.5 } }));
    const p = detectSidePanel(s);
    assert.equal(p.panel, undefined);
    assert.equal(decideLayout(s, cfg).layout, "face");
  });

  it("a panel that is on screen for under 60% of the frames keeps the face crop", () => {
    const s = frames(40, (i) => (i < 20 ? { text: column(0.72, 0.95, 0.1, 10), divider: { x: 0.68, s: 0.5 } } : {}));
    const p = detectSidePanel(s);
    assert.equal(p.panel, undefined);
    assert.match(p.rejected ?? "", /only 50%/);
  });

  it("a face under 20% of the frame height is left to the existing stack rules", () => {
    const s = frames(40, () => ({ box: face(0.15, 0.3, 0.19), text: column(0.72, 0.95, 0.1, 10), divider: { x: 0.68, s: 0.5 } }));
    assert.equal(detectSidePanel(s).rejected, "face under 20% tall");
  });

  it("a panel edge that wanders is not trusted", () => {
    const s = frames(40, (i) => ({ text: column(0.72, 0.95, 0.1, 10), divider: { x: 0.6 + (i % 4) * 0.06, s: 0.5 } }));
    assert.equal(detectSidePanel(s).panel, undefined);
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

  it("panelReason names what it found", () => {
    assert.equal(panelReason({ side: "right", x1: 0.68, x2: 1 }, { evidence: "divider", panelLines: 0 }), "panel beside the speaker (right 32%)");
  });
});
