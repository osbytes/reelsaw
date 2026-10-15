import { useEffect, useMemo, useRef, useState } from "react";
import { CAPTION_FONT_FRAC, HOOK_FONT_FRAC, groupCaptionLines, lineSecondsFor, captionMaxChars, lineDisplayEnd, emphasisKey, type Style } from "@reelsaw/shared";

export type PreviewLayout = "face" | "split" | "stack" | "fit" | "center" | "none";
export interface Framing {
  layout: PreviewLayout;
  /** normalized face centre */
  cx: number;
  cy: number;
  cx2?: number;
}
export interface PreviewWord {
  text: string;
  /** seconds relative to the clip start */
  start: number;
  end: number;
}

interface Props {
  /** Video or image element to sample frames from; null draws a placeholder. */
  source: HTMLVideoElement | HTMLImageElement | null;
  srcW: number;
  srcH: number;
  framing: Framing;
  style: Style;
  words: PreviewWord[];
  /** clip-relative playback time (drives karaoke + hook visibility) */
  time: number;
  hook?: string;
  /** key words coloured with style.emphasisColor */
  emphasis?: string[];
  /** always show the hook (style editing) instead of only during the first seconds */
  alwaysShowHook?: boolean;
  onStyleChange?: (patch: Partial<Style>) => void;
  /** drag the picture to re-centre the crop; delta is in source-width fractions */
  onPan?: (deltaX: number) => void;
  showSafeZones?: boolean;
  className?: string;
}

const FONT = `"DejaVu Sans", Verdana, system-ui, sans-serif`;
const SNAP = 0.025;

/**
 * 9:16 preview that mirrors the renderer: the frame is drawn on a canvas with the same crop math as
 * `layoutFilter` (render.ts), captions/hook are HTML on top at the same fractional positions and font
 * sizes as the ASS file, and can be dragged to move them.
 */
export function VerticalPreview({ source, srcW, srcH, framing, style, words, time, hook, emphasis, alwaysShowHook, onStyleChange, onPan, showSafeZones, className = "" }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [h, setH] = useState(0);
  const [drag, setDrag] = useState<null | "caption" | "hook" | "pan">(null);
  const panX = useRef(0);
  const [snappedX, setSnappedX] = useState(false);
  const framingRef = useRef(framing);
  framingRef.current = framing;

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    setH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // draw loop: cheap at preview size, keeps up with video playback without wiring media events
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const c = canvasRef.current;
      if (c) {
        const W = c.clientWidth;
        const H = c.clientHeight;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
          c.width = Math.round(W * dpr);
          c.height = Math.round(H * dpr);
        }
        const ctx = c.getContext("2d");
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          paint(ctx, W, H, source, srcW, srcH, framingRef.current);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [source, srcW, srcH]);

  const lines = useMemo(() => groupCaptionLines(words, style.wordsPerLine, lineSecondsFor(style.wordsPerLine), captionMaxChars(style.captionSize)), [words, style.wordsPerLine, style.captionSize]);
  const lineIdx = lines.findIndex((l, i) => time >= l[0]!.start && time <= lineDisplayEnd(lines, i));
  const line = lineIdx >= 0 ? lines[lineIdx] : alwaysShowHook ? lines[0] : undefined;
  const em = useMemo(() => new Set(style.emphasis ? (emphasis ?? []).map(emphasisKey) : []), [emphasis, style.emphasis]);
  const activeIdx = line ? line.findIndex((w, i) => time >= (i === 0 ? line[0]!.start : w.start) && time < (i === line.length - 1 ? line[line.length - 1]!.end : line[i + 1]!.start)) : -1;
  const showHook = style.showHook && !!hook && (alwaysShowHook || time < style.hookSeconds);
  const width = (h * 9) / 16;

  function onPointerDown(kind: "caption" | "hook", e: React.PointerEvent) {
    if (!onStyleChange) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(kind);
  }
  const pannable = !!onPan && framing.layout !== "fit" && framing.layout !== "none";
  function onPanStart(e: React.PointerEvent) {
    if (!pannable || e.button !== 0) return;
    e.preventDefault();
    boxRef.current?.setPointerCapture(e.pointerId);
    panX.current = e.clientX;
    setDrag("pan");
  }
  function onPointerMove(e: React.PointerEvent) {
    if (drag === "pan" && boxRef.current && onPan) {
      const W = boxRef.current.clientWidth;
      const dx = e.clientX - panX.current;
      panX.current = e.clientX;
      // dragging the picture right moves the crop window left
      if (dx) onPan(-(dx / W) * cropFraction(framing.layout, srcW, srcH, W, boxRef.current.clientHeight));
      return;
    }
    if (!drag || !boxRef.current || !onStyleChange) return;
    const r = boxRef.current.getBoundingClientRect();
    let x = (e.clientX - r.left) / r.width;
    const y = Math.max(0.04, Math.min(0.96, (e.clientY - r.top) / r.height));
    const snap = Math.abs(x - 0.5) < SNAP && !e.altKey;
    if (snap) x = 0.5;
    x = Math.max(0.08, Math.min(0.92, x));
    setSnappedX(snap);
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    onStyleChange(drag === "caption" ? { captionX: r3(x), captionY: r3(y) } : { hookX: r3(x), hookY: r3(y) });
  }
  function onPointerUp() {
    setDrag(null);
    setSnappedX(false);
  }

  const capPx = h * CAPTION_FONT_FRAC * style.captionSize;
  const hookPx = h * HOOK_FONT_FRAC;
  const draggable = !!onStyleChange;

  return (
    <div
      ref={boxRef}
      className={`relative mx-auto aspect-[9/16] h-full max-w-full touch-none select-none overflow-hidden rounded-lg bg-black ${pannable ? (drag === "pan" ? "cursor-grabbing" : "cursor-grab") : ""} ${className}`}
      title={pannable ? "Drag the picture to re-centre the crop" : undefined}
      onPointerDown={onPanStart}
      onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {showSafeZones && <SafeZones />}
      {drag && snappedX && <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-accent-2/80" />}

      {showHook && (
        <div
          className={`absolute -translate-x-1/2 -translate-y-1/2 text-center font-bold leading-tight ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${drag === "hook" ? "ring-2 ring-accent-2" : draggable ? "hover:ring-1 hover:ring-white/50" : ""}`}
          style={{ left: `${style.hookX * 100}%`, top: `${style.hookY * 100}%`, fontFamily: FONT, fontSize: hookPx, maxWidth: width * 0.88, width: "max-content", background: "#fff", color: "#000", padding: `${hookPx * 0.2}px ${hookPx * 0.3}px` }}
          onPointerDown={(e) => onPointerDown("hook", e)}
          title={draggable ? "Drag to move the hook" : undefined}
        >
          {hook!.toUpperCase()}
        </div>
      )}

      {style.captions !== "none" && line && (
        <div
          className={`absolute -translate-x-1/2 -translate-y-1/2 text-center font-bold leading-tight ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${drag === "caption" ? "ring-2 ring-accent-2" : draggable ? "hover:ring-1 hover:ring-white/50" : ""}`}
          style={{
            left: `${style.captionX * 100}%`,
            top: `${style.captionY * 100}%`,
            fontFamily: FONT,
            fontSize: capPx,
            maxWidth: width * 0.88,
            width: "max-content",
            color: "#fff",
            ...(style.captions === "box"
              ? { background: "rgba(0,0,0,0.63)", padding: `${capPx * 0.12}px ${capPx * 0.25}px` }
              : { WebkitTextStroke: `${Math.max(1, capPx * 0.06)}px #000`, paintOrder: "stroke fill", textShadow: `0 ${capPx * 0.04}px ${capPx * 0.06}px rgba(0,0,0,0.5)` }),
          }}
          onPointerDown={(e) => onPointerDown("caption", e)}
          title={draggable ? "Drag to move captions (hold Alt to skip centre snapping)" : undefined}
        >
          {line.map((w, i) => {
            const t = style.uppercase ? w.text.toUpperCase() : w.text;
            const active = style.captions === "karaoke" && i === activeIdx;
            const isEm = em.has(emphasisKey(w.text));
            return (
              <span key={i}>
                <span style={active ? { color: style.highlightColor, display: "inline-block", transform: "scale(1.12)" } : isEm ? { color: style.emphasisColor, display: "inline-block", transform: "scale(1.12)" } : undefined}>{t}</span>
                {i < line.length - 1 ? " " : ""}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Approximate TikTok / Shorts / Reels UI chrome on a 1080×1920 frame. */
function SafeZones() {
  const zone = "pointer-events-none absolute bg-danger/15 outline outline-1 outline-dashed outline-danger/40";
  return (
    <>
      <div className={zone} style={{ left: 0, right: 0, top: 0, height: "7%" }} />
      <div className={zone} style={{ left: 0, right: 0, bottom: 0, height: "20%" }} />
      <div className={zone} style={{ right: 0, top: "38%", bottom: "20%", width: "13%" }} />
      <span className="pointer-events-none absolute bottom-1 left-1 text-[9px] text-danger/80">platform UI</span>
    </>
  );
}

/** Width of the crop window as a fraction of the source width, per layout (mirrors paint()). */
function cropFraction(layout: PreviewLayout, srcW: number, srcH: number, W: number, H: number) {
  if (layout === "split") return Math.min(1, (srcH * W) / (H / 2) / srcW);
  if (layout === "stack") {
    const botH = H - (W * srcH) / srcW;
    return Math.min(1, (srcH * 0.55 * W) / Math.max(1, botH) / srcW);
  }
  return Math.min(1, (srcH * 9) / 16 / srcW);
}

// ---------- canvas painter, mirrors layoutFilter() in apps/server/src/pipeline/render.ts ----------

function ready(src: HTMLVideoElement | HTMLImageElement | null): src is HTMLVideoElement | HTMLImageElement {
  if (!src) return false;
  if (src instanceof HTMLVideoElement) return src.readyState >= 2 && src.videoWidth > 0;
  return src.complete && src.naturalWidth > 0;
}

function paint(ctx: CanvasRenderingContext2D, W: number, H: number, src: HTMLVideoElement | HTMLImageElement | null, sw0: number, sh0: number, f: Framing) {
  ctx.filter = "none";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (!ready(src)) {
    placeholder(ctx, W, H, f);
    return;
  }
  // trust the element's real size over the probe (thumbnails are smaller than the video)
  const srcW = src instanceof HTMLVideoElement ? src.videoWidth : src.naturalWidth || sw0;
  const srcH = src instanceof HTMLVideoElement ? src.videoHeight : src.naturalHeight || sh0;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const draw = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) => {
    try {
      ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
    } catch {
      /* frame not decodable yet */
    }
  };

  switch (f.layout) {
    case "fit":
    case "none": {
      // blurred cover background + whole frame fitted to the width
      const cover = Math.max(W / srcW, H / srcH);
      if (f.layout === "fit") {
        ctx.filter = "blur(14px) brightness(0.6)";
        draw(0, 0, srcW, srcH, (W - srcW * cover) / 2, (H - srcH * cover) / 2, srcW * cover, srcH * cover);
        ctx.filter = "none";
      }
      const fit = Math.min(W / srcW, H / srcH);
      draw(0, 0, srcW, srcH, (W - srcW * fit) / 2, (H - srcH * fit) / 2, srcW * fit, srcH * fit);
      return;
    }
    case "split": {
      const halfH = H / 2;
      const cW = Math.min(srcW, (srcH * W) / halfH);
      const x1 = clamp(f.cx * srcW - cW / 2, 0, srcW - cW);
      const x2 = clamp((f.cx2 ?? 1 - f.cx) * srcW - cW / 2, 0, srcW - cW);
      draw(x1, 0, cW, srcH, 0, 0, W, halfH);
      draw(x2, 0, cW, srcH, 0, halfH, W, halfH);
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, halfH - 0.5, W, 1);
      return;
    }
    case "stack": {
      const topH = (W * srcH) / srcW;
      const botH = H - topH;
      draw(0, 0, srcW, srcH, 0, 0, W, topH);
      const zoomH = srcH * 0.55;
      const zoomW = Math.min(srcW, (zoomH * W) / botH);
      const zx = clamp(f.cx * srcW - zoomW / 2, 0, srcW - zoomW);
      const zy = clamp(f.cy * srcH - zoomH / 2, 0, srcH - zoomH);
      draw(zx, zy, zoomW, zoomH, 0, topH, W, botH);
      return;
    }
    default: {
      // face / center: full-height 9:16 window
      const cropW = Math.min(srcW, (srcH * 9) / 16);
      const cropH = Math.min(srcH, (srcW * 16) / 9);
      const cx = f.cx;
      const x = clamp(cx * srcW - cropW / 2, 0, srcW - cropW);
      draw(x, (srcH - cropH) / 2, cropW, cropH, 0, 0, W, H);
    }
  }
}

function placeholder(ctx: CanvasRenderingContext2D, W: number, H: number, f: Framing) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#1c2030");
  g.addColorStop(1, "#0d0f16");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const person = (cx: number, cy: number, s: number) => {
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx, cy + s * 1.45, s * 1.05, s * 0.8, 0, Math.PI, 0);
    ctx.fill();
  };
  if (f.layout === "split") {
    person(W / 2, H * 0.22, W * 0.2);
    person(W / 2, H * 0.72, W * 0.2);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(0, H / 2 - 0.5, W, 1);
  } else if (f.layout === "stack") {
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    ctx.fillRect(0, 0, W, (W * 9) / 16);
    person(W / 2, H * 0.55, W * 0.24);
  } else person(W / 2, H * 0.36, W * 0.28);
}
