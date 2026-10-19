"use client";

// The pipeline film: a 1920×1080 animation of one video going through the five queues (ingest,
// transcribe, refine ×3, pick moments, render) with a worker restart that resumes from the last
// checkpoint. It is ONE element tree rendered as a pure function of authored time T, so every
// frame is deterministic: the home page plays it with requestAnimationFrame, and
// scripts/render-pipeline-film.mjs steps T frame by frame to make docs/assets/pipeline.mp4 for the
// README. Colours are the app's dark theme, fixed: it is a film, the same in both site themes.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Maximize2, Minimize2, Pause, Play } from "lucide-react";

/* ---------- Timeline ---------- */
export const SCENES = [
  { name: "Intro", dur: 3.5 },
  { name: "Ingest", dur: 4.5 },
  { name: "Transcribe", dur: 6.5 },
  { name: "Refine", dur: 8 },
  { name: "Analyze", dur: 8 },
  { name: "Render", dur: 7 },
  { name: "Resume", dur: 6 },
  { name: "Outro", dur: 4 },
] as const;
type Scene = (typeof SCENES)[number]["name"];
type Cues = Record<Scene, number>;
export const CUES = SCENES.reduce(
  (acc, s) => {
    acc.cues[s.name] = acc.t;
    acc.t += s.dur;
    return acc;
  },
  { cues: {} as Cues, t: 0 },
).cues;
export const TOTAL = SCENES.reduce((n, s) => n + s.dur, 0);
/** A frame worth looking at on its own (the poster, and the reduced-motion still). */
export const POSTER_T = CUES.Render + 5.6;

/* ---------- Motion helpers ---------- */
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const easeOutCubic = (t: number) => --t * t * t + 1;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1);
const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  return 1 + (c1 + 1) * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const k01 = (T: number, s: number, d: number) => clamp((T - s) / d, 0, 1);
const enter = (T: number, s: number, d = 0.6) => easeOutCubic(k01(T, s, d));
const draw = (T: number, s: number, d = 1) => easeInOutCubic(k01(T, s, d));
const pop = (T: number, s: number, d = 0.5) => easeOutBack(k01(T, s, d));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const win = (T: number, a: number, b: number, d = 0.45) => Math.min(enter(T, a, d), 1 - enter(T, b - d, d));
type Geo = { x: number; y: number; w: number; h: number; r?: number };
const mix = (g: Geo, h: Geo, t: number): Geo => ({ x: lerp(g.x, h.x, t), y: lerp(g.y, h.y, t), w: lerp(g.w, h.w, t), h: lerp(g.h, h.h, t), r: lerp(g.r ?? 0, h.r ?? 0, t) });
const fmt = (s: number) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
const abs = (left: number, top: number, extra?: CSSProperties): CSSProperties => ({ position: "absolute", left, top, ...extra });

/* ---------- Palette (the app's dark theme) ---------- */
const C = {
  bg: "#141416",
  panel: "#1d1d20",
  line: "#303034",
  ink: "#f1f1f2",
  ink2: "#bdbdc3",
  ink3: "#8a8a91",
  acc: "#a68ae6",
  accSoft: "rgba(166,138,230,.18)",
  ok: "#62c48d",
  okSoft: "rgba(98,196,141,.16)",
  warn: "#e3b34c",
  warnSoft: "rgba(227,179,76,.14)",
  err: "#e5675e",
  errSoft: "rgba(229,103,94,.16)",
  film: "#2a2a2e",
  film2: "#34343a",
};
const SANS = "var(--font-hanken), 'Hanken Grotesk', system-ui, sans-serif";
const MONO = "var(--font-jetbrains), 'JetBrains Mono', ui-monospace, monospace";
const STRIPES = `repeating-linear-gradient(135deg, ${C.film} 0 10px, ${C.film2} 10px 11px)`;

const W = 1920;
const H = 1080;
const BX = 260;
const BW = 1400;

type P = { T: number };

/* ---------- Rail: the five queues ---------- */
const NODES: { q: string; t: string; s: Scene; e: Scene }[] = [
  { q: "project.ingest", t: "Ingest", s: "Ingest", e: "Transcribe" },
  { q: "project.transcribe", t: "Transcribe", s: "Transcribe", e: "Refine" },
  { q: "refine.* ×3", t: "Refine", s: "Refine", e: "Analyze" },
  { q: "project.analyze", t: "Pick moments", s: "Analyze", e: "Render" },
  { q: "clip.render ×N", t: "Render", s: "Render", e: "Outro" },
];
const NX = [205, 520, 835, 1150, 1465];
const NW = 250;
const NY = 92;
const NH = 92;

function Rail({ T }: P) {
  const restart = T >= CUES.Resume + 0.8 && T < CUES.Resume + 2.3;
  return (
    <>
      {NODES.slice(0, 4).map((n, i) => {
        const x0 = NX[i]! + NW;
        const x1 = NX[i + 1]!;
        const p = draw(T, CUES[n.e] - 0.35, 0.7);
        const y = NY + NH / 2;
        const show = enter(T, 1.3 + i * 0.18, 0.5);
        return (
          <div key={"c" + i}>
            <div style={abs(x0, y - 1.5, { width: x1 - x0, height: 3, background: C.line, opacity: show })} />
            <div style={abs(x0, y - 1.5, { width: (x1 - x0) * p, height: 3, background: C.acc, opacity: show })} />
            {p > 0 && p < 1 && <div style={abs(x0 + (x1 - x0) * p - 7, y - 7, { width: 14, height: 14, borderRadius: 7, background: C.acc, boxShadow: `0 0 18px ${C.acc}` })} />}
          </div>
        );
      })}
      {NODES.map((n, i) => {
        const a = enter(T, 1.0 + i * 0.18, 0.6);
        const s = CUES[n.s];
        const e = CUES[n.e];
        const active = T >= s && T < e;
        const done = T >= e;
        const warn = i === 4 && restart;
        const col = warn ? C.warn : active ? C.acc : done ? C.ok : C.line;
        const pulse = 0.55 + 0.45 * Math.abs(Math.sin(T * 3));
        return (
          <div
            key={n.q}
            style={abs(NX[i]!, NY + (1 - a) * 16, {
              width: NW,
              height: NH,
              opacity: a * (active || done ? 1 : 0.55),
              borderRadius: 16,
              background: active ? C.panel : "transparent",
              border: `2px solid ${col}`,
              boxShadow: active ? `0 0 0 6px ${warn ? C.warnSoft : C.accSoft}` : "none",
              padding: "14px 18px",
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            })}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: MONO, fontSize: 17, color: active ? C.acc : C.ink3, flex: 1, whiteSpace: "nowrap" }}>{n.q}</span>
              {done && <span style={{ fontFamily: MONO, fontSize: 18, color: C.ok, fontWeight: 600 }}>✓</span>}
              {active && <span style={{ width: 10, height: 10, borderRadius: 5, background: col, opacity: pulse }} />}
            </div>
            <span style={{ fontSize: 26, fontWeight: 700, color: active || done ? C.ink : C.ink2, whiteSpace: "nowrap" }}>{n.t}</span>
          </div>
        );
      })}
    </>
  );
}

/* ---------- Intro / outro titles ---------- */
function Titles({ T }: P) {
  const a = win(T, 0.3, CUES.Ingest + 0.1, 0.6);
  const up = enter(T, CUES.Ingest - 0.6, 0.7);
  const o = win(T, CUES.Outro + 0.3, TOTAL + 1, 0.6);
  return (
    <>
      <div style={abs(0, 420 - up * 40, { width: W, textAlign: "center", opacity: a })}>
        <div style={{ fontSize: 84, fontWeight: 800, letterSpacing: "-0.02em" }}>
          One long video in.
          <br />
          <span style={{ color: C.acc }}>Clips out.</span>
        </div>
        <div style={{ fontSize: 30, color: C.ink2, marginTop: 22 }}>Five queues, and each one saves its work.</div>
      </div>
      <div style={abs(0, 270 + (1 - enter(T, CUES.Outro + 0.3)) * 20, { width: W, textAlign: "center", opacity: o })}>
        <span style={{ fontSize: 56, fontWeight: 800, letterSpacing: "-0.02em" }}>
          <span style={{ color: C.ok }}>✓</span> 5 clips ready
        </span>
        <span style={{ fontSize: 28, color: C.ink3, marginLeft: 20 }}>from 58:12 of source</span>
      </div>
    </>
  );
}

/* ---------- Source strip (persists Ingest → Analyze) ---------- */
const WAVE = Array.from({ length: 144 }, (_, j) => 0.18 + 0.82 * Math.abs(Math.sin(j * 1.7) * Math.cos(j * 0.37 + 1)));
const chunkStart = (i: number, Tr: number) => Tr + 0.9 + Math.floor(i / 4) * 1.55 + (i % 4) * 0.12;

function Source({ T }: P) {
  const I = CUES.Ingest;
  const Tr = CUES.Transcribe;
  const R = CUES.Refine;
  const grow = draw(T, I + 0.9, 1.3);
  const up = draw(T, R - 0.1, 0.9);
  const out = 1 - enter(T, CUES.Render, 0.6);
  if (grow <= 0 || out <= 0) return null;
  const y = lerp(440, 300, up);
  const h = lerp(110, 30, up);
  const wave = enter(T, Tr, 0.8);
  const gap = enter(T, Tr + 0.1, 0.7) * 12 * (1 - up);
  const cw = (BW - 11 * gap) / 12;
  const doneN = Array.from({ length: 12 }, (_, i) => k01(T, chunkStart(i, Tr), 1.3) >= 1).filter(Boolean).length;
  const words = Math.round((9812 * doneN) / 12).toLocaleString("en-US");
  const lab = enter(T, Tr + 0.6) * (1 - up);
  return (
    <div style={{ opacity: out }}>
      <div style={abs(BX, y - lerp(96, 52, up), { width: BW, display: "flex", alignItems: "baseline", fontSize: 22, color: C.ink2, opacity: Math.max(lab, up) })}>
        <span style={{ fontFamily: MONO, color: C.ink3, flex: 1 }}>{up > 0.5 ? "transcript" : "audio → 12 chunks · 4 in parallel"}</span>
        <span style={{ fontFamily: MONO }}>{up > 0.5 ? "9,812 words · 2 speakers" : words + " words"}</span>
      </div>
      <div style={abs(BX, y, { width: BW * grow, height: h + 60, overflow: "hidden" })}>
        {Array.from({ length: 12 }, (_, i) => {
          const x = i * (cw + gap);
          const p = k01(T, chunkStart(i, Tr), 1.3);
          return (
            <div key={i} style={abs(x, 0, { width: cw, height: h, borderRadius: lerp(10, 6, up), overflow: "hidden", background: STRIPES, borderLeft: i && gap < 1 ? `2px solid ${C.bg}` : "none", boxSizing: "border-box" })}>
              <div style={abs(0, 0, { width: cw * p, height: h, background: C.accSoft, opacity: wave })} />
              <div style={abs(0, 0, { width: cw, height: h, display: "flex", alignItems: "center", justifyContent: "space-around", padding: "0 4px", boxSizing: "border-box", opacity: wave })}>
                {WAVE.slice(i * 12, i * 12 + 12).map((v, j) => (
                  <div key={j} style={{ width: 3, height: Math.max(2, v * h * 0.7), borderRadius: 2, background: j / 12 < p ? C.acc : C.ink3 }} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {Array.from({ length: 12 }, (_, i) => {
        const x = BX + i * (cw + gap);
        const p = k01(T, chunkStart(i, Tr), 1.3);
        const ck = pop(T, chunkStart(i, Tr) + 1.3, 0.4) * (1 - up);
        return (
          <div key={"l" + i}>
            <div style={abs(x, y + h + 12, { width: cw, textAlign: "center", fontFamily: MONO, fontSize: 16, color: p >= 1 ? C.ink2 : C.ink3, opacity: lab })}>{fmt(i * 291)}</div>
            <div
              style={abs(x + cw / 2 - 42, y - 44 + (1 - ck) * 8, {
                width: 84,
                textAlign: "center",
                fontFamily: MONO,
                fontSize: 15,
                color: C.ok,
                background: C.okSoft,
                borderRadius: 999,
                padding: "3px 0",
                opacity: ck * (p >= 1 ? 1 : 0) * grow,
                display: lab > 0.01 ? "block" : "none",
              })}
            >
              ✓ saved
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Ingest extras ---------- */
function Ingest({ T }: P) {
  const I = CUES.Ingest;
  const Tr = CUES.Transcribe;
  const pill = win(T, I + 0.1, Tr + 0.3, 0.5);
  const chips = ["58:12", "1920×1080", "29.97 fps", "AAC · 48 kHz"];
  const chipOut = 1 - enter(T, Tr + 0.1, 0.4);
  return (
    <>
      <div style={abs(560, 300 + (1 - pill) * 14, { width: 800, opacity: pill, display: "flex", alignItems: "center", gap: 16, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 999, padding: "14px 26px", boxSizing: "border-box", fontSize: 24 })}>
        <span style={{ fontFamily: MONO, color: C.acc }}>yt-dlp</span>
        <span style={{ fontFamily: MONO, color: C.ink3, flex: 1, whiteSpace: "nowrap", overflow: "hidden" }}>youtube.com/watch?v=Qx7f…</span>
        <b style={{ whiteSpace: "nowrap" }}>Founders Pod #42</b>
      </div>
      <div style={abs(BX, 590, { width: BW, display: "flex", gap: 14, alignItems: "center", opacity: chipOut })}>
        <span style={{ fontFamily: MONO, fontSize: 20, color: C.acc, opacity: enter(T, I + 1.9), marginRight: 4 }}>ffprobe</span>
        {chips.map((c, i) => {
          const a = pop(T, I + 2.0 + i * 0.18, 0.45);
          return (
            <span key={c} style={{ fontFamily: MONO, fontSize: 22, border: `1px solid ${C.line}`, borderRadius: 10, padding: "6px 14px", opacity: Math.min(1, a), transform: `scale(${0.85 + 0.15 * a})` }}>
              {c}
            </span>
          );
        })}
        <div style={{ flex: 1 }} />
        <span style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 22, color: C.ink, opacity: enter(T, I + 3.0), background: C.okSoft, borderRadius: 999, padding: "7px 16px" }}>
          <span style={{ width: 10, height: 10, borderRadius: 5, background: C.ok }} />
          source stored once
        </span>
      </div>
    </>
  );
}

/* ---------- Refine lanes ---------- */
const LY = [390, 555, 720];
const LH = 135;
const LX = 400;
const LW = 1260;
const LANES = [
  { q: "refine.entities", d: "names from your vocabulary", fin: 3.2, done: "1 name fixed · 0.94 confidence" },
  { q: "refine.disfluency", d: "fillers → verified jump cuts", fin: 6.0, done: "3 jump cuts, each verified" },
  { q: "refine.scenes", d: "scene cuts and face presence", fin: 4.4, done: "23 scene cuts · faces in 96%" },
];

function Word({ w, cut = 0, add, cutMark = 0 }: { w: string; cut?: number; add?: { w: string; a: number } | null; cutMark?: number }) {
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 8 }}>
      {cutMark > 0 && <span style={{ position: "absolute", left: "50%", top: -26, transform: "translateX(-50%)", fontSize: 18, color: C.err, opacity: cutMark }}>✂</span>}
      <span style={{ color: cut > 0.5 ? C.ink3 : C.ink, textDecoration: cut > 0.5 ? "line-through" : "none", textDecorationColor: C.err, textDecorationThickness: 3 }}>{w}</span>
      {add && (
        <span style={{ color: C.acc, fontWeight: 700, opacity: add.a, transform: `scale(${0.7 + 0.3 * add.a})`, display: "inline-block" }}>{add.w}</span>
      )}
    </span>
  );
}

const ENTITY_WORDS = ["we", "shipped", "it", "with", "copier", "last", "spring"];
const FILLER_WORDS = ["so", "um,", "I think,", "I think", "the", "the", "real", "problem"];
const FILLER_AT: Record<number, number> = { 1: 0.25, 2: 0.5, 4: 0.75 };
const SCENE_CUT_AT: Record<number, number> = { 3: 0.25, 7: 0.5, 11: 0.75 };

function Refine({ T }: P) {
  const R = CUES.Refine;
  const A = CUES.Analyze;
  const prog = LANES.map((l, i) => k01(T, R + 1.0 + i * 0.15, l.fin - 1.0 - i * 0.15));
  const lastDone = pop(T, R + 6.05, 0.5);
  const vis = win(T, R + 0.5, A + 0.6, 0.5);
  if (vis <= 0) return null;
  const mids = LY.map((y) => y + LH / 2);
  return (
    <div style={{ opacity: vis }}>
      <svg width={W} height={H} style={abs(0, 0)} aria-hidden>
        {mids.map((m, i) => (
          <path key={"f" + i} d={`M 320 330 V ${m} H ${LX}`} fill="none" stroke={C.acc} strokeWidth="3" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - draw(T, R + 0.6 + i * 0.1, 0.6)} />
        ))}
        {mids.map((m, i) => (
          <path key={"g" + i} d={`M ${LX + LW} ${m} H 1730 V ${mids[1]}`} fill="none" stroke={prog[i]! >= 1 ? C.ok : C.line} strokeWidth="3" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - draw(T, R + LANES[i]!.fin, 0.4)} />
        ))}
      </svg>
      <div style={abs(1746, mids[1]! - 34, { width: 150, opacity: Math.min(1, lastDone), transform: `scale(${0.8 + 0.2 * lastDone})`, background: C.accSoft, border: `2px solid ${C.acc}`, borderRadius: 12, padding: "8px 10px", boxSizing: "border-box", fontFamily: MONO, fontSize: 16, lineHeight: 1.35, color: C.ink })}>
        enqueue
        <br />
        <span style={{ color: C.acc }}>analyze</span>
      </div>
      {LANES.map((l, i) => {
        const p = prog[i]!;
        const done = p >= 1;
        const a = enter(T, R + 0.7 + i * 0.12);
        return (
          <div key={l.q} style={abs(LX, LY[i]! + (1 - a) * 18, { width: LW, height: LH, opacity: a, background: C.panel, border: `2px solid ${done ? C.ok : p > 0 ? C.acc : C.line}`, borderRadius: 18, boxSizing: "border-box", overflow: "hidden" })}>
            <div style={abs(26, 20, { width: 300, display: "flex", flexDirection: "column", gap: 6 })}>
              <span style={{ fontFamily: MONO, fontSize: 20, color: C.acc }}>{l.q}</span>
              <span style={{ fontSize: 22, color: C.ink2 }}>{l.d}</span>
              <span style={{ fontFamily: MONO, fontSize: 17, color: done ? C.ok : C.ink3 }}>{done ? (i === 1 ? "✓ done · finished last" : "✓ done") : p > 0 ? "running · " + Math.round(p * 100) + "%" : "waiting"}</span>
            </div>
            <div style={abs(360, 0, { width: LW - 390, height: LH, display: "flex", alignItems: "center", gap: 14, fontSize: 28 })}>
              {i === 0 && ENTITY_WORDS.map((w, j) => <Word key={j} w={w} cut={j === 4 ? k01(p, 0.35, 0.2) : 0} add={j === 4 ? { w: "Copia", a: Math.min(1, pop(p, 0.6, 0.25)) } : null} />)}
              {i === 1 &&
                FILLER_WORDS.map((w, j) => {
                  const at = FILLER_AT[j];
                  return <Word key={j} w={w} cut={at ? k01(p, at, 0.12) : 0} cutMark={at ? enter(p, at, 0.1) : 0} />;
                })}
              {i === 2 &&
                Array.from({ length: 14 }, (_, j) => {
                  const cutAt = SCENE_CUT_AT[j];
                  const face = j % 5 !== 2 ? pop(p, j / 16, 0.12) : 0;
                  return (
                    <div key={j} style={{ position: "relative", width: 50, height: 74, borderRadius: 6, background: STRIPES, flex: "none", borderLeft: cutAt && p > cutAt ? `4px solid ${C.acc}` : "none", boxSizing: "border-box" }}>
                      {face > 0 && <span style={{ position: "absolute", left: 13, top: 22, width: 22, height: 22, borderRadius: 11, border: `2.5px solid ${C.ok}`, opacity: Math.min(1, face), boxSizing: "border-box" }} />}
                    </div>
                  );
                })}
            </div>
            <div style={abs(LW - 400, LH - 40, { width: 370, textAlign: "right", fontSize: 20, color: C.ok, opacity: enter(T, R + l.fin, 0.4) })}>{l.done}</div>
            <div style={abs(0, LH - 6, { width: LW * p, height: 4, background: done ? C.ok : C.acc })} />
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Candidates → ranked → rendered frames ---------- */
const CANDS: [string, number, number][] = [
  ["Why we killed the roadmap", 62, 7.4],
  ["The hiring mistake", 88, 11.2],
  ["Copia’s first customer", 71, 15.8],
  ["Pricing by accident", 54, 19.9],
  ["The 2am outage", 91, 24.1],
  ["Remote vs office", 67, 28.6],
  ["What investors miss", 79, 32.0],
  ["Our worst launch", 48, 36.5],
  ["Saying no to a big deal", 84, 41.3],
  ["Burnout, honestly", 58, 45.0],
  ["The one metric", 73, 49.7],
  ["Firing a friend", 95, 54.2],
];
const RANK = CANDS.map((_, i) => i)
  .sort((a, b) => CANDS[b]![1] - CANDS[a]![1])
  .reduce<Record<number, number>>((m, id, r) => ((m[id] = r), m), {});
const HOOKW = [
  ["Nobody", "warned", "us"],
  ["I", "hired", "wrong"],
  ["It", "took", "one", "call"],
  ["We", "just", "guessed"],
  ["Then", "the", "pager"],
  ["Office", "won"],
  ["They", "never", "ask"],
  ["Total", "silence"],
  ["We", "said", "no"],
  ["I", "hit", "a", "wall"],
  ["Only", "one", "number"],
  ["Hardest", "call", "ever"],
];
const PAIRS: [number, number][] = [
  [3, 9],
  [1, 6],
  [11, 4],
  [8, 2],
  [0, 10],
  [5, 7],
];
type RenderSt = "queued" | "run" | "done" | "crash" | "resume";

function renderState(r: number, T: number): { p: number; st: RenderSt } {
  const Rn = CUES.Render;
  const Rs = CUES.Resume;
  const dur = 2.4;
  if (r < 4) {
    const p = k01(T, Rn + 1.4 + Math.floor(r / 2) * 2.6, dur);
    return { p, st: p >= 1 ? "done" : p > 0 ? "run" : "queued" };
  }
  const s4 = Rn + 6.4;
  const crash = Rs + 0.8;
  const pc = (crash - s4) / dur;
  if (T < crash) return { p: k01(T, s4, dur), st: T < s4 ? "queued" : "run" };
  if (T < Rs + 2.0) return { p: pc, st: "crash" };
  if (T < Rs + 2.3) return { p: lerp(pc, 0.4, draw(T, Rs + 2.0, 0.3)), st: "resume" };
  const p = lerp(0.4, 1, k01(T, Rs + 2.3, 1.3));
  return { p, st: p >= 1 ? "done" : "resume" };
}
const STEP = (p: number) => (p >= 1 ? "ready" : p < 0.2 ? "layout" : p < 0.4 ? "captions" : p < 0.6 ? "hook" : p < 0.8 ? "intro · outro" : "encode");
const BAR_COL: Record<RenderSt, string> = { done: C.ok, crash: C.err, resume: C.warn, run: C.acc, queued: C.line };

function Cands({ T }: P) {
  const A = CUES.Analyze;
  const Rn = CUES.Render;
  if (T < A + 0.3) return null;
  const FW = 210;
  const FH = 373;
  const FG = 46;
  const F0 = (W - (5 * FW + 4 * FG)) / 2;
  const cmp = k01(T, A + 3.9, 2.0);
  const nCmp = Math.floor(cmp * 18);
  const pr = PAIRS[nCmp % PAIRS.length]!;
  const judge = win(T, A + 3.7, A + 6.6, 0.4);
  const capWord = Math.floor((T * 2.2) % 3);
  return (
    <>
      <div style={abs(BX, 370, { fontFamily: MONO, fontSize: 20, color: C.ink3, opacity: win(T, A + 1.0, A + 3.6) })}>map: transcript windows → 12 candidates</div>
      <div style={abs(1340, 470, { width: 320, opacity: judge, background: C.panel, border: `2px solid ${C.acc}`, borderRadius: 16, padding: 20, boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 10 })}>
        <span style={{ fontFamily: MONO, fontSize: 18, color: C.acc }}>judge model</span>
        <span style={{ fontSize: 24, fontWeight: 700 }}>Pairwise ranking</span>
        <span style={{ fontFamily: MONO, fontSize: 20, color: C.ink2 }}>{cmp < 1 ? `#${pr[0] + 1} vs #${pr[1] + 1} → #${(CANDS[pr[0]]![1] > CANDS[pr[1]]![1] ? pr[0] : pr[1]) + 1}` : "ranking settled"}</span>
        <span style={{ fontFamily: MONO, fontSize: 17, color: C.ink3 }}>{Math.max(nCmp, cmp >= 1 ? 18 : 0)} comparisons</span>
      </div>
      <div style={abs(640, 360 + 5 * 48 + 8, { width: 640, textAlign: "center", fontSize: 22, color: C.ink3, opacity: win(T, A + 6.3, Rn + 0.4, 0.4) })}>7 weaker moments dropped</div>
      {CANDS.map((c, i) => {
        const r = RANK[i]!;
        const top = r < 5;
        const col = i % 6;
        const row = Math.floor(i / 6);
        const g0: Geo = { x: BX + (c[2] / 58.2) * BW - 24, y: 300, w: 48, h: 30 };
        const g1: Geo = { x: 300 + col * 224, y: 430 + row * 124, w: 200, h: 100 };
        const g2: Geo = { x: 860 + (col - 2.5) * 70 + ((i * 37) % 23) - 11, y: 500 + (row - 0.5) * 60 + ((i * 53) % 19) - 9, w: 200, h: 100, r: ((i * 29) % 9) - 4 };
        const g3: Geo = { x: 640, y: 360 + i * 48, w: 640, h: 40 };
        const g4: Geo = { x: 640, y: 360 + r * 48, w: 640, h: 40 };
        const g5: Geo = top ? { x: F0 + r * (FW + FG), y: 380, w: FW, h: FH } : { x: 640, y: 360 + r * 48 + 60, w: 640, h: 40 };
        const p1 = draw(T, A + 1.0 + i * 0.06, 0.8);
        const p2 = draw(T, A + 2.9, 0.8);
        const p3 = draw(T, A + 3.7 + i * 0.03, 0.6);
        const p4 = draw(T, A + 4.4 + r * 0.06, 1.0);
        const p5 = draw(T, Rn + 0.2 + r * 0.08, 0.9);
        const g = mix(mix(mix(mix(mix(g0, g1, p1), g2, p2), g3, p3), g4, p4), g5, p5);
        const appear = enter(T, A + 0.5 + i * 0.06, 0.4);
        const drop = top ? 1 : 1 - enter(T, A + 6.2, 0.6);
        const out = 1 - enter(T, CUES.Outro + 3.1, 0.7);
        const op = appear * drop * out;
        if (op <= 0.001) return null;
        const hl = cmp > 0 && cmp < 1 && (pr[0] === i || pr[1] === i);
        const rs = top ? renderState(r, T) : { p: 0, st: "queued" as RenderSt };
        const barCol = BAR_COL[rs.st];
        const hookOn = enter(T, Rn + 1.0 + r * 0.1);
        const hook = HOOKW[i]!;
        const stuck = r === 4 && (rs.st === "crash" || rs.st === "resume");
        return (
          <div key={i} style={abs(g.x, g.y, { width: g.w, height: g.h, opacity: op, transform: `rotate(${g.r}deg)`, zIndex: top ? 2 : 1 })}>
            <div style={abs(0, 0, { width: g.w, height: g.h, borderRadius: lerp(lerp(6, 14, p1), 14, p5), background: C.panel, border: `2px solid ${hl ? C.acc : p1 < 0.5 ? C.acc : C.line}`, boxSizing: "border-box", overflow: "hidden" })}>
              <div style={abs(14, 12, { width: 172, opacity: p1 * (1 - p3), display: "flex", flexDirection: "column", gap: 10 })}>
                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 16 }}>
                  <span style={{ color: C.ink3 }}>cand {String(i + 1).padStart(2, "0")}</span>
                  <span style={{ color: C.acc }}>{fmt(c[2] * 60)}</span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: C.line, width: "92%" }} />
                <div style={{ height: 8, borderRadius: 4, background: C.line, width: "64%" }} />
              </div>
              <div style={abs(0, 0, { width: 640, height: 40, display: "flex", alignItems: "center", gap: 14, padding: "0 16px", boxSizing: "border-box", opacity: p3 * (1 - p5) })}>
                <span style={{ fontFamily: MONO, fontSize: 18, width: 36, color: top ? C.acc : C.ink3, opacity: p4 }}>#{r + 1}</span>
                <span style={{ fontSize: 21, flex: 1, whiteSpace: "nowrap" }}>{c[0]}</span>
                <div style={{ width: 120, height: 6, borderRadius: 3, background: C.line }}>
                  <div style={{ width: c[1] * 1.2 * p4, height: 6, borderRadius: 3, background: top ? C.acc : C.ink3 }} />
                </div>
                <span style={{ fontFamily: MONO, fontSize: 18, width: 34, textAlign: "right", opacity: p4 }}>{c[1]}</span>
              </div>
              <div style={abs(0, 0, { width: FW, height: FH, opacity: p5, background: STRIPES })}>
                <div style={abs(14, 46, { width: FW - 28, textAlign: "center", opacity: hookOn })}>
                  <span style={{ background: "#fff", color: "#111", fontWeight: 800, fontSize: 17, lineHeight: 1.3, borderRadius: 8, padding: "4px 8px", boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" }}>{c[0]}</span>
                </div>
                <div style={abs(10, FH * 0.64, { width: FW - 20, display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "4px 6px", opacity: k01(rs.p, 0.2, 0.1) })}>
                  {hook.map((w, j) => (
                    <span key={j} style={{ fontSize: 22, fontWeight: 800, color: "#fff", textTransform: "uppercase", textShadow: "0 2px 6px rgba(0,0,0,.7)", background: j === capWord % hook.length ? C.acc : "transparent", borderRadius: 5, padding: "0 4px" }}>
                      {w}
                    </span>
                  ))}
                </div>
                <div style={abs(10, 10, { fontFamily: MONO, fontSize: 14, color: "#fff", background: "rgba(0,0,0,.55)", borderRadius: 6, padding: "2px 7px" })}>
                  #{r + 1} · {c[1]}
                </div>
                {rs.st === "crash" && <div style={abs(0, 0, { width: FW, height: FH, background: "rgba(229,103,94,.22)" })} />}
              </div>
            </div>
            {top && (
              <div style={abs(0, FH + 16, { width: FW, opacity: p5 })}>
                <div style={{ position: "relative", height: 8, borderRadius: 4, background: C.line }}>
                  <div style={{ width: rs.p * 100 + "%", height: 8, borderRadius: 4, background: barCol }} />
                  {[0.2, 0.4, 0.6, 0.8].map((t) => (
                    <div key={t} style={abs(FW * t - 1, -3, { width: 2, height: 14, background: stuck && t === 0.4 ? C.warn : C.bg })} />
                  ))}
                </div>
                <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 17, color: rs.st === "done" ? C.ok : rs.st === "crash" ? C.err : rs.st === "resume" ? C.warn : C.ink2 }}>
                  <span>{rs.st === "queued" ? "queued" : rs.st === "crash" ? "interrupted" : rs.st === "done" ? "✓ ready" : STEP(rs.p)}</span>
                  <span>{rs.st === "done" || rs.st === "queued" ? "" : Math.round(rs.p * 100) + "%"}</span>
                </div>
                {stuck && <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 15, color: C.warn }}>{rs.st === "crash" ? "last save: captions" : "↺ from captions"}</div>}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

/* ---------- Resume banner ---------- */
function ResumeBanner({ T }: P) {
  const Rs = CUES.Resume;
  const a = win(T, Rs + 0.8, CUES.Outro + 0.2, 0.4);
  const back = T >= Rs + 2.0;
  return (
    <div style={abs(460, 286 + (1 - a) * 10, { width: 1000, opacity: a, display: "flex", alignItems: "center", justifyContent: "center", gap: 14, fontSize: 26, background: back ? C.okSoft : C.errSoft, border: `2px solid ${back ? C.ok : C.err}`, borderRadius: 999, padding: "14px 26px", boxSizing: "border-box" })}>
      <span style={{ fontFamily: MONO, fontWeight: 600, color: back ? C.ok : C.err }}>{back ? "↺" : "▲"}</span>
      <span>
        {back ? (
          <>
            Picked up from the last save. <span style={{ color: C.ink2 }}>Captions aren’t redone.</span>
          </>
        ) : (
          <>
            Worker restarted mid-render. <span style={{ color: C.ink2 }}>Job stays in the queue.</span>
          </>
        )}
      </span>
    </div>
  );
}

/* ---------- Caption ---------- */
const CAPTIONS: [number, string | null][] = [
  [CUES.Ingest + 0.4, "Ingest fetches the video with yt-dlp (or takes an upload), probes it, and stores the source once."],
  [CUES.Transcribe + 0.3, "Transcribe splits the audio into chunks that run in parallel. Each chunk saves when it’s done."],
  [CUES.Refine + 0.4, "Refine fans out into three jobs on the same transcript."],
  [CUES.Refine + 5.9, "Whichever refine job finishes last enqueues the next stage."],
  [CUES.Analyze + 0.5, "Pick moments: map the transcript into candidates, pool them, then rank them pairwise with a judge model."],
  [CUES.Render + 0.5, "Render builds each clip (layout, captions, hook, intro and outro) in a single encode."],
  [CUES.Resume + 0.5, "Every box is a queue in Postgres, and every stage saves its output, so a restart resumes instead of starting over."],
  [CUES.Outro + 0.3, null],
];

function Caption({ T }: P) {
  let cur: { at: number; until: number; text: string } | null = null;
  for (let i = 0; i < CAPTIONS.length; i++) {
    const [at, text] = CAPTIONS[i]!;
    const until = CAPTIONS[i + 1]?.[0] ?? TOTAL;
    if (T >= at && T < until) {
      cur = text ? { at, until, text } : null;
      break;
    }
  }
  if (!cur) return null;
  const a = win(T, cur.at, cur.until, 0.35);
  return <div style={abs(160, 978, { width: 1600, textAlign: "center", fontSize: 30, lineHeight: 1.35, color: C.ink, opacity: a, textWrap: "balance" })}>{cur.text}</div>;
}

/** The whole frame at authored time T, in 1920×1080 pixels. */
export function PipelineFrame({ T }: P) {
  const fadeOut = 1 - enter(T, TOTAL - 0.8, 0.8);
  return (
    <div style={{ position: "relative", width: W, height: H, overflow: "hidden", background: C.bg, color: C.ink, fontFamily: SANS, lineHeight: 1.2 }}>
      <div style={{ position: "absolute", inset: 0, opacity: fadeOut }}>
        <Rail T={T} />
        <Titles T={T} />
        <Ingest T={T} />
        <Source T={T} />
        <Refine T={T} />
        <Cands T={T} />
        <ResumeBanner T={T} />
        <Caption T={T} />
      </div>
    </div>
  );
}

/* ---------- Player ---------- */
declare global {
  interface Window {
    /** Set by <PipelineFilm capture>: the render script drives time through it. */
    __pipelineFilm?: { seek: (t: number) => void; total: number; poster: number; scenes: readonly { name: string; dur: number }[] };
  }
}

const FILM_LABEL =
  "Animated walkthrough of the Reelsaw pipeline: a video is ingested, transcribed in parallel chunks, refined by three jobs (entities, disfluency, scenes), its best moments are picked and ranked pairwise, and five vertical clips are rendered. A worker restarts mid-render and resumes from its last checkpoint.";

const fmtClock = (s: number) => fmt(Math.floor(s));

/**
 * The film with basic player controls: autoplays on a loop, click the picture (or the button) to
 * pause and resume, a scrub bar with keyboard support, a clock and fullscreen. Pauses while off
 * screen, and under prefers-reduced-motion opens on a still frame (play still works). The frame
 * is scaled to fit its box, so the 1920×1080 layout never reflows. `capture` turns the clock off
 * and exposes window.__pipelineFilm for scripts/render-pipeline-film.mjs.
 */
export function PipelineFilm({ capture = false, className }: { capture?: boolean; className?: string }) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(!capture);
  const [visible, setVisible] = useState(true);
  const [fit, setFit] = useState({ scale: 0, x: 0, y: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const [canFullscreen, setCanFullscreen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);

  // Fit the 1920×1080 frame into the box (by width normally; by both in fullscreen), centred.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || capture) return;
    const measure = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      const scale = Math.min(cw / W, ch / H);
      setFit({ scale, x: (cw - W * scale) / 2, y: (ch - H * scale) / 2 });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [capture]);

  // Reduced motion: open on the poster frame instead of playing; the controls still play on request.
  useEffect(() => {
    if (capture) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPlaying(false);
      setT(POSTER_T);
    }
    setCanFullscreen(!!document.fullscreenEnabled);
    const onFs = () => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, [capture]);

  // Off screen: stop the clock (not the user's choice; it comes back when scrolled into view).
  useEffect(() => {
    const el = root.current;
    if (!el || capture) return;
    const io = new IntersectionObserver(([e]) => setVisible(e?.isIntersecting ?? true), { threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, [capture]);

  useEffect(() => {
    if (capture || !playing || !visible) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      setT((prev) => (prev + dt) % TOTAL);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [capture, playing, visible]);

  const seek = useCallback((next: number) => flushSync(() => setT(clamp(next, 0, TOTAL))), []);
  useEffect(() => {
    if (!capture) return;
    window.__pipelineFilm = { seek, total: TOTAL, poster: POSTER_T, scenes: SCENES };
    return () => {
      delete window.__pipelineFilm;
    };
  }, [capture, seek]);

  if (capture) return <PipelineFrame T={t} />;

  const toggle = () => setPlaying((p) => !p);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen?.();
  };

  return (
    <div ref={root} className={className} style={{ display: "flex", flexDirection: "column", background: C.bg, color: C.ink, ...(fullscreen ? { width: "100%", height: "100%" } : null) }}>
      {/* The picture: click to pause and resume (the buttons below do the same for keyboards). */}
      <div
        ref={box}
        onClick={toggle}
        style={{ position: "relative", overflow: "hidden", cursor: "pointer", ...(fullscreen ? { flex: 1, minHeight: 0 } : { aspectRatio: `${W} / ${H}` }) }}
      >
        <div role="img" aria-label={FILM_LABEL} style={{ position: "absolute", left: fit.x, top: fit.y, width: W, height: H, transform: `scale(${fit.scale})`, transformOrigin: "0 0", visibility: fit.scale ? "visible" : "hidden" }}>
          <PipelineFrame T={t} />
        </div>
        {!playing && (
          <div aria-hidden className="absolute inset-0 grid place-items-center">
            <span className="grid h-14 w-14 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm sm:h-16 sm:w-16">
              <Play className="ml-1 h-6 w-6" />
            </span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-2 py-1.5 sm:gap-3 sm:px-3" style={{ borderTop: `1px solid ${C.line}` }}>
        <IconButton label={playing ? "Pause" : "Play"} pressed={!playing} onClick={toggle}>
          {playing ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="ml-px h-3.5 w-3.5" aria-hidden />}
        </IconButton>
        <Scrub t={t} onSeek={(v) => setT(v)} />
        <span className="font-mono text-[11px] tabular-nums" style={{ color: C.ink3 }} aria-hidden>
          {fmtClock(t)} / {fmtClock(TOTAL)}
        </span>
        {canFullscreen && (
          <IconButton label={fullscreen ? "Exit fullscreen" : "Fullscreen"} pressed={fullscreen} onClick={toggleFullscreen}>
            {fullscreen ? <Minimize2 className="h-3.5 w-3.5" aria-hidden /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden />}
          </IconButton>
        )}
      </div>
    </div>
  );
}

function IconButton({ label, pressed, onClick, children }: { label: string; pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-white/85 transition hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
    >
      {children}
    </button>
  );
}

/** The scrub bar: pointer to seek, arrow keys for ±1 s, Home and End. */
function Scrub({ t, onSeek }: { t: number; onSeek: (t: number) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const at = (e: { clientX: number }) => {
    const r = bar.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    onSeek(clamp(((e.clientX - r.left) / r.width) * TOTAL, 0, TOTAL));
  };
  return (
    <div
      ref={bar}
      role="slider"
      tabIndex={0}
      aria-label="Position in the animation"
      aria-valuemin={0}
      aria-valuemax={Math.round(TOTAL)}
      aria-valuenow={Math.round(t)}
      aria-valuetext={`${fmtClock(t)} of ${fmtClock(TOTAL)}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        at(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) at(e);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 5 : 1;
        const next = e.key === "ArrowRight" || e.key === "ArrowUp" ? t + step : e.key === "ArrowLeft" || e.key === "ArrowDown" ? t - step : e.key === "Home" ? 0 : e.key === "End" ? TOTAL : null;
        if (next === null) return;
        e.preventDefault();
        onSeek(clamp(next, 0, TOTAL));
      }}
      className="group relative h-7 min-w-0 flex-1 cursor-pointer touch-none rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
    >
      <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full transition-[height] group-hover:h-[5px]" style={{ background: "rgba(255,255,255,.14)" }}>
        <div className="h-full rounded-full" style={{ width: `${(t / TOTAL) * 100}%`, background: C.acc }} />
      </div>
    </div>
  );
}
