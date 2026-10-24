"use client";

// Captions: the same seconds of the same clip twice, a raw 9:16 crop next to the Reelsaw render
// (hook overlay, key words coloured and enlarged, karaoke highlight). 1920×1080, 7 s. Shot 02.

import { C, Clip, MONO, abs, enter, lerp, type FilmDef } from "./core";

const W = 1920;
const H = 1080;
const TOTAL = 7;
const POSTER_T = 2.4;

const RAW = "/films/footage/captions-raw.mp4";
const RENDER = "/films/footage/hero-1.mp4";

const CARD = { w: 486, h: 864, y: 144 };
const LEFT_X = 420;
const RIGHT_X = 1014;

function Frame({ T }: { T: number }) {
  const fadeOut = 1 - enter(T, TOTAL - 0.45, 0.45);
  const head = enter(T, 0.1, 0.6);
  const tag = enter(T, 0.6, 0.5);
  const notes = enter(T, 1.6, 0.6);
  return (
    <div style={{ position: "absolute", inset: 0, opacity: fadeOut }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(60% 55% at 50% 0%, rgba(166,138,230,.14), transparent 70%)" }} />
      <p style={abs(0, 64, { width: W, margin: 0, textAlign: "center", fontSize: 40, fontWeight: 800, letterSpacing: "-0.02em", opacity: head, transform: `translateY(${lerp(-10, 0, head)}px)` })}>Same seconds, one render apart.</p>

      <div style={abs(LEFT_X, CARD.y, { width: CARD.w, height: CARD.h, borderRadius: 20, overflow: "hidden", border: `1px solid ${C.line}`, background: C.film })}>
        <Clip src={RAW} start={0} T={T} style={{ width: "100%", height: "100%" }} />
        <span style={abs(16, 16, { fontSize: 16, fontWeight: 600, color: C.ink2, background: "rgba(20,20,22,.82)", padding: "6px 12px", borderRadius: 9 })}>Raw 9:16 crop</span>
      </div>

      <svg width="64" height="40" viewBox="0 0 64 40" fill="none" stroke={C.acc} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={abs(W / 2 - 32, CARD.y + CARD.h / 2 - 20, { opacity: head })}>
        <path d="M6 20h50" />
        <path d="m42 8 14 12-14 12" />
      </svg>

      <div style={abs(RIGHT_X, CARD.y, { width: CARD.w, height: CARD.h, borderRadius: 20, overflow: "hidden", border: `1px solid ${C.acc}`, boxShadow: `0 0 0 5px ${C.accSoft}, 0 24px 60px rgba(0,0,0,.4)`, background: C.film })}>
        <Clip src={RENDER} start={0} T={T} style={{ width: "100%", height: "100%" }} />
        <span style={abs(16, 16, { fontSize: 16, fontWeight: 700, color: C.accInk, background: C.acc, padding: "6px 12px", borderRadius: 9, opacity: tag, transform: `translateY(${lerp(-6, 0, tag)}px)` })}>Rendered by Reelsaw</span>
      </div>

      {/* Notes beside the render */}
      <div style={abs(RIGHT_X + CARD.w + 56, 250, { width: 300, display: "flex", flexDirection: "column", gap: 24, opacity: notes, transform: `translateX(${lerp(-10, 0, notes)}px)` })}>
        {[
          ["Hook", "the model's one-liner, on screen for the first 3.5 s"],
          ["Key words", "picked by the model, coloured and enlarged"],
          ["Karaoke", "word highlight timed by forced alignment"],
          ["Readable", "4 words a line, time-on-screen limits, safe zones"],
          ["Source text", "burned-in subtitles and logos found and blurred"],
        ].map(([k, v]) => (
          <div key={k} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontFamily: MONO, fontSize: 14, color: C.acc, letterSpacing: ".06em", textTransform: "uppercase" }}>{k}</span>
            <span style={{ fontSize: 18, lineHeight: 1.4, color: C.ink2 }}>{v}</span>
          </div>
        ))}
      </div>
      <p style={abs(72, 300, { width: 290, margin: 0, fontSize: 18, lineHeight: 1.45, color: C.ink3, opacity: notes })}>Left: the source cropped to 9:16 by ffmpeg, its own burned-in subtitles included. Right: what Reelsaw rendered from the same frames. It found those subtitles and blurred them out.</p>
    </div>
  );
}

export const captionsFilm: FilmDef = {
  name: "captions",
  W,
  H,
  total: TOTAL,
  poster: POSTER_T,
  label: "Two vertical videos of the same seconds side by side: a plain crop, and the Reelsaw render with a hook overlay and word-by-word highlighted captions.",
  Frame,
};
