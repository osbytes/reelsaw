import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { textFontFamily } from "../lib/fonts";
import {
  OVERLAY_PAD_X,
  OVERLAY_PAD_Y,
  verticalCrop,
  CAPTION_FONT_FRAC,
  HOOK_FONT_FRAC,
  groupCaptionLines,
  lineSecondsFor,
  captionMaxChars,
  lineDisplayEnd,
  emphasisKey,
  speakerCrop,
  cropX,
  contentStackGeometry,
  isFullFrame,
  tileCrop,
  defaultStyle,
  captionYAt,
  type ContentRegion,
  type Style,
  type SourceOverlay,
  type SeamRun,
} from "@reelsaw/shared";

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
  /** "stack": the speaker is a webcam tile at these bounds; the bottom pane shows the tile alone */
  tile?: ContentRegion;
  /** a crop the user fixed on the first pane (the only pane, the top of a split, the speaker of a stack): shown at its own shape over a blurred copy */
  crop?: ContentRegion | undefined;
  /** a crop the user fixed on the bottom pane of a split */
  crop2?: ContentRegion | undefined;
}
/** What a right-click on the frame landed on: a crop pane, or the top (content) part of a stack. */
export type PaneHit = 0 | 1 | "top";
export interface PreviewWord {
  text: string;
  /** seconds relative to the clip start */
  start: number;
  end: number;
}

/** An overlay as the preview draws it (fractions of the 9:16 frame): a library image/video, or a line of text. */
export type PreviewAssetOverlay =
  | {
      kind: "asset";
      id: string;
      /** the library file (`/media/assets/:id`); GIFs as img, video (including GIF-as-mp4) as video */
      url: string;
      name: string;
      /** asset width / height, so the box keeps the file's shape like the renderer's scale=w:-2; 0 = measure from the file */
      aspect: number;
      x: number;
      y: number;
      w: number;
      opacity: number;
      /** true = <video> (muted); false / absent = <img>, which loops GIFs natively */
      video?: boolean;
      /** looping sticker; a one-shot b-roll follows `offsetSec` instead */
      loop?: boolean;
      /** seconds into the overlay file when the clip is at the current time (b-roll) */
      offsetSec?: number;
    }
  | {
      kind: "text";
      id: string;
      text: string;
      x: number;
      y: number;
      /** font size as a fraction of the frame height (mirrors the ASS event) */
      size: number;
      color: string;
      box: boolean;
      opacity: number;
      /** font family (TEXT_FONTS); absent = the caption font */
      font?: string;
    };

/** Where a layout's crop panes sit in the 9:16 frame, as [top, bottom] fractions; a stack's top part is content, not a crop. */
export function paneBands(f: Framing, srcW: number, srcH: number): Array<[number, number]> {
  if (f.layout === "split")
    return [
      [0, 0.5],
      [0.5, 1],
    ];
  if (f.layout === "stack") return [[isFullFrame(f.content) ? Math.min(0.9, (1080 * srcH) / srcW / 1920) : 0.5, 1]];
  if (f.layout === "face" || f.layout === "center") return [[0, 1]];
  // a fitted frame has nothing to pan, unless the user fixed a crop on it (then the crop's window moves)
  if (f.layout === "fit" && f.crop) return [[0, 1]];
  return [];
}
/** Which crop pane the pointer is over at a frame position: 0 = the only pane or the top of a split, 1 = the bottom of a split. */
export function paneAt(f: Framing, srcW: number, srcH: number, yFrac: number): 0 | 1 | null {
  const bands = paneBands(f, srcW, srcH);
  const i = bands.findIndex(([a, b]) => yFrac >= a && yFrac < b);
  return i === 0 ? 0 : i === 1 ? 1 : null;
}
/** What a right-click at a frame position is about: a crop pane, the top of a stack, or the whole fitted frame (pane 0); nothing on `none`. */
export function paneHitAt(f: Framing, srcW: number, srcH: number, yFrac: number): PaneHit | null {
  if (f.layout === "none") return null;
  const pane = paneAt(f, srcW, srcH, yFrac);
  if (pane !== null) return pane;
  return f.layout === "stack" ? "top" : 0;
}

/** The shape of a pane in the 9:16 output (width / height), for a crop that should fill it exactly. */
export function paneAspect(f: Framing, srcW: number, srcH: number, hit: PaneHit): number {
  if (f.layout === "split") return 9 / 8;
  if (f.layout === "stack") {
    if (!isFullFrame(f.content)) return 9 / 8;
    const topH = (1080 * srcH) / srcW;
    return hit === "top" ? srcW / srcH : 1080 / Math.max(1, 1920 - topH);
  }
  return 9 / 16;
}

/** The window of the source a pane shows, in source pixels: the same geometry `paint` draws (a fixed crop, a tile, or the face-sized / full-height window). */
export function paneRect(f: Framing, srcW: number, srcH: number, pane: 0 | 1): { x: number; y: number; w: number; h: number } {
  const halfAspect = 9 / 8; // a split / stack half is 1080x960
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const fixed = pane === 0 ? f.crop : f.crop2;
  if (fixed) return tileCrop(srcW, srcH, fixed);
  if (f.layout === "stack" && f.tile) return tileCrop(srcW, srcH, f.tile);
  if (f.layout === "split") {
    const c = speakerCrop(srcW, srcH, halfAspect, pane === 0 ? { cy: f.cy, size: f.size ?? 0.3 } : { cy: f.cy2 ?? f.cy, size: f.size2 ?? f.size ?? 0.3 });
    return { x: cropX(srcW, c.w, pane === 0 ? f.cx : (f.cx2 ?? 1 - f.cx)), y: c.y, w: c.w, h: c.h };
  }
  if (f.layout === "stack" && !isFullFrame(f.content)) {
    const g = contentStackGeometry(srcW, srcH, f.content!, { cy: f.cy, size: f.size ?? 0.3 }, halfAspect);
    return { x: clamp(f.cx * srcW - g.zoom.w / 2, g.free.lo, g.free.hi - g.zoom.w), y: g.zoom.y, w: g.zoom.w, h: g.zoom.h };
  }
  if (f.layout === "stack") {
    const topH = (1080 * srcH) / srcW;
    const botH = Math.max(1, 1920 - topH);
    const c = speakerCrop(srcW, srcH, 1080 / botH, { cy: f.cy, size: f.size ?? 0.17 });
    return { x: cropX(srcW, c.w, f.cx), y: c.y, w: c.w, h: c.h };
  }
  if (f.layout === "fit" || f.layout === "none") return { x: 0, y: 0, w: srcW, h: srcH };
  const v = verticalCrop(srcW, srcH);
  return { x: clamp(f.cx * srcW - v.w / 2, 0, srcW - v.w), y: (srcH - v.h) / 2, w: v.w, h: v.h };
}
/** The crop window of a pane as fractions of the source: how far the picture moves per unit of drag, and how far a face can be nudged before it leaves the pane. */
export function paneCrop(f: Framing, srcW: number, srcH: number, pane: 0 | 1): { w: number; h: number } {
  const r = paneRect(f, srcW, srcH, pane);
  return { w: r.w / srcW, h: r.h / srcH };
}

interface Props {
  /** Video or image element to sample frames from; null draws a placeholder. */
  source: HTMLVideoElement | HTMLImageElement | null;
  srcW: number;
  srcH: number;
  framing: Framing;
  style: Style;
  words: PreviewWord[];
  /** split / stack stretches on the words' clock: caption lines there sit on the seam, as the renderer places them */
  seams?: SeamRun[];
  /** clip-relative playback time (drives karaoke + hook visibility) */
  time: number;
  hook?: string;
  /** key words coloured with style.emphasisColor */
  emphasis?: string[];
  /** always show the hook (style editing) instead of only during the first seconds */
  alwaysShowHook?: boolean;
  onStyleChange?: (patch: Partial<Style>) => void;
  /** drag the picture to re-centre a pane's crop; deltas are fractions of the source width / height */
  onPan?: (pane: 0 | 1, deltaX: number, deltaY: number) => void;
  /** the drag on a pane ended (the editor decides whether it was a nudge or a new subject) */
  onPanEnd?: (pane: 0 | 1) => void;
  /** library overlays active at `time`, drawn over the frame; the selected one can be dragged and resized */
  assetOverlays?: PreviewAssetOverlay[];
  selectedOverlay?: string | null;
  onOverlaySelect?: (id: string | null) => void;
  /**
   * drag / resize of the selected overlay (`w` for an asset, `size` for text), or its words retyped on the canvas
   * (double-click a text layer); `key` groups one gesture into one undo step
   */
  onOverlayChange?: (id: string, patch: { x?: number; y?: number; w?: number; size?: number; text?: string }, key: string) => void;
  /**
   * the right-click menu of an overlay: the editor's actions as `OverlayMenuItem`s; `editText` opens the inline text
   * editor on a text layer (right-clicking selects the layer first)
   */
  overlayMenu?: (o: PreviewAssetOverlay, ctx: { editText: () => void }) => ReactNode;
  /** the right-click menu of the picture itself: the editor's actions for the pane under the pointer (fix its crop, reset it) */
  paneMenu?: (hit: PaneHit) => ReactNode;
  /** the hook's words retyped on the canvas (double-click it, or Edit text in its right-click menu) */
  onHookChange?: (text: string) => void;
  /** pause overlay videos with the clip (GIFs as <img> keep looping) */
  playing?: boolean;
  /** a still shown instead of the video (the intro/outro poster while its block is selected) with its tag */
  still?: { url: string; tag: string } | null;
  showSafeZones?: boolean;
  platform?: Platform;
  /** small label in the top-left corner (e.g. which framing is showing) */
  tag?: string | undefined;
  /** burned-in source text to blur (and keep out of speaker crops), like the renderer */
  overlays?: SourceOverlay[];
  className?: string;
}

/** A muted overlay video: looping stickers play on their own even while the clip is paused; b-roll follows the clip clock. */
function OverlayVideo({
  src,
  loop,
  offsetSec,
  playing,
  onSize,
}: {
  src: string;
  loop: boolean;
  offsetSec: number;
  playing: boolean;
  onSize: (w: number, h: number) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const follow = loop ? -1 : offsetSec;
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (loop) {
      if (v.paused) void v.play().catch(() => {});
      return;
    }
    if (!playing) {
      v.pause();
      if (follow >= 0 && Math.abs(v.currentTime - follow) > 0.15) v.currentTime = Math.max(0, follow);
      return;
    }
    if (follow >= 0 && Math.abs(v.currentTime - follow) > 0.3) v.currentTime = Math.max(0, follow);
    if (v.paused) void v.play().catch(() => {});
  }, [playing, follow, src, loop]);
  return (
    <video
      ref={ref}
      src={src}
      muted
      playsInline
      autoPlay={loop}
      loop={loop}
      draggable={false}
      className="pointer-events-none h-full w-full object-contain"
      onLoadedMetadata={(e) => onSize(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
    />
  );
}

/** One row of an overlay's right-click menu (the editor supplies them through `overlayMenu`). */
export function OverlayMenuItem({
  icon,
  label,
  kbd,
  disabled,
  onSelect,
}: {
  icon?: ReactNode;
  label: ReactNode;
  kbd?: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <ContextMenu.Item className="menu-item" disabled={disabled} onSelect={onSelect}>
      {icon}
      {label}
      {kbd && <span className="kbd ml-auto">{kbd}</span>}
    </ContextMenu.Item>
  );
}
export function OverlayMenuSeparator() {
  return <ContextMenu.Separator className="mx-1.5 my-1 h-px bg-line" />;
}

/** A text layer's words, edited in place on the canvas: Enter or clicking away keeps them, Escape puts the old ones back. */
function InlineText({ text, onDone }: { text: string; onDone: (next: string | null) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(el);
    sel?.removeAllRanges();
    sel?.addRange(r);
  }, []);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(next);
  };
  return (
    <span
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-native-undo
      className="cursor-text outline-none"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(ref.current?.textContent ?? null);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={() => finish(ref.current?.textContent ?? null)}
    >
      {text}
    </span>
  );
}

const FONT = `"DejaVu Sans", Verdana, system-ui, sans-serif`;
const SNAP = 0.03;
/** a text layer's line, like the schema: one line, 1–120 characters */
const TEXT_MAX = 120;
/** the hook, like the clip schema: at most 80 characters */
const HOOK_MAX = 80;

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
export function VerticalPreview({
  source,
  srcW,
  srcH,
  framing,
  style,
  words,
  seams,
  time,
  hook,
  emphasis,
  alwaysShowHook,
  onStyleChange,
  onPan,
  onPanEnd,
  assetOverlays = [],
  selectedOverlay = null,
  onOverlaySelect,
  onOverlayChange,
  overlayMenu,
  paneMenu,
  onHookChange,
  playing = true,
  still,
  showSafeZones,
  platform = "tiktok",
  tag,
  overlays,
  className = "",
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [h, setH] = useState(0);
  /** the text layer being retyped on the canvas */
  const [editing, setEditing] = useState<string | null>(null);
  /** the hook being retyped on the canvas */
  const [editingHook, setEditingHook] = useState(false);
  /** what the picture's right-click menu is about (set as the menu opens) */
  const [menuHit, setMenuHit] = useState<PaneHit | null>(null);
  /** the last overlay pressed and when, to tell a double-click apart (see onOverlayStart) */
  const lastDown = useRef<{ id: string; at: number }>({ id: "", at: 0 });
  useEffect(() => {
    if (editing && !assetOverlays.some((o) => o.id === editing)) setEditing(null);
  }, [editing, assetOverlays]);
  const [naturalAspect, setNaturalAspect] = useState<Record<string, number>>({});
  const [drag, setDrag] = useState<
    | null
    | "caption"
    | "hook"
    | { pan: 0 | 1 }
    | { overlay: string; mode: "move" | "size"; key: string; grab: { x: number; y: number }; orig: { x: number; y: number; w: number }; text: boolean }
  >(null);
  const panX = useRef(0);
  const panY = useRef(0);
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

  const lines = useMemo(
    () => groupCaptionLines(words, style.wordsPerLine, lineSecondsFor(style.wordsPerLine), captionMaxChars(style.captionSize)),
    [words, style.wordsPerLine, style.captionSize],
  );
  const lineIdx = lines.findIndex((l, i) => time >= l[0]!.start && time <= lineDisplayEnd(lines, i));
  const line = lineIdx >= 0 ? lines[lineIdx] : alwaysShowHook ? lines[0] : undefined;
  const em = useMemo(() => new Set(style.emphasis ? (emphasis ?? []).map(emphasisKey) : []), [emphasis, style.emphasis]);
  // placed once per line, at its midpoint (captionYAt), like the ASS file
  const captionY = line ? captionYAt(style, seams ?? [], lineIdx >= 0 ? (line[0]!.start + lineDisplayEnd(lines, lineIdx)) / 2 : time) : style.captionY;
  const activeIdx = line
    ? line.findIndex((w, i) => time >= (i === 0 ? line[0]!.start : w.start) && time < (i === line.length - 1 ? line[line.length - 1]!.end : line[i + 1]!.start))
    : -1;
  const showHook = style.showHook && !!hook && (alwaysShowHook || editingHook || time < style.hookSeconds);
  const width = (h * 9) / 16;

  function onPointerDown(kind: "caption" | "hook", e: React.PointerEvent) {
    if (!onStyleChange || (kind === "hook" && editingHook)) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(kind);
  }
  const pannable = !!onPan && paneBands(framing, srcW, srcH).length > 0;
  function onPanStart(e: React.PointerEvent) {
    if (!pannable || e.button !== 0 || !boxRef.current) return;
    const r = boxRef.current.getBoundingClientRect();
    const pane = paneAt(framing, srcW, srcH, (e.clientY - r.top) / r.height);
    if (pane === null) return;
    e.preventDefault();
    boxRef.current.setPointerCapture(e.pointerId);
    panX.current = e.clientX;
    panY.current = e.clientY;
    onOverlaySelect?.(null);
    setDrag({ pan: pane });
  }
  function onOverlayStart(o: PreviewAssetOverlay, mode: "move" | "size", e: React.PointerEvent) {
    if (!onOverlayChange || e.button !== 0 || !boxRef.current || editing === o.id) return;
    e.preventDefault();
    e.stopPropagation();
    // preventDefault on pointerdown stops the browser's click / dblclick events, so a double-click is counted here
    if (mode === "move" && o.kind === "text" && lastDown.current.id === o.id && e.timeStamp - lastDown.current.at < 400) {
      lastDown.current = { id: "", at: 0 };
      onOverlaySelect?.(o.id);
      setEditing(o.id);
      return;
    }
    lastDown.current = { id: o.id, at: e.timeStamp };
    boxRef.current.setPointerCapture(e.pointerId);
    onOverlaySelect?.(o.id);
    const r = boxRef.current.getBoundingClientRect();
    // for text the "width" being resized is the font size (fraction of the height)
    setDrag({
      overlay: o.id,
      mode,
      key: `g:ov-${mode}:${Date.now()}`,
      grab: { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height },
      orig: { x: o.x, y: o.y, w: o.kind === "text" ? o.size : o.w },
      text: o.kind === "text",
    });
  }
  function onPointerMove(e: React.PointerEvent) {
    if (drag && typeof drag === "object" && "pan" in drag && boxRef.current && onPan) {
      const W = boxRef.current.clientWidth;
      const H = boxRef.current.clientHeight;
      const dx = e.clientX - panX.current;
      const dy = e.clientY - panY.current;
      panX.current = e.clientX;
      panY.current = e.clientY;
      if (!dx && !dy) return;
      // dragging the picture right moves the crop window left; the pane's own height scales the vertical drag
      const crop = paneCrop(framing, srcW, srcH, drag.pan);
      const band = paneBands(framing, srcW, srcH)[drag.pan] ?? [0, 1];
      const paneH = H * (band[1] - band[0]);
      onPan(drag.pan, -(dx / W) * crop.w, crop.h >= 0.999 ? 0 : -(dy / paneH) * crop.h);
      return;
    }
    if (drag && typeof drag === "object" && "overlay" in drag && boxRef.current && onOverlayChange) {
      const r = boxRef.current.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width;
      const py = (e.clientY - r.top) / r.height;
      const r3 = (n: number) => Math.round(n * 1000) / 1000;
      if (drag.mode === "move")
        onOverlayChange(
          drag.overlay,
          { x: r3(Math.max(0, Math.min(1, drag.orig.x + px - drag.grab.x))), y: r3(Math.max(0, Math.min(1, drag.orig.y + py - drag.grab.y))) },
          drag.key,
        );
      else if (drag.text) onOverlayChange(drag.overlay, { size: r3(Math.max(0.02, Math.min(0.12, drag.orig.w + (py - drag.grab.y) * 0.5))) }, drag.key);
      else {
        // width-only in the file (the renderer is scale=w:-2); grow from either axis so a downward corner drag still scales
        const dwx = 2 * (px - drag.grab.x);
        const dwy = 2 * (py - drag.grab.y);
        const dw = Math.abs(dwx) >= Math.abs(dwy) ? dwx : dwy;
        onOverlayChange(drag.overlay, { w: r3(Math.max(0.05, Math.min(1, drag.orig.w + dw))) }, drag.key);
      }
      return;
    }
    if (!drag || typeof drag !== "string" || !boxRef.current || !onStyleChange) return;
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
    if (drag && typeof drag === "object" && "pan" in drag) onPanEnd?.(drag.pan);
    setDrag(null);
    setSnappedX(false);
    setSnappedY(false);
  }
  const panning = !!drag && typeof drag === "object" && "pan" in drag;

  const capPx = h * CAPTION_FONT_FRAC * style.captionSize;
  const hookPx = h * HOOK_FONT_FRAC;
  const draggable = !!onStyleChange;
  const hookHint = draggable ? `Drag to move the hook${onHookChange ? ", double-click to edit" : ""}, right-click for more` : undefined;
  /** the hook's right-click menu: retype it, put it back in the middle, or hide it (the editor's style keeps the change) */
  const hookMenu = (
    <>
      {onHookChange && <OverlayMenuItem label="Edit text" kbd="dbl-click" onSelect={() => setEditingHook(true)} />}
      <OverlayMenuItem label="Centre left / right" disabled={style.hookX === 0.5} onSelect={() => onStyleChange?.({ hookX: 0.5 })} />
      <OverlayMenuItem
        label="Reset position"
        disabled={style.hookX === defaultStyle.hookX && style.hookY === defaultStyle.hookY}
        onSelect={() => onStyleChange?.({ hookX: defaultStyle.hookX, hookY: defaultStyle.hookY })}
      />
      <OverlayMenuSeparator />
      <OverlayMenuItem label="Hide the hook" onSelect={() => onStyleChange?.({ showHook: false })} />
    </>
  );
  /** the picture's right-click menu wraps the frame; a layer or the hook under the pointer opens its own menu instead (they stop the event) */
  const withPaneMenu = (node: ReactNode) =>
    paneMenu ? (
      <ContextMenu.Root modal={false} onOpenChange={(o) => !o && setMenuHit(null)}>
        <ContextMenu.Trigger asChild>{node}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="menu z-[60] w-[220px]" collisionPadding={8}>
            {menuHit !== null && paneMenu(menuHit)}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    ) : (
      node
    );

  return withPaneMenu(
    <div
      ref={boxRef}
      className={`relative mx-auto aspect-[9/16] h-full max-w-full touch-none select-none overflow-hidden rounded-[14px] bg-black shadow-pop ${pannable ? (panning ? "cursor-grabbing" : "cursor-grab") : ""} ${className}`}
      title={
        pannable
          ? framing.layout === "split"
            ? "Drag either speaker to re-centre that pane; drop it on someone else to follow them"
            : framing.crop
              ? "Drag the picture to move the crop; right-click to set it exactly"
              : "Drag the picture to re-centre the crop; right-click to set it exactly"
          : paneMenu
            ? "Right-click to fix the crop"
            : undefined
      }
      onPointerDown={onPanStart}
      onContextMenu={(e) => {
        if (!paneMenu || !boxRef.current) return;
        const r = boxRef.current.getBoundingClientRect();
        const hit = paneHitAt(framingRef.current, srcW, srcH, (e.clientY - r.top) / r.height);
        if (hit === null) e.preventDefault();
        setMenuHit(hit);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
      {assetOverlays.map((o) => {
        const sel = o.id === selectedOverlay;
        const name = o.kind === "text" ? `“${o.text}”` : o.name;
        const isEditing = editing === o.id;
        const handle = sel && onOverlayChange && !isEditing && (
          <span
            className="absolute bottom-0.5 right-0.5 z-[1] h-3.5 w-3.5 cursor-nwse-resize rounded-[3px] border border-white bg-acc"
            onPointerDown={(e) => onOverlayStart(o, "size", e)}
            aria-label={`Resize ${name}`}
          />
        );
        const frame = `absolute -translate-x-1/2 -translate-y-1/2 ${isEditing ? "cursor-text" : onOverlayChange ? "cursor-move" : ""} ${sel ? "outline outline-2 outline-acc" : onOverlayChange ? "hover:outline hover:outline-1 hover:outline-dashed hover:outline-white/60" : ""}`;
        const hint = onOverlayChange
          ? `${name} · drag to move, corner to resize${o.kind === "text" ? ", double-click to edit" : ""}${overlayMenu ? ", right-click for more" : ""}`
          : name;
        // the editor's right-click menu around the block; right-clicking selects the layer first
        const withMenu = (node: ReactNode) =>
          overlayMenu ? (
            <ContextMenu.Root key={o.id} modal={false}>
              <ContextMenu.Trigger asChild>{node}</ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className="menu z-[60] w-[220px]" collisionPadding={8}>
                  <ContextMenu.Label className="truncate px-2.5 py-1 text-[11px] font-semibold text-ink3">{name}</ContextMenu.Label>
                  {overlayMenu(o, { editText: () => o.kind === "text" && !!onOverlayChange && setEditing(o.id) })}
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          ) : (
            node
          );
        if (o.kind === "text") {
          // same font and plate as the captions, so the preview matches the ASS event the renderer writes
          const px = h * o.size;
          return withMenu(
            <div
              key={o.id}
              className={`${frame} whitespace-nowrap text-center font-bold leading-tight`}
              style={{
                left: `${o.x * 100}%`,
                top: `${o.y * 100}%`,
                fontFamily: textFontFamily(o.font),
                fontSize: px,
                maxWidth: width * 0.88,
                color: o.color,
                opacity: o.opacity,
                ...(o.box
                  ? { background: "rgba(0,0,0,0.63)", padding: `${px * 0.12}px ${px * 0.25}px` }
                  : {
                      WebkitTextStroke: `${Math.max(1, px * 0.06)}px #000`,
                      paintOrder: "stroke fill",
                      textShadow: `0 ${px * 0.04}px ${px * 0.06}px rgba(0,0,0,0.5)`,
                    }),
              }}
              onPointerDown={(e) => onOverlayStart(o, "move", e)}
              onContextMenu={(e) => {
                e.stopPropagation();
                onOverlaySelect?.(o.id);
              }}
              title={isEditing ? undefined : hint}
            >
              {isEditing ? (
                <InlineText
                  text={o.text}
                  onDone={(next) => {
                    setEditing(null);
                    const t = next?.replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
                    if (t && t !== o.text) onOverlayChange?.(o.id, { text: t }, `ov-text:${o.id}:${Date.now()}`);
                  }}
                />
              ) : (
                o.text
              )}
              {handle}
            </div>,
          );
        }
        const aspect = o.aspect > 0.05 ? o.aspect : (naturalAspect[o.id] ?? 1);
        const wPx = o.w * width;
        const hPx = wPx / aspect;
        const noteSize = (w: number, h: number) => {
          if (!w || !h || o.aspect > 0.05) return;
          const next = w / h;
          setNaturalAspect((cur) => (Math.abs((cur[o.id] ?? 0) - next) < 0.01 ? cur : { ...cur, [o.id]: next }));
        };
        return withMenu(
          <div
            key={o.id}
            className={frame}
            style={{ left: `${o.x * 100}%`, top: `${o.y * 100}%`, width: wPx, height: hPx, opacity: o.opacity }}
            onPointerDown={(e) => onOverlayStart(o, "move", e)}
            onContextMenu={(e) => {
              e.stopPropagation();
              onOverlaySelect?.(o.id);
            }}
            title={hint}
          >
            {o.video ? (
              <OverlayVideo src={o.url} loop={!!o.loop} offsetSec={o.offsetSec ?? 0} playing={playing && !still} onSize={noteSize} />
            ) : (
              <img
                src={o.url}
                alt=""
                draggable={false}
                className="pointer-events-none h-full w-full object-contain"
                onLoad={(e) => noteSize(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
              />
            )}
            {handle}
          </div>,
        );
      })}
      {still && (
        <div className="absolute inset-0 z-[5] bg-black">
          <img src={still.url} alt="" className="h-full w-full object-cover" />
          <span className="pointer-events-none absolute left-2 top-2 rounded-[6px] bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">
            {still.tag}
          </span>
        </div>
      )}
      {showSafeZones && !still && <SafeZones platform={platform} />}
      {tag && !still && (
        <span className="pointer-events-none absolute left-2 top-2 z-10 rounded-[6px] bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">{tag}</span>
      )}
      {panning &&
        (() => {
          const pane = drag && typeof drag === "object" && "pan" in drag ? drag.pan : 0;
          const band = paneBands(framing, srcW, srcH)[pane];
          return band && !(band[0] === 0 && band[1] === 1) ? (
            <div
              className="pointer-events-none absolute inset-x-0 z-10 outline outline-2 -outline-offset-2 outline-acc"
              style={{ top: `${band[0] * 100}%`, height: `${(band[1] - band[0]) * 100}%` }}
            />
          ) : null;
        })()}
      {drag === "caption" || drag === "hook" ? (
        <>
          {snappedX && <div className="pointer-events-none absolute inset-y-0 left-1/2 z-10 w-0 border-l-2 border-snap" />}
          {snappedY && <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 h-0 border-t-2 border-snap" />}
        </>
      ) : null}

      {showHook &&
        !still &&
        (() => {
          const node = (
            <div
              className={`absolute -translate-x-1/2 -translate-y-1/2 text-center font-bold leading-tight ${editingHook ? "cursor-text" : draggable ? "cursor-grab active:cursor-grabbing" : ""} ${drag === "hook" || editingHook ? "outline-1 outline-dashed outline-white/60" : draggable ? "hover:outline-1 hover:outline-dashed hover:outline-white/50" : ""}`}
              style={{
                left: `${style.hookX * 100}%`,
                top: `${style.hookY * 100}%`,
                fontFamily: FONT,
                fontSize: hookPx,
                maxWidth: width * 0.88,
                width: "max-content",
                background: "#fff",
                color: "#000",
                padding: `${hookPx * 0.2}px ${hookPx * 0.3}px`,
              }}
              onPointerDown={(e) => onPointerDown("hook", e)}
              onDoubleClick={() => onHookChange && setEditingHook(true)}
              onContextMenu={(e) => e.stopPropagation()}
              title={editingHook ? undefined : hookHint}
            >
              {editingHook ? (
                <InlineText
                  text={hook!}
                  onDone={(next) => {
                    setEditingHook(false);
                    const t = next?.replace(/\s+/g, " ").trim().slice(0, HOOK_MAX);
                    if (t && t !== hook) onHookChange?.(t);
                  }}
                />
              ) : (
                hook!.toUpperCase()
              )}
            </div>
          );
          return draggable ? (
            <ContextMenu.Root modal={false}>
              <ContextMenu.Trigger asChild>{node}</ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className="menu z-[60] w-[220px]" collisionPadding={8}>
                  <ContextMenu.Label className="truncate px-2.5 py-1 text-[11px] font-semibold text-ink3">Hook</ContextMenu.Label>
                  {hookMenu}
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          ) : (
            node
          );
        })()}

      {style.captions !== "none" && line && !still && (
        <div
          className={`absolute -translate-x-1/2 -translate-y-1/2 text-center font-bold leading-tight ${draggable ? "cursor-grab active:cursor-grabbing" : ""} ${drag === "caption" ? "outline-1 outline-dashed outline-white/60" : draggable ? "hover:outline-1 hover:outline-dashed hover:outline-white/50" : ""}`}
          style={{
            left: `${style.captionX * 100}%`,
            top: `${(drag === "caption" ? style.captionY : captionY) * 100}%`,
            fontFamily: FONT,
            fontSize: capPx,
            maxWidth: width * 0.88,
            width: "max-content",
            color: "#fff",
            ...(style.captions === "box"
              ? { background: "rgba(0,0,0,0.63)", padding: `${capPx * 0.12}px ${capPx * 0.25}px` }
              : {
                  WebkitTextStroke: `${Math.max(1, capPx * 0.06)}px #000`,
                  paintOrder: "stroke fill",
                  textShadow: `0 ${capPx * 0.04}px ${capPx * 0.06}px rgba(0,0,0,0.5)`,
                }),
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
                <span
                  style={active ? { color: style.highlightColor, fontSize: "1.12em" } : isEm ? { color: style.emphasisColor, fontSize: "1.12em" } : undefined}
                >
                  {t}
                </span>
                {i < line.length - 1 ? " " : ""}
              </span>
            );
          })}
        </div>
      )}
    </div>,
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

// ---------- canvas painter, mirrors layoutFilter() in apps/server/src/pipeline/render.ts ----------

function ready(src: HTMLVideoElement | HTMLImageElement | null): src is HTMLVideoElement | HTMLImageElement {
  if (!src) return false;
  if (src instanceof HTMLVideoElement) return src.readyState >= 2 && src.videoWidth > 0;
  return src.complete && src.naturalWidth > 0;
}

function paint(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  src: HTMLVideoElement | HTMLImageElement | null,
  sw0: number,
  sh0: number,
  f: Framing,
  overlays: SourceOverlay[],
) {
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
      const ox1 = Math.max(sx, o.x1 * srcW - OVERLAY_PAD_X * srcW);
      const oy1 = Math.max(sy, o.y1 * srcH - OVERLAY_PAD_Y * srcH);
      const ox2 = Math.min(sx + sw, o.x2 * srcW + OVERLAY_PAD_X * srcW);
      const oy2 = Math.min(sy + sh, o.y2 * srcH + OVERLAY_PAD_Y * srcH);
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
  // a source rectangle fitted at its own aspect over a blurred copy of itself, inside a pane (mirrors FIT_CHAIN / fitPane)
  const fitted = (c: { x: number; y: number; w: number; h: number }, py: number, ph: number) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, py, W, ph);
    ctx.clip();
    const cover = Math.max(W / c.w, ph / c.h);
    ctx.filter = "blur(14px)";
    draw(c.x, c.y, c.w, c.h, (W - c.w * cover) / 2, py + (ph - c.h * cover) / 2, c.w * cover, c.h * cover);
    ctx.filter = "none";
    const fit = Math.min(W / c.w, ph / c.h);
    draw(c.x, c.y, c.w, c.h, (W - c.w * fit) / 2, py + (ph - c.h * fit) / 2, c.w * fit, c.h * fit);
    ctx.restore();
  };
  // a crop the user fixed on a whole-frame pane: that part of the source, at its own shape over a blurred copy
  if (f.crop && f.layout !== "split" && f.layout !== "stack" && f.layout !== "none") {
    fitted(tileCrop(srcW, srcH, f.crop), 0, H);
    return;
  }

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
      // a pane the user fixed to a part of the source shows just that
      if (f.crop) fitted(tileCrop(srcW, srcH, f.crop), 0, halfH);
      else draw(cropX(srcW, a.w, f.cx), a.y, a.w, a.h, 0, 0, W, halfH);
      if (f.crop2) fitted(tileCrop(srcW, srcH, f.crop2), halfH, halfH);
      else draw(cropX(srcW, b.w, f.cx2 ?? 1 - f.cx), b.y, b.w, b.h, 0, halfH, W, halfH);
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, halfH - 0.5, W, 1);
      return;
    }
    case "stack": {
      // the speaker pane is a webcam tile, or a crop the user fixed: that alone, not a face-sized window
      const fixed = f.crop ?? f.tile;
      if (!isFullFrame(f.content)) {
        // mirrors layoutFilter: the content region fitted over a blurred copy of itself on top, speaker below
        const halfH = H / 2;
        const g = contentStackGeometry(srcW, srcH, f.content!, { cy: f.cy, size: f.size ?? 0.3 }, W / halfH, avoid);
        fitted(g.content, 0, halfH);
        if (fixed) {
          fitted(tileCrop(srcW, srcH, fixed), halfH, halfH);
          return;
        }
        const zx = clamp(f.cx * srcW - g.zoom.w / 2, g.free.lo, g.free.hi - g.zoom.w);
        draw(zx, g.zoom.y, g.zoom.w, g.zoom.h, 0, halfH, W, halfH);
        return;
      }
      const topH = (W * srcH) / srcW;
      const botH = H - topH;
      draw(0, 0, srcW, srcH, 0, 0, W, topH);
      if (fixed) {
        fitted(tileCrop(srcW, srcH, fixed), topH, botH);
        return;
      }
      const z = speakerCrop(srcW, srcH, W / Math.max(1, botH), { cy: f.cy, size: f.size ?? 0.17 }, avoid);
      draw(cropX(srcW, z.w, f.cx), z.y, z.w, z.h, 0, topH, W, botH);
      return;
    }
    default: {
      // face / center: full-height 9:16 window
      const { w: cropW, h: cropH } = verticalCrop(srcW, srcH);
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
