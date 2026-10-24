"use client";

// Hero loop: "Long video in. Vertical clips out. On this machine." 1920×1080, 12 s.
// A 16:9 source with its duration stamp, the link dropped into the app's paste box, three stage
// chips ticking, then four real rendered clips popping in and playing, each with its real score
// and a one-line reason for the pick. See the storyboard: Reelsaw Demo Storyboard, shot 01.

import { C, Clip, MONO, SANS, abs, clamp, enter, lerp, pop, typed, win, type FilmDef } from "./core";

const W = 1920;
const H = 1080;

/* ---------- Timeline ---------- */
const T_SOURCE = 0.2; // source card slides in
const T_TYPE = 0.9; // link types into the box
const T_FIND = 2.3; // Find clips pulses
const T_CHIPS = 2.7; // stage chips appear
const TICKS = [3.2, 3.9, 4.6]; // transcribe, pick moments, render turn green
const T_CLIP0 = 5.0; // first clip pops
const CLIP_GAP = 0.9;
const TOTAL = 12;
const POSTER_T = 10.6;

const URL_TEXT = "https://www.youtube.com/watch?v=jd5bCpWWBXA";

/* ---------- Footage: real renders from a Creative Commons BY source (see public/films/footage/README.md) ---------- */
type Pick = { src: string; score: number; why: string };
const CLIPS: Pick[] = [
  { src: "/films/footage/hero-1.mp4", score: 63, why: "A relatable complaint turns into advice, then a funny reality check." },
  { src: "/films/footage/hero-2.mp4", score: 62, why: "A culture-shock question becomes a surprising story with a clean ending." },
  { src: "/films/footage/hero-3.mp4", score: 67, why: "A playful claim, undercut by a story, that ends on a compliment." },
  { src: "/films/footage/hero-4.mp4", score: 61, why: "A personal story with a clear, heartfelt payoff." },
];
const SOURCE_POSTER = "/films/footage/hero-source.jpg";
const SOURCE_TITLE = "Foreigners STUNNED by Life in the UK (Oxford Edition)";
const SOURCE_LEN = "12:27";

/* ---------- Layout ---------- */
const PAD = 72;
const SRC = { x: PAD, y: 54, w: 450, h: 253 };
const BOX = { x: 582, y: 54, w: 1266, h: 66 };
const CHIP_Y = 146;
const CARD = { w: 300, h: 533, gap: 36, y: 356 };

function Source({ T }: { T: number }) {
  const k = enter(T, T_SOURCE, 0.7);
  return (
    <div style={abs(SRC.x, SRC.y + lerp(-24, 0, k), { width: SRC.w, opacity: k, display: "flex", flexDirection: "column", gap: 12 })}>
      <div style={{ position: "relative", width: SRC.w, height: SRC.h, borderRadius: 14, overflow: "hidden", border: `1px solid ${C.line}`, background: C.film }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={SOURCE_POSTER} alt="" style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }} />
        <span style={abs(14, 14, { fontSize: 15, fontWeight: 600, color: C.ink2, background: "rgba(20,20,22,.82)", padding: "5px 10px", borderRadius: 8 })}>16:9 source</span>
        <span style={{ position: "absolute", right: 14, bottom: 14, fontFamily: MONO, fontSize: 19, fontWeight: 500, color: C.ink, background: "rgba(20,20,22,.88)", padding: "5px 10px", borderRadius: 8 }}>{SOURCE_LEN}</span>
      </div>
      <p style={{ margin: 0, fontSize: 19, lineHeight: 1.3, color: C.ink2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{SOURCE_TITLE}</p>
    </div>
  );
}

function PasteBox({ T }: { T: number }) {
  const k = enter(T, T_SOURCE + 0.15, 0.7);
  const text = typed(URL_TEXT, T, T_TYPE, 40);
  const caret = text.length < URL_TEXT.length && T >= T_TYPE && Math.floor(T * 2.5) % 2 === 0;
  const pulse = win(T, T_FIND, T_FIND + 0.55, 0.2);
  return (
    <div style={abs(BOX.x, BOX.y + lerp(-24, 0, k), { width: BOX.w, height: BOX.h, opacity: k, display: "flex", alignItems: "center", gap: 14, padding: "0 20px", boxSizing: "border-box", borderRadius: 14, background: C.panel, border: `1px solid ${C.line}` })}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={C.ink3} strokeWidth="2" strokeLinecap="round" aria-hidden>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <span style={{ fontFamily: MONO, fontSize: 19, color: text ? C.ink : C.ink3, whiteSpace: "nowrap", overflow: "hidden" }}>
        {text || "Search or paste a link…"}
        {caret && <span style={{ display: "inline-block", width: 2, height: 22, marginLeft: 2, background: C.acc, verticalAlign: -4 }} />}
      </span>
      <span style={{ marginLeft: "auto", fontSize: 17, fontWeight: 700, color: C.accInk, background: C.acc, padding: "10px 16px", borderRadius: 10, transform: `scale(${1 + 0.06 * pulse})`, boxShadow: `0 0 0 ${8 * pulse}px rgba(166,138,230,${0.25 * pulse})` }}>Find clips</span>
    </div>
  );
}

const CHIPS = [
  { label: "Transcribe", done: "0:41" },
  { label: "Pick moments", done: "1:12" },
  { label: "Render", done: "" },
];

function Chips({ T }: { T: number }) {
  const rendered = CLIPS.filter((_, i) => T >= T_CLIP0 + i * CLIP_GAP).length;
  return (
    <>
      <div style={abs(BOX.x, CHIP_Y, { width: BOX.w, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 14 })}>
        {CHIPS.map((c, i) => {
          const k = enter(T, T_CHIPS + i * 0.1, 0.5);
          const on = T >= TICKS[i]!;
          const last = i === CHIPS.length - 1;
          const active = on && last && rendered < CLIPS.length;
          const col = on ? (active ? C.acc : C.ok) : C.line2;
          return (
            <div key={c.label} style={{ display: "flex", alignItems: "center", gap: 12, height: 52, padding: "0 16px", borderRadius: 11, boxSizing: "border-box", background: active ? C.accSoft : C.panel, border: `1px solid ${active ? C.acc : C.line}`, opacity: k, transform: `translateY(${lerp(10, 0, k)}px)` }}>
              <span style={{ width: 11, height: 11, borderRadius: 99, background: col, boxShadow: on ? `0 0 0 4px ${active ? "rgba(166,138,230,.25)" : C.okSoft}` : "none" }} />
              <span style={{ fontSize: 18, fontWeight: 600 }}>{c.label}</span>
              <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 15, color: C.ink3 }}>{last ? (on ? `${Math.min(rendered, CLIPS.length)} / ${CLIPS.length}` : "") : on ? c.done : ""}</span>
            </div>
          );
        })}
      </div>
      <p style={abs(BOX.x, CHIP_Y + 70, { margin: 0, fontFamily: MONO, fontSize: 15, color: C.ink3, opacity: enter(T, T_CHIPS + 0.5, 0.6) })}>on this machine · nothing uploaded · no API key · no credits</p>
    </>
  );
}

function Cards({ T }: { T: number }) {
  return (
    <div style={abs(PAD, CARD.y, { display: "flex", gap: CARD.gap, alignItems: "flex-start" })}>
      {CLIPS.map((c, i) => {
        const s = T_CLIP0 + i * CLIP_GAP;
        const k = pop(T, s, 0.55);
        const why = enter(T, s + 0.55, 0.5);
        return (
          <div key={c.src} style={{ width: CARD.w, display: "flex", flexDirection: "column", gap: 12, opacity: clamp(k * 1.6, 0, 1), transform: `translateY(${lerp(28, 0, k)}px) scale(${lerp(0.92, 1, k)})`, transformOrigin: "50% 100%" }}>
            <div style={{ position: "relative", width: CARD.w, height: CARD.h, borderRadius: 16, overflow: "hidden", border: `1px solid ${C.line}`, background: C.film, boxShadow: "0 18px 40px rgba(0,0,0,.35)" }}>
              <Clip src={c.src} start={s} T={T} style={{ width: "100%", height: "100%" }} />
              <span style={{ position: "absolute", right: 10, top: 10, fontFamily: MONO, fontSize: 15, fontWeight: 500, color: C.ink, background: "rgba(166,138,230,.92)", padding: "3px 9px", borderRadius: 8, opacity: enter(T, s + 0.3, 0.3) }}>{c.score}</span>
            </div>
            <p style={{ margin: 0, fontSize: 16, lineHeight: 1.35, color: C.ink3, opacity: why, transform: `translateY(${lerp(6, 0, why)}px)` }}>
              <span style={{ color: C.ink2, fontWeight: 600 }}>Why: </span>
              {c.why}
            </p>
          </div>
        );
      })}
      <Aside T={T} />
    </div>
  );
}

function Aside({ T }: { T: number }) {
  const k = enter(T, T_CLIP0 + CLIPS.length * CLIP_GAP + 0.2, 0.7);
  return (
    <div style={{ marginLeft: "auto", width: 400, height: CARD.h, display: "flex", flexDirection: "column", justifyContent: "center", gap: 18, opacity: k, transform: `translateY(${lerp(12, 0, k)}px)` }}>
      <p style={{ margin: 0, fontSize: 54, lineHeight: 1.02, fontWeight: 800, letterSpacing: "-0.02em" }}>
        9 clips
        <br />
        in <span style={{ color: C.acc }}>5:32</span>.
      </p>
      <p style={{ margin: 0, fontSize: 20, lineHeight: 1.45, color: C.ink2 }}>From a 12-minute video, on a laptop, with nothing uploaded. Each clip scored, captioned and reframed, with the model's reason for the pick.</p>
    </div>
  );
}

function Frame({ T }: { T: number }) {
  const fadeOut = 1 - enter(T, TOTAL - 0.45, 0.45);
  return (
    <div style={{ position: "absolute", inset: 0, opacity: fadeOut, fontFamily: SANS }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(60% 55% at 50% 0%, rgba(166,138,230,.16), transparent 70%)" }} />
      <Source T={T} />
      <PasteBox T={T} />
      <Chips T={T} />
      <Cards T={T} />
    </div>
  );
}

export const heroFilm: FilmDef = {
  name: "hero",
  W,
  H,
  total: TOTAL,
  poster: POSTER_T,
  label: "A YouTube link is pasted into Reelsaw, three stages run on the local machine, and four captioned 9:16 clips appear with their scores and the reason each was picked.",
  Frame,
};
