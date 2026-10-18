import { useEffect, useMemo, useRef, useState } from "react";
import { CAPTION_FONT_FRAC, HOOK_FONT_FRAC, groupCaptionLines, lineSecondsFor, captionMaxChars, lineDisplayEnd, emphasisKey, speakerCrop, cropX, contentStackGeometry, isFullFrame, type ContentRegion, type Style, type SourceOverlay } from "@reelsaw/shared";

export type PreviewLayout = "face" | "split" | "stack" | "fit" | "center" | "none";
export interface Framing {
  layout: PreviewLayout;
  /** normalized face centre */
  cx: number;
  cy: number;
  cx2?: number;
  cy2?: number;
  /** median face height (fraction of source height) for speaker-sized split/stack crops */
  size?: number;
  size2?: number;
  /** "stack": the region shown on top (absent = the whole frame) */
  content?: ContentRegion;
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
  platform?: Platform;
  /** small label in the top-left corner (e.g. which framing is showing) */
  tag?: string;
  /** burned-in source text to blur (and keep out of speaker crops), like the renderer */
  overlays?: SourceOverlay[];
  className?: string;
}

const FONT = `"DejaVu Sans", Verdana, system-ui, sans-serif`;
const SNAP = 0.03;

export type Platform = "tiktok" | "shorts" | "reels";
export const PLATFORM_NAME: Record<Platform, string> = { tiktok: "TikTok", shorts: "Shorts", reels: "Reels" };
/** Approximate platform chrome on a 9:16 frame, as fractions of the frame. */
export const SAFE_ZONES: Record<Platform, { top: number; bottom: number; rail: { top: number; bottom: number; width: number } }> = {
  tiktok: { top: 0.07, bottom: 0.2, rail: { top: 0.38, bottom: 0.2, width: 0.13 } },
  shorts: { top: 0.06, bottom: 0.18, rail: { top: 0.45, bottom: 0.18, width: 0.12 } },
  reels: { top: 0.07, bottom: 0.22, rail: { top: 0.5, bottom: 0.22, width: 0.12 } },
};
/** A sentence when the caption sits under platform UI, else "". */
export function safeZoneWarning(platform: Platform, x: number, y: number) {
  const z = SAFE_ZONES[platform];
  const n = PLATFORM_NAME[platform];
  if (y > 1 - z.bottom) return `Caption sits under the ${n} description area. Move it up to keep it readable.`;
  if (x > 1 - z.rail.width - 0.2 && y > z.rail.top && y < 1 - z.rail.bottom) return `Caption overlaps the ${n} buttons.`;
  if (y < z.top) return `Caption sits under the ${n} top bar.`;
  return "";
}

/**
 * 9:16 preview that mirrors the renderer: the frame is drawn on a canvas with the same crop math as
 * `layoutFilter` (render.ts), captions/hook are HTML on top at the same fractional positions and font
 * sizes as the ASS file, and can be dragged to move them.
 */
export function VerticalPreview({ source, srcW, srcH, framing, style, words, time, hook, emphasis, alwaysShowHook, onStyleChange, onPan, showSafeZones, platform = "tiktok", tag, overlays, className = "" }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [h, setH] = useState(0);
  const [drag, setDrag] = useState<null | "caption" | "hook" | "pan">(null);
  const panX = useRef(0);
  const [snappedX, setSnappedX] = useState(false);
  const [snappedY, setSnappedY] = useState(false);
  const framingRef = useRef(framing);
  framingRef.current = framing;
  const overlaysRef = useRef(overlays ?? []);
  overlaysRef.current = overlays ?? [];

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
          paint(ctx, W, H, source, srcW, srcH, framingRef.current, overlaysRef.current);
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
      if (dx) onPan(-(dx / W) * cropFraction(framing, srcW, srcH, W, boxRef.current.clientHeight));
      return;
    }
    if (!drag || !boxRef.current || !onStyleChange) return;
    const r = boxRef.current.getBoundingClientRect();
    // kept 15–85% horizontally and 4–94% vertically so text never leaves the frame; centre snap within 3%, Alt skips
    let x = (e.clientX - r.left) / r.width;
    let y = (e.clientY - r.top) / r.height;
    const sx = Math.abs(x - 0.5) < SNAP && !e.altKey;
    const sy = Math.abs(y - 0.5) < SNAP && !e.altKey;
    if (sx) x = 0.5;
    if (sy) y = 0.5;
    x = Math.max(0.15, Math.min(0.85, x));
    y = Math.max(0.04, Math.min(0.94, y));
    setSnappedX(sx);
    setSnappedY(sy);
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    onStyleChange(drag === "caption" ? { captionX: r3(x), captionY: r3(y) } : { hookX: r3(x), hookY: r3(y) });
  }
  function onPointerUp() {
    setDrag(null);
    setSnappedX(false);
    setSnappedY(false);
  }

  const capPx = h * CAPTION_FONT_FRAC * style.captionSize;
  const hookPx = h * HOOK_FONT_FRAC;
  const draggable = !!onStyleChange;

  return (
    <div
      ref={boxRef}
      className={`relative mx-auto aspect-[9/16] h-full max-w-full touch-none select-none overflow-hidden rounded-[14px] bg-black shadow-pop ${pannable ? (drag === "pan" ? "cursor-grabbing" : "cursor-grab") : ""} ${className}`}
      title={pannable ? "Drag the picture to re-centre the crop" : undefined}
      onPointerDown={onPanStart}
      onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {showSafeZones && <SafeZones platform={platform} />}
      {tag && <span className="pointer-events-none absolute left-2 top-2 z-10 rounded-[6px] bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">{tag}</span>}
      {drag && drag !== "pan" && snappedX && <div className="pointer-events-none absolute inset-y-0 left-1/2 z-10 w-0 border-l-2 border-snap" />}
      {drag && drag !== "pan" && snappedY && <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 h-0 border-t-2 border-snap" />}

      {showHook && (
        <div
          className={`absolute -translate-x-1/2 -translate-y-1/2 text-center font-bold leading-tight ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${drag === "hook" ? "outline-1 outline-dashed outline-white/60" : draggable ? "hover:outline-1 hover:outline-dashed hover:outline-white/50" : ""}`}
          style={{ left: `${style.hookX * 100}%`, top: `${style.hookY * 100}%`, fontFamily: FONT, fontSize: hookPx, maxWidth: width * 0.88, width: "max-content", background: "#fff", color: "#000", padding: `${hookPx * 0.2}px ${hookPx * 0.3}px` }}
          onPointerDown={(e) => onPointerDown("hook", e)}
          title={draggable ? "Drag to move the hook" : undefined}
        >
          {hook!.toUpperCase()}
        </div>
      )}

      {style.captions !== "none" && line && (
        <div
          className={`absolute -translate-x-1/2 -translate-y-1/2 text-center font-bold leading-tight ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${drag === "caption" ? "outline-1 outline-dashed outline-white/60" : draggable ? "hover:outline-1 hover:outline-dashed hover:outline-white/50" : ""}`}
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
                <span style={active ? { color: style.highlightColor, fontSize: "1.12em" } : isEm ? { color: style.emphasisColor, fontSize: "1.12em" } : undefined}>{t}</span>
                {i < line.length - 1 ? " " : ""}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Platform UI chrome: top bar, right-hand buttons and the username + description area. */
function SafeZones({ platform }: { platform: Platform }) {
  const z = SAFE_ZONES[platform];
  const n = PLATFORM_NAME[platform];
  const zone = "pointer-events-none absolute bg-[rgba(255,92,92,.22)] outline outline-1 outline-dashed outline-[rgba(255,92,92,.55)]";
  const lab = "pointer-events-none absolute text-[9px] font-semibold text-white/90 [text-shadow:0_1px_2px_#000]";
  return (
    <>
      <div className={zone} style={{ left: 0, right: 0, top: 0, height: `${z.top * 100}%` }} />
      <div className={zone} style={{ left: 0, right: 0, bottom: 0, height: `${z.bottom * 100}%` }} />
      <div className={zone} style={{ right: 0, top: `${z.rail.top * 100}%`, bottom: `${z.rail.bottom * 100}%`, width: `${z.rail.width * 100}%` }} />
      <span className={lab} style={{ left: 6, bottom: `calc(${z.bottom * 100}% - 14px)` }}>
        {n} username + description
      </span>
      <span className={`${lab} [writing-mode:vertical-rl]`} style={{ right: 4, top: `${z.rail.top * 100 + 1}%` }}>
        {n} buttons
      </span>
    </>
  );
}

/** Width of the crop window as a fraction of the source width, per layout (mirrors paint()). */
function cropFraction(f: Framing, srcW: number, srcH: number, W: number, H: number) {
  if (f.layout === "split") return speakerCrop(srcW, srcH, W / (H / 2), { cy: f.cy, size: f.size ?? 0.3 }).w / srcW;
  if (f.layout === "stack" && !isFullFrame(f.content)) return contentStackGeometry(srcW, srcH, f.content!, { cy: f.cy, size: f.size ?? 0.3 }, W / (H / 2)).zoom.w / srcW;
  if (f.layout === "stack") {
    const botH = H - (W * srcH) / srcW;
    return speakerCrop(srcW, srcH, W / Math.max(1, botH), { cy: f.cy, size: f.size ?? 0.17 }).w / srcW;
  }
  return Math.min(1, (srcH * 9) / 16 / srcW);
}

// ---------- canvas painter, mirrors layoutFilter() in apps/server/src/pipeline/render.ts ----------

function ready(src: HTMLVideoElement | HTMLImageElement | null): src is HTMLVideoElement | HTMLImageElement {
  if (!src) return false;
  if (src instanceof HTMLVideoElement) return src.readyState >= 2 && src.videoWidth > 0;
  return src.complete && src.naturalWidth > 0;
}

function paint(ctx: CanvasRenderingContext2D, W: number, H: number, src: HTMLVideoElement | HTMLImageElement | null, sw0: number, sh0: number, f: Framing, overlays: SourceOverlay[]) {
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
  const raw = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) => {
    try {
      ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
    } catch {
      /* frame not decodable yet */
    }
  };
  // draw a source window, then blur any burned-in text inside it (mirrors the renderer's mask)
  const draw = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) => {
    raw(sx, sy, sw, sh, dx, dy, dw, dh);
    const prevFilter = ctx.filter;
    for (const o of overlays) {
      const ox1 = Math.max(sx, o.x1 * srcW - 0.01 * srcW);
      const oy1 = Math.max(sy, o.y1 * srcH - 0.012 * srcH);
      const ox2 = Math.min(sx + sw, o.x2 * srcW + 0.01 * srcW);
      const oy2 = Math.min(sy + sh, o.y2 * srcH + 0.012 * srcH);
      if (ox2 <= ox1 || oy2 <= oy1) continue;
      const kx = dw / sw;
      const ky = dh / sh;
      const rx = dx + (ox1 - sx) * kx;
      const ry = dy + (oy1 - sy) * ky;
      const rw = (ox2 - ox1) * kx;
      const rh = (oy2 - oy1) * ky;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rx, ry, rw, rh);
      ctx.clip();
      ctx.filter = `blur(${Math.max(2, Math.min(rw, rh) / 4)}px)`;
      raw(sx, sy, sw, sh, dx, dy, dw, dh);
      ctx.restore();
    }
    ctx.filter = prevFilter;
  };
  const avoid = overlays.map((o) => ({ y1: o.y1, y2: o.y2 }));

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
      // speaker-sized crops, same geometry as the renderer (speakerCrop in @reelsaw/shared)
      const halfH = H / 2;
      const a = speakerCrop(srcW, srcH, W / halfH, { cy: f.cy, size: f.size ?? 0.3 }, avoid);
      const b = speakerCrop(srcW, srcH, W / halfH, { cy: f.cy2 ?? f.cy, size: f.size2 ?? f.size ?? 0.3 }, avoid);
      draw(cropX(srcW, a.w, f.cx), a.y, a.w, a.h, 0, 0, W, halfH);
      draw(cropX(srcW, b.w, f.cx2 ?? 1 - f.cx), b.y, b.w, b.h, 0, halfH, W, halfH);
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, halfH - 0.5, W, 1);
      return;
    }
    case "stack": {
      if (!isFullFrame(f.content)) {
        // mirrors layoutFilter: the content region fitted over a blurred copy of itself on top, speaker below
        const halfH = H / 2;
        const g = contentStackGeometry(srcW, srcH, f.content!, { cy: f.cy, size: f.size ?? 0.3 }, W / halfH, avoid);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, W, halfH);
        ctx.clip();
        const c = g.content;
        const cover = Math.max(W / c.w, halfH / c.h);
        ctx.filter = "blur(14px)";
        draw(c.x, c.y, c.w, c.h, (W - c.w * cover) / 2, (halfH - c.h * cover) / 2, c.w * cover, c.h * cover);
        ctx.filter = "none";
        const fit = Math.min(W / c.w, halfH / c.h);
        draw(c.x, c.y, c.w, c.h, (W - c.w * fit) / 2, (halfH - c.h * fit) / 2, c.w * fit, c.h * fit);
        ctx.restore();
        const zx = clamp(f.cx * srcW - g.zoom.w / 2, g.free.lo, g.free.hi - g.zoom.w);
        draw(zx, g.zoom.y, g.zoom.w, g.zoom.h, 0, halfH, W, halfH);
        return;
      }
      const topH = (W * srcH) / srcW;
      const botH = H - topH;
      draw(0, 0, srcW, srcH, 0, 0, W, topH);
      const z = speakerCrop(srcW, srcH, W / Math.max(1, botH), { cy: f.cy, size: f.size ?? 0.17 }, avoid);
      draw(cropX(srcW, z.w, f.cx), z.y, z.w, z.h, 0, topH, W, botH);
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
