/**
 * Content region: a source shot that is a side-by-side composite, a big talking head on one side and
 * an app screen, slide or title card on the other. A `face` crop follows the speaker and throws the
 * content away; this module finds the region next to the speaker so the layout can show it on top
 * and the speaker below. Today the region is a full-height strip on one side, found from text beside
 * the face and a straight vertical divider; the layout only sees a `ContentRegion` (x1,y1,x2,y2).
 *
 * Pure functions over the samples the render already takes (face boxes at ~4 fps, text boxes at
 * ~2 fps attached to the nearest sample, and a per-frame vertical-divider probe computed from the
 * frames decoded for face detection). Precision over recall: any doubt keeps `face`.
 */

import { contentSide, type ContentRegion } from "@reelsaw/shared";

export interface PBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Strongest vertical edge of a frame: normalized x and its strength (mean |Δluma| across rows, 0..1). */
export interface DividerProbe {
  x: number;
  s: number;
}

export interface RegionSample {
  t: number;
  box: PBox | null;
  /** all text boxes seen near this sample (paragraphs included); undefined = text was not scanned */
  text?: PBox[];
  divider?: DividerProbe;
}

export type ContentSide = "left" | "right";

export const REGION = {
  /** text must lie beyond the face edge by at least this much (normalized x) */
  margin: 0.05,
  /** share of sampled frames that must show the region */
  minShare: 0.6,
  /** text beside the face spans this much of the frame height on its own … */
  minTextSpan: 0.35,
  /** … or this much when a divider backs it */
  minTextSpanWithDivider: 0.2,
  /** a divider within this distance of the text's inner bound backs the text */
  dividerNearText: 0.12,
  /** divider strength that backs text / that counts on its own */
  dividerMin: 0.3,
  dividerAlone: 0.4,
  /** region edge may wander this much across frames */
  stable: 0.04,
  minWidth: 0.22,
  minFaceSize: 0.2,
  /** gap kept between the face and the region edge */
  faceGap: 0.02,
};

export interface ContentSignals {
  /** share of sampled frames that show the region on the winning side */
  share: number;
  side?: ContentSide;
  evidence?: "text" | "divider" | "text+divider";
  faceSize: number;
  /** share of frames with text beside the face, per side */
  textBeside: { left: number; right: number };
  /** median vertical extent of that text */
  textSpan: number;
  /** median text lines inside the region (a title card has a few, an app screen many) */
  lines: number;
  /** stable divider x and the share of frames that agree on it */
  dividerX?: number;
  dividerShare: number;
  rejected?: string;
}

export interface FrameVote {
  side: ContentSide;
  /** region edge nearest the face */
  edge: number;
  evidence: "text" | "divider" | "text+divider";
  span: number;
  /** text lines inside the region */
  lines: number;
}

const median = (xs: number[]) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);

/** What one frame says: a content region on a side (with its inner edge), or nothing. */
export function frameVote(s: RegionSample): FrameVote | null {
  const f = s.box;
  if (!f) return null;
  const right = (s.text ?? []).filter((b) => b.x1 >= f.x2 + REGION.margin);
  const left = (s.text ?? []).filter((b) => b.x2 <= f.x1 - REGION.margin);
  // text on both sides of the speaker is a scene (captions, signs, a lower third spread wide), not a content region
  const textSide: ContentSide | null = right.length && !left.length ? "right" : left.length && !right.length ? "left" : null;
  const d = s.divider && s.divider.s >= REGION.dividerMin ? s.divider : null;
  const dividerSide: ContentSide | null = d ? (d.x >= f.x2 + REGION.faceGap ? "right" : d.x <= f.x1 - REGION.faceGap ? "left" : null) : null;
  // a divider only counts when its far side is wide enough to be a region
  const dividerOk = d && dividerSide && (dividerSide === "right" ? 1 - d.x : d.x) >= REGION.minWidth;

  if (textSide) {
    const boxes = textSide === "right" ? right : left;
    const span = Math.max(...boxes.map((b) => b.y2)) - Math.min(...boxes.map((b) => b.y1));
    const inner = textSide === "right" ? Math.min(...boxes.map((b) => b.x1)) : Math.max(...boxes.map((b) => b.x2));
    const backed = !!(dividerOk && dividerSide === textSide && (textSide === "right" ? d!.x <= inner + 0.01 && d!.x >= inner - REGION.dividerNearText : d!.x >= inner - 0.01 && d!.x <= inner + REGION.dividerNearText));
    if (backed && span >= REGION.minTextSpanWithDivider) return { side: textSide, edge: d!.x, evidence: "text+divider", span, lines: boxes.length };
    if (!backed && span >= REGION.minTextSpan) {
      // no edge to snap to: the region starts a little before its text
      const edge = textSide === "right" ? Math.max(f.x2 + REGION.faceGap, inner - 0.02) : Math.min(f.x1 - REGION.faceGap, inner + 0.02);
      return { side: textSide, edge, evidence: "text", span, lines: boxes.length };
    }
  }
  // a strong straight edge on its own (text detection misses frames of a region full of icons and
  // charts): only when nothing readable sits on the speaker's other side
  if (dividerOk && d!.s >= REGION.dividerAlone) {
    const opposite = dividerSide === "right" ? left : right;
    const same = dividerSide === "right" ? right : left;
    if (!opposite.length) return { side: dividerSide!, edge: d!.x, evidence: "divider", span: 0, lines: same.length };
  }
  return null;
}

/**
 * Is there a content region beside the speaker across these samples? Returns the region plus the signals
 * (always, so the caller can log why not).
 */
export function detectContentRegion(samples: RegionSample[]): ContentSignals & { content?: ContentRegion } {
  const withFace = samples.filter((s) => s.box);
  const faceSize = median(withFace.map((s) => s.box!.y2 - s.box!.y1));
  const base: ContentSignals = { share: 0, faceSize: Number(faceSize.toFixed(3)), textBeside: { left: 0, right: 0 }, textSpan: 0, lines: 0, dividerShare: 0 };
  const reject = (why: string, extra: Partial<ContentSignals> = {}) => ({ ...base, ...extra, rejected: why });
  if (!withFace.length) return reject("no face");
  if (faceSize < REGION.minFaceSize) return reject("face under 20% tall");

  const n = withFace.length;
  const votes = withFace.map((s) => ({ s, v: frameVote(s) }));
  const beside = (side: ContentSide) =>
    withFace.filter((s) => {
      const f = s.box!;
      return (s.text ?? []).some((b) => (side === "right" ? b.x1 >= f.x2 + REGION.margin : b.x2 <= f.x1 - REGION.margin));
    }).length / n;
  const textBeside = { left: Number(beside("left").toFixed(2)), right: Number(beside("right").toFixed(2)) };

  const sides: ContentSide[] = ["right", "left"];
  const best = sides
    .map((side) => ({ side, vs: votes.filter((x) => x.v?.side === side) }))
    .sort((a, b) => b.vs.length - a.vs.length)[0]!;
  const share = best.vs.length / n;
  const dividers = withFace.map((s) => s.divider).filter((d): d is DividerProbe => !!d && d.s >= REGION.dividerMin);
  const dividerX = dividers.length ? median(dividers.map((d) => d.x)) : undefined;
  const dividerShare = dividers.length ? dividers.filter((d) => Math.abs(d.x - dividerX!) <= 0.03).length / n : 0;
  const sig = { ...base, share: Number(share.toFixed(2)), side: best.side, textBeside, dividerShare: Number(dividerShare.toFixed(2)), ...(dividerX !== undefined ? { dividerX: Number(dividerX.toFixed(3)) } : {}) };
  if (share < REGION.minShare) return { ...sig, rejected: `content region in only ${Math.round(share * 100)}% of frames` };

  const edges = best.vs.map((x) => x.v!.edge);
  const edge = median(edges);
  const steady = edges.filter((e) => Math.abs(e - edge) <= REGION.stable).length / edges.length;
  if (steady < 0.7) return { ...sig, rejected: `region edge moves (${Math.round(steady * 100)}% steady)` };
  const spans = best.vs.map((x) => x.v!.span).filter((v) => v > 0);
  const textSpan = Number(median(spans).toFixed(2));
  const lines = median(best.vs.map((x) => x.v!.lines));
  const evid = new Set(best.vs.map((x) => x.v!.evidence));
  const evidence = evid.has("text+divider") ? "text+divider" : evid.has("text") ? "text" : "divider";

  // the region must clear every face we saw, and be wide enough to be worth a half of the frame
  const faces = best.vs.map((x) => x.s.box!);
  const k = Math.floor(0.9 * (faces.length - 1));
  const faceQ = best.side === "right" ? faces.map((f) => f.x2).sort((a, b) => a - b)[k]! : faces.map((f) => f.x1).sort((a, b) => b - a)[k]!;
  const x1 = best.side === "right" ? edge : 0;
  const x2 = best.side === "right" ? 1 : edge;
  const width = x2 - x1;
  if (width < REGION.minWidth) return { ...sig, evidence, textSpan, lines, rejected: `region only ${Math.round(width * 100)}% wide` };
  if (best.side === "right" ? edge < faceQ + REGION.faceGap : edge > faceQ - REGION.faceGap) return { ...sig, evidence, textSpan, lines, rejected: "region overlaps the speaker" };
  const content: ContentRegion = { x1: Number(x1.toFixed(3)), y1: 0, x2: Number(x2.toFixed(3)), y2: 1 };
  return { ...sig, evidence, textSpan, lines, content };
}

/** "app panel beside the speaker (right 32%)": the wording follows the region's shape and its text density */
export function contentReason(c: ContentRegion, sig: Pick<ContentSignals, "evidence" | "lines">): string {
  const kind = sig.evidence === "divider" ? "content" : sig.lines >= 5 ? "app panel" : "title card";
  return `${kind} beside the speaker (${contentSide(c) ?? "inset"} ${Math.round((c.x2 - c.x1) * 100)}%)`;
}

/** Attach text boxes to the nearest face sample in time (text is scanned at its own rate). */
export function attachText<S extends { t: number }>(samples: S[], frames: Array<{ t: number; all?: PBox[] }>, maxGap = 0.6): Array<S & { text?: PBox[] }> {
  if (!frames.length) return samples;
  return samples.map((s) => {
    let best: (typeof frames)[number] | undefined;
    for (const f of frames) if (!best || Math.abs(f.t - s.t) < Math.abs(best.t - s.t)) best = f;
    return best && best.all && Math.abs(best.t - s.t) <= maxGap ? { ...s, text: best.all } : s;
  });
}

/**
 * Per-column vertical-edge strength of a decoded RGB frame: the strongest straight vertical edge in
 * the middle of the frame, as `{ x, s }` (normalized). A composite's region edge runs the full height,
 * so its mean |Δluma| across rows is high; furniture and windows are diffuse.
 */
export function probeDivider(rgb: Uint8Array, w: number, h: number): DividerProbe {
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = (0.299 * rgb[i * 3]! + 0.587 * rgb[i * 3 + 1]! + 0.114 * rgb[i * 3 + 2]!) / 255;
  const gap = 3;
  let bestX = 0;
  let best = 0;
  for (let x = Math.ceil(0.12 * w); x <= Math.floor(0.88 * w); x++) {
    let sum = 0;
    for (let y = 0; y < h; y++) sum += Math.abs(L[y * w + x + gap]! - L[y * w + x - gap]!);
    const e = sum / h;
    if (e > best) {
      best = e;
      bestX = x;
    }
  }
  return { x: Number(((bestX + 0.5) / w).toFixed(3)), s: Number(best.toFixed(3)) };
}
