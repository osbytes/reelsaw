"use client";

// "Your video never leaves this machine": a still, not a loop, for the places a video can't play
// (GitHub social preview, directory listings, link previews). 1920×1080. Storyboard shot 06.
// Rendered with `pnpm render:film local --still`; the three 9:16 tiles are frames of real clips.

import { C, MONO, abs, type FilmDef } from "./core";

const W = 1920;
const H = 1080;

const TILES = ["/films/footage/hero-1.mp4", "/films/footage/hero-3.mp4", "/films/footage/hero-4.mp4"];

function Stage({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "18px 20px", borderRadius: 12, background: C.bg, border: `1px solid ${C.line}` }}>
      <span style={{ fontSize: 22, fontWeight: 700 }}>{title}</span>
      <span style={{ fontFamily: MONO, fontSize: 15, color: C.ink3 }}>{sub}</span>
    </div>
  );
}

function Arrow({ x, y }: { x: number; y: number }) {
  return (
    <svg width="72" height="40" viewBox="0 0 72 40" fill="none" stroke={C.ink3} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={abs(x, y)}>
      <path d="M6 20h58" />
      <path d="m50 8 14 12-14 12" />
    </svg>
  );
}

function Frame() {
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(70% 70% at 50% 100%, rgba(166,138,230,.14), transparent 70%)" }} />
      <div style={abs(120, 96, { width: 1680, display: "flex", flexDirection: "column", gap: 14 })}>
        <h1 style={{ margin: 0, fontSize: 64, lineHeight: 1.02, fontWeight: 800, letterSpacing: "-0.025em" }}>Your video never leaves this machine.</h1>
        <p style={{ margin: 0, fontSize: 26, lineHeight: 1.4, color: C.ink2 }}>Transcription, moment picking and rendering run in Docker on your own hardware. No upload, no API key, no credits.</p>
      </div>

      {/* Input */}
      <div style={abs(120, 400, { width: 300, display: "flex", flexDirection: "column", gap: 16, alignItems: "center" })}>
        <div style={{ position: "relative", width: 300, height: 169, borderRadius: 12, overflow: "hidden", border: `1px solid ${C.line}`, background: C.film }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/films/footage/hero-source.jpg" alt="" style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }} />
          <span style={{ position: "absolute", right: 10, bottom: 10, fontFamily: MONO, fontSize: 17, fontWeight: 500, color: C.ink, background: "rgba(20,20,22,.88)", padding: "4px 9px", borderRadius: 7 }}>12:27</span>
        </div>
        <span style={{ fontSize: 22, fontWeight: 600 }}>A link or a file</span>
      </div>
      <Arrow x={452} y={464} />

      {/* Your machine */}
      <div style={abs(556, 330, { width: 780, display: "flex", flexDirection: "column", gap: 16, padding: 26, boxSizing: "border-box", borderRadius: 18, background: C.panel, border: `1px solid ${C.acc}`, boxShadow: `0 0 0 6px ${C.accSoft}` })}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: C.acc }}>Your machine</span>
          <span style={{ fontFamily: MONO, fontSize: 16, color: C.ink3 }}>docker compose up</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
          <Stage title="Speech to text" sub="Whisper via Speaches" />
          <Stage title="Picks the moments" sub="Ollama · any local LLM" />
          <Stage title="Finds the faces" sub="1.2 MB detector, CPU" />
          <Stage title="Renders" sub="ffmpeg, one encode" />
        </div>
        <p style={{ margin: 0, fontSize: 17, lineHeight: 1.45, color: C.ink3 }}>Or point any stage at OpenAI, Anthropic, Google, Groq, Deepgram, AssemblyAI… your choice, per model.</p>
      </div>
      <Arrow x={1368} y={464} />

      {/* Output */}
      <div style={abs(1472, 318, { width: 328, display: "flex", flexDirection: "column", gap: 16, alignItems: "center" })}>
        <div style={{ display: "flex", gap: 10 }}>
          {TILES.map((src) => (
            <video key={src} src={src} muted playsInline preload="auto" aria-hidden data-film-t="2.000" style={{ display: "block", width: 102, height: 181, objectFit: "cover", borderRadius: 10, border: `1px solid ${C.line}`, background: C.film }} />
          ))}
        </div>
        <span style={{ fontSize: 22, fontWeight: 600, textAlign: "center" }}>Captioned 9:16 clips</span>
      </div>

      {/* Footer chips */}
      <div style={abs(120, 860, { display: "flex", gap: 12 })}>
        {["AGPL-3.0, source on GitHub", "MCP server built in", "Resumes after a crash", "Local disk or S3"].map((t) => (
          <span key={t} style={{ fontSize: 18, fontWeight: 600, color: C.ink2, border: `1px solid ${C.line}`, borderRadius: 999, padding: "10px 18px" }}>
            {t}
          </span>
        ))}
      </div>
      <span style={abs(120, 960, { fontFamily: MONO, fontSize: 18, color: C.ink3 })}>reelsaw.com</span>
    </div>
  );
}

export const localFilm: FilmDef = {
  name: "local",
  W,
  H,
  total: 1,
  poster: 0,
  label: "Diagram: a link or file goes into your machine, where speech to text, moment picking, face detection and rendering run in Docker, and captioned 9:16 clips come out.",
  Frame,
};
