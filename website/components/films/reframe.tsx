"use client";

// Reframing: before (16:9 source with the detector's face boxes) → after (the real 9:16 render), one
// layout at a time: Face, Split, Fit. 1920×1080, 9 s. Storyboard shot 03. Face positions are the
// tracks the pipeline stored on the clips (clips.layout_segments), not drawn by hand.

import { C, Clip, MONO, abs, enter, lerp, win, type FilmDef } from "./core";

const W = 1920;
const H = 1080;
const PAIR = 2.8;
const TOTAL = 9;
const POSTER_T = PAIR + 1.6; // the split pair, the layout no single-crop clipper shows

type Face = { cy: number; size: number; track: [number, number][] };
type Pair = {
  layout: string;
  mode: string;
  reason: string;
  before: string;
  after: string;
  faces: Face[];
  /** Width of the 9:16 crop as a fraction of the source width (full-height crop), when there is one. */
  cropW?: number;
};

// Tracks are [seconds into the pair, x as a fraction of the source width]; sizes are the face height
// as a fraction of the source height.
const PAIRS: Pair[] = [
  {
    layout: "Face",
    mode: "Follow speaker",
    reason: "face in 100% of frames, 24% tall",
    before: "/films/footage/reframe-face-before.mp4",
    after: "/films/footage/reframe-face-after.mp4",
    faces: [{ cy: 0.348, size: 0.244, track: [[0, 0.562], [1, 0.577], [2, 0.567], [3, 0.558], [4, 0.558], [5, 0.533], [6, 0.553], [7, 0.583], [8, 0.563]] }],
    cropW: 0.3164,
  },
  {
    layout: "Split",
    mode: "Two stacked",
    reason: "two faces in 51% of frames",
    before: "/films/footage/reframe-split-before.mp4",
    after: "/films/footage/reframe-split-after.mp4",
    faces: [
      { cy: 0.341, size: 0.338, track: [[0, 0.388], [1, 0.328], [2, 0.307], [3, 0.398], [4, 0.452], [5, 0.452], [6, 0.542], [7, 0.57], [8, 0.509]] },
      { cy: 0.305, size: 0.186, track: [[0.75, 0.704], [1.75, 0.704], [2.75, 0.698], [3.75, 0.698], [4.75, 0.698], [5.75, 0.698], [6.75, 0.698], [7.75, 0.698]] },
    ],
  },
  {
    layout: "Fit",
    mode: "Whole frame",
    reason: "face in only 58% of frames",
    before: "/films/footage/reframe-fit-before.mp4",
    after: "/films/footage/reframe-fit-after.mp4",
    faces: [],
  },
];

const BEFORE = { x: 72, y: 262, w: 880, h: 495 };
const AFTER = { x: 1300, y: 158, w: 420, h: 747 };
const ARROW_X = (BEFORE.x + BEFORE.w + AFTER.x) / 2;

const trackX = (f: Face, t: number) => {
  const pts = f.track;
  if (t <= pts[0]![0]) return pts[0]![1];
  for (let i = 1; i < pts.length; i++) {
    const [t0, x0] = pts[i - 1]!;
    const [t1, x1] = pts[i]!;
    if (t <= t1) return lerp(x0, x1, (t - t0) / (t1 - t0));
  }
  return pts[pts.length - 1]![1];
};

function PairView({ p, i, T }: { p: Pair; i: number; T: number }) {
  const s = i * PAIR;
  const e = i === PAIRS.length - 1 ? TOTAL : s + PAIR;
  const on = win(T, s, e + 0.35, 0.35);
  if (on <= 0) return null;
  const local = Math.max(0, T - s);
  const boxes = enter(T, s + 0.5, 0.4);
  return (
    <div style={{ position: "absolute", inset: 0, opacity: on }}>
      {/* Before */}
      <div style={abs(BEFORE.x, BEFORE.y, { width: BEFORE.w, height: BEFORE.h, borderRadius: 14, overflow: "hidden", border: `1px solid ${C.line}`, background: C.film })}>
        <Clip src={p.before} start={s} T={T} style={{ width: "100%", height: "100%" }} />
        {p.faces.map((f, j) => {
          const x = trackX(f, local);
          const hpx = f.size * BEFORE.h;
          const wpx = hpx * 0.78;
          const col = j === 0 ? C.ok : C.acc;
          return (
            <div key={j} style={abs(x * BEFORE.w - wpx / 2, f.cy * BEFORE.h - hpx / 2, { width: wpx, height: hpx, border: `2px solid ${col}`, borderRadius: 8, opacity: boxes, boxShadow: `0 0 0 2px rgba(0,0,0,.35)` })}>
              <span style={{ position: "absolute", left: -2, top: "100%", marginTop: 6, fontFamily: MONO, fontSize: 13, color: col, background: "rgba(20,20,22,.8)", padding: "2px 6px", borderRadius: 5, whiteSpace: "nowrap" }}>{j === 0 ? "face · speaking" : "face"}</span>
            </div>
          );
        })}
        {p.cropW && p.faces[0] && (
          <div style={abs(trackX(p.faces[0], local) * BEFORE.w - (p.cropW * BEFORE.w) / 2, 0, { width: p.cropW * BEFORE.w, height: BEFORE.h, border: `2px dashed rgba(255,255,255,.55)`, boxSizing: "border-box", opacity: boxes, boxShadow: "0 0 0 2000px rgba(0,0,0,.28)" })} />
        )}
        {!p.faces.length && (
          <div style={abs(0, 0, { width: BEFORE.w, height: BEFORE.h, border: `2px dashed rgba(255,255,255,.55)`, boxSizing: "border-box", opacity: boxes })} />
        )}
        <span style={abs(14, 14, { fontSize: 15, fontWeight: 600, color: C.ink2, background: "rgba(20,20,22,.82)", padding: "5px 10px", borderRadius: 8 })}>Before · 16:9 source</span>
      </div>
      {/* After */}
      <div style={abs(AFTER.x, AFTER.y, { width: AFTER.w, height: AFTER.h, borderRadius: 18, overflow: "hidden", border: `1px solid ${C.acc}`, boxShadow: `0 0 0 5px ${C.accSoft}, 0 24px 60px rgba(0,0,0,.4)`, background: C.film })}>
        <Clip src={p.after} start={s} T={T} style={{ width: "100%", height: "100%" }} />
        <span style={{ position: "absolute", right: 14, top: 14, fontSize: 17, fontWeight: 700, color: C.accInk, background: C.acc, padding: "6px 12px", borderRadius: 9 }}>{p.layout}</span>
        <span style={abs(14, 14, { fontSize: 15, fontWeight: 600, color: C.ink2, background: "rgba(20,20,22,.82)", padding: "5px 10px", borderRadius: 8 })}>After · 9:16</span>
      </div>
      {/* Reason under the arrow */}
      <p style={abs(ARROW_X - 150, 582, { width: 300, margin: 0, textAlign: "center", fontFamily: MONO, fontSize: 15, lineHeight: 1.5, color: C.ink3, opacity: boxes })}>{p.reason}</p>
    </div>
  );
}

function Frame({ T }: { T: number }) {
  const fadeOut = 1 - enter(T, TOTAL - 0.45, 0.45);
  const head = enter(T, 0.1, 0.6);
  const active = Math.min(PAIRS.length - 1, Math.floor(T / PAIR));
  return (
    <div style={{ position: "absolute", inset: 0, opacity: fadeOut }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(60% 55% at 50% 0%, rgba(166,138,230,.14), transparent 70%)" }} />
      <div style={abs(72, 72, { opacity: head, transform: `translateY(${lerp(-10, 0, head)}px)`, display: "flex", flexDirection: "column", gap: 10 })}>
        <p style={{ margin: 0, fontSize: 40, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.05 }}>A layout per segment, picked from the faces it finds.</p>
        <p style={{ margin: 0, fontSize: 20, color: C.ink2 }}>A 1.2 MB face detector on the CPU. Split at scene cuts and face changes. Override per project, clip or section.</p>
      </div>
      {PAIRS.map((p, i) => (
        <PairView key={p.layout} p={p} i={i} T={T} />
      ))}
      {/* Arrow */}
      <svg width="64" height="40" viewBox="0 0 64 40" fill="none" stroke={C.acc} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={abs(ARROW_X - 32, 490, { opacity: head })}>
        <path d="M6 20h50" />
        <path d="m42 8 14 12-14 12" />
      </svg>
      {/* Layout chips */}
      <div style={abs(72, 880, { display: "flex", gap: 14, opacity: head })}>
        {PAIRS.map((p, i) => {
          const isOn = i === active;
          return (
            <div key={p.layout} style={{ display: "flex", flexDirection: "column", gap: 4, width: 280, padding: "14px 18px", borderRadius: 12, boxSizing: "border-box", background: isOn ? C.accSoft : C.panel, border: `1px solid ${isOn ? C.acc : C.line}`, transition: "none" }}>
              <span style={{ fontSize: 19, fontWeight: 700 }}>{p.layout}</span>
              <span style={{ fontSize: 15, color: isOn ? C.ink2 : C.ink3 }}>{p.mode}</span>
            </div>
          );
        })}
        <div style={{ display: "flex", flexDirection: "column", gap: 4, width: 280, padding: "14px 18px", borderRadius: 12, boxSizing: "border-box", background: C.panel, border: `1px dashed ${C.line2}` }}>
          <span style={{ fontSize: 19, fontWeight: 700, color: C.ink2 }}>Stack</span>
          <span style={{ fontSize: 15, color: C.ink3 }}>Screen + speaker</span>
        </div>
      </div>
    </div>
  );
}

export const reframeFilm: FilmDef = {
  name: "reframe",
  W,
  H,
  total: TOTAL,
  poster: POSTER_T,
  label: "Three before-and-after pairs: a 16:9 source frame with the detected faces outlined, next to the 9:16 clip Reelsaw rendered from it, labelled Face, Split and Fit.",
  Frame,
};
