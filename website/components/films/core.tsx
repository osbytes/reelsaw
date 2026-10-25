"use client";

// Shared pieces of the demo films: palette, motion helpers, the <Clip> video element whose time is a
// function of the film clock, and the capture / preview stage that scripts/render-film.mjs drives.
//
// A film is one element tree rendered as a pure function of authored time T (see pipeline-film.tsx
// for the first one). These films also carry real rendered clips as <video> elements: in the browser
// preview the videos play on their own and are nudged back in sync when they drift; in capture mode
// nothing plays, the stage seeks every video to the time the frame asks for and waits for `seeked`
// before the screenshot, so each frame is exact and the same every run.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";

/* ---------- Palette (the app's dark theme, fixed: a film is the same in both site themes) ---------- */
export const C = {
  bg: "#141416",
  panel: "#1d1d20",
  sunk: "#0f0f10",
  line: "#303034",
  line2: "#3d3d41",
  ink: "#f1f1f2",
  ink2: "#bdbdc3",
  ink3: "#8a8a91",
  acc: "#a68ae6",
  accInk: "#17121f",
  accSoft: "rgba(166,138,230,.18)",
  ok: "#62c48d",
  okSoft: "rgba(98,196,141,.16)",
  warn: "#e3b34c",
  err: "#e5675e",
  film: "#2a2a2e",
  film2: "#34343a",
  snap: "#ff5cc8",
};
export const SANS = "var(--font-hanken), 'Hanken Grotesk', system-ui, sans-serif";
export const MONO = "var(--font-jetbrains), 'JetBrains Mono', ui-monospace, monospace";

/* ---------- Motion helpers ---------- */
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeOutCubic = (t: number) => --t * t * t + 1;
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1);
export const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  return 1 + (c1 + 1) * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
/** 0→1 over [s, s+d], clamped. */
export const k01 = (T: number, s: number, d: number) => clamp((T - s) / d, 0, 1);
export const enter = (T: number, s: number, d = 0.6) => easeOutCubic(k01(T, s, d));
export const draw = (T: number, s: number, d = 1) => easeInOutCubic(k01(T, s, d));
export const pop = (T: number, s: number, d = 0.5) => easeOutBack(k01(T, s, d));
/** 1 while T is inside [a, b], easing in and out over d at both ends. */
export const win = (T: number, a: number, b: number, d = 0.45) => Math.min(enter(T, a, d), 1 - enter(T, b - d, d));
export const fmt = (s: number) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
export const abs = (left: number, top: number, extra?: CSSProperties): CSSProperties => ({ position: "absolute", left, top, ...extra });

/** How many characters of `text` have been typed by T, starting at s, at cps characters a second. */
export const typed = (text: string, T: number, s: number, cps = 42) => text.slice(0, Math.max(0, Math.min(text.length, Math.floor((T - s) * cps))));

/* ---------- Film definition ---------- */
export type FilmDef = {
  /** URL slug: /films/<name>, public/films/<name>.{mp4,webm,jpg}. */
  name: string;
  W: number;
  H: number;
  /** Length in seconds. */
  total: number;
  /** A frame worth looking at on its own: the poster and the reduced-motion still. */
  poster: number;
  /** Alt text for the rendered video. */
  label: string;
  Frame: (p: { T: number }) => ReactNode;
};

/* ---------- <Clip>: a real rendered clip whose playhead follows the film clock ---------- */
type ClipProps = {
  src: string;
  /** Film time at which the footage starts (its 0:00). Before it the first frame shows. */
  start: number;
  T: number;
  /** Footage time offset: film time `start` maps to this time in the file (default 0). */
  offset?: number;
  style?: CSSProperties;
  className?: string;
};

/**
 * `data-film-t` carries the footage time the frame wants; the capture stage reads it and seeks. In
 * the browser preview the element plays itself and is re-synced when it drifts by more than 0.25 s.
 */
export function Clip({ src, start, T, offset = 0, style, className }: ClipProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const want = Math.max(0, T - start) + offset;
  const capture = useCapture();
  useEffect(() => {
    const v = ref.current;
    if (!v || capture) return;
    if (T < start) {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - offset) > 0.05) v.currentTime = offset;
      return;
    }
    if (Math.abs(v.currentTime - want) > 0.25) v.currentTime = want;
    if (v.paused) void v.play().catch(() => {});
  }, [T, start, offset, want, capture]);
  return <video ref={ref} src={src} data-film-t={want.toFixed(3)} muted playsInline preload="auto" aria-hidden className={className} style={{ display: "block", objectFit: "cover", ...style }} />;
}

/* ---------- Capture / preview stage ---------- */
let captureFlag = false;
const useCapture = () => captureFlag;

declare global {
  interface Window {
    /** Set by <FilmStage capture>: the render script drives time through it. */
    __film?: { name: string; seek: (t: number) => Promise<void>; total: number; poster: number; width: number; height: number };
  }
}

/** Seek every <Clip> on the page to the time its frame asks for, then wait two paints. */
async function settleVideos() {
  const vids = Array.from(document.querySelectorAll<HTMLVideoElement>("video[data-film-t]"));
  await Promise.all(
    vids.map(async (v) => {
      const want = Number(v.dataset.filmT);
      if (!Number.isFinite(want)) return;
      if (!v.paused) v.pause();
      if (v.readyState < 1) await new Promise<void>((r) => v.addEventListener("loadedmetadata", () => r(), { once: true }));
      const target = clamp(want, 0, Math.max(0, (Number.isFinite(v.duration) ? v.duration : want) - 0.001));
      if (Math.abs(v.currentTime - target) < 0.0005 && v.readyState >= 2) return;
      await new Promise<void>((r) => {
        const done = () => r();
        v.addEventListener("seeked", done, { once: true });
        v.currentTime = target;
        // Safari can skip `seeked` when the time is unchanged after clamping.
        if (Math.abs(v.currentTime - target) < 0.0005 && v.readyState >= 2) {
          v.removeEventListener("seeked", done);
          r();
        }
      });
    }),
  );
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

/**
 * The film at its native size. `capture` freezes the clock and exposes window.__film for
 * scripts/render-film.mjs; otherwise it loops with requestAnimationFrame (a dev preview, not what
 * the site serves: the site serves the rendered video).
 */
export function FilmStage({ film, capture = false }: { film: FilmDef; capture?: boolean }) {
  const [t, setT] = useState(0);
  captureFlag = capture;

  useEffect(() => {
    if (capture) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      setT((prev) => (prev + dt) % film.total);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [capture, film.total]);

  const seek = useCallback(
    async (next: number) => {
      flushSync(() => setT(clamp(next, 0, film.total)));
      await settleVideos();
    },
    [film.total],
  );
  useEffect(() => {
    if (!capture) return;
    window.__film = { name: film.name, seek, total: film.total, poster: film.poster, width: film.W, height: film.H };
    return () => {
      delete window.__film;
    };
  }, [capture, seek, film]);

  return (
    <div style={{ position: "relative", width: film.W, height: film.H, overflow: "hidden", background: C.bg, color: C.ink, fontFamily: SANS, lineHeight: 1.2 }}>
      <film.Frame T={t} />
    </div>
  );
}

/** Fits a native-size child into its box by width (for the dev preview page). */
export function FitBox({ W, H, children }: { W: number; H: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / W));
    ro.observe(el);
    setScale(el.clientWidth / W);
    return () => ro.disconnect();
  }, [W]);
  return (
    <div ref={box} style={{ position: "relative", width: "100%", aspectRatio: `${W} / ${H}`, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H, transform: `scale(${scale})`, transformOrigin: "0 0", visibility: scale ? "visible" : "hidden" }}>{children}</div>
    </div>
  );
}
