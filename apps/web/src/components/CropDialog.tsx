import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Modal, Segmented } from "./ui";
import type { ContentRegion } from "@reelsaw/shared";

/** Which crop of a section the dialog edits: the pane's fixed crop, or what a stack shows on top. */
export type CropKey = "crop" | "crop2" | "contentCrop";
export interface CropPaneOption {
  key: CropKey;
  /** "Crop", "Top", "Bottom", "Screen", "Speaker" */
  name: string;
  /** the pane's shape in the output (width / height) */
  aspect: number;
  /** what the pane shows now without a fixed crop (the automatic window), for the box's starting place */
  auto: ContentRegion;
  /** the fixed crop stored on the section, if any */
  current?: ContentRegion | undefined;
}

type Fields = { left: string; top: string; width: string; height: string };
const pct = (v: number) => String(Math.round(v * 1000) / 10);
const fieldsOf = (r: ContentRegion): Fields => ({ left: pct(r.x1), top: pct(r.y1), width: pct(r.x2 - r.x1), height: pct(r.y2 - r.y1) });
/** smallest crop, as a fraction of the source on each axis */
const MIN = 0.05;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** A region kept inside the frame and at least MIN wide and tall. */
function tidy(r: ContentRegion): ContentRegion {
  const w = clamp(r.x2 - r.x1, MIN, 1);
  const h = clamp(r.y2 - r.y1, MIN, 1);
  const x1 = clamp(r.x1, 0, 1 - w);
  const y1 = clamp(r.y1, 0, 1 - h);
  return { x1: r3(x1), y1: r3(y1), x2: r3(x1 + w), y2: r3(y1 + h) };
}
/** The region the fields describe; null while a field is not a number. */
function regionOf(f: Fields): ContentRegion | null {
  const n = (s: string) => (s.trim() === "" ? NaN : Number(s) / 100);
  const left = n(f.left);
  const top = n(f.top);
  const width = n(f.width);
  const height = n(f.height);
  if (![left, top, width, height].every(Number.isFinite)) return null;
  return tidy({ x1: left, y1: top, x2: left + width, y2: top + height });
}

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Array<{ h: Handle; cls: string; cursor: string }> = [
  { h: "nw", cls: "-left-1.5 -top-1.5", cursor: "cursor-nwse-resize" },
  { h: "n", cls: "left-1/2 -top-1.5 -translate-x-1/2", cursor: "cursor-ns-resize" },
  { h: "ne", cls: "-right-1.5 -top-1.5", cursor: "cursor-nesw-resize" },
  { h: "e", cls: "-right-1.5 top-1/2 -translate-y-1/2", cursor: "cursor-ew-resize" },
  { h: "se", cls: "-right-1.5 -bottom-1.5", cursor: "cursor-nwse-resize" },
  { h: "s", cls: "left-1/2 -bottom-1.5 -translate-x-1/2", cursor: "cursor-ns-resize" },
  { h: "sw", cls: "-left-1.5 -bottom-1.5", cursor: "cursor-nesw-resize" },
  { h: "w", cls: "-left-1.5 top-1/2 -translate-y-1/2", cursor: "cursor-ew-resize" },
];
type Drag =
  | { kind: "move"; grab: { x: number; y: number }; orig: ContentRegion }
  | { kind: "size"; handle: Handle; orig: ContentRegion }
  | { kind: "draw"; from: { x: number; y: number } };

/**
 * Fix a pane's crop on the source picture: a box to drag and resize over the whole frame (or draw
 * anew on the empty part), with the numbers beside it as percentages of the source width and height.
 * A crop shaped like the pane fills it; any other shape is fitted at its own aspect over a blurred
 * copy, like a webcam tile. The box starts where the pane's automatic window is.
 */
export function CropDialog({
  open,
  onOpenChange,
  source,
  srcW,
  srcH,
  panes,
  initial,
  onApply,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  source: HTMLVideoElement | HTMLImageElement | null;
  srcW: number;
  srcH: number;
  panes: CropPaneOption[];
  initial: CropKey;
  onApply: (key: CropKey, region: ContentRegion | null) => void;
}) {
  const [key, setKey] = useState<CropKey>(initial);
  const pane = panes.find((p) => p.key === key) ?? panes[0]!;
  const [fields, setFields] = useState<Fields>(() => fieldsOf(pane.current ?? pane.auto));
  /** keep the box the pane's shape while resizing, so the crop fills the pane without bars */
  const [lock, setLock] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  // a fresh open, or another pane picked: start from that pane's crop
  useEffect(() => {
    if (open) setKey(initial);
  }, [open, initial]);
  useEffect(() => {
    const p = panes.find((o) => o.key === key) ?? panes[0]!;
    setFields(fieldsOf(p.current ?? p.auto));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open]);
  // the source frame at the playhead, drawn once the dialog is on screen
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const paint = () => {
      const c = canvasRef.current;
      if (!c) {
        raf = requestAnimationFrame(paint);
        return;
      }
      const W = c.clientWidth;
      const H = c.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#15171d";
      ctx.fillRect(0, 0, W, H);
      try {
        if (source) ctx.drawImage(source, 0, 0, W, H);
      } catch {
        /* frame not decodable yet */
      }
    };
    raf = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(raf);
  }, [open, source, key]);

  const region = regionOf(fields);
  const px = region && { w: Math.round((region.x2 - region.x1) * srcW), h: Math.round((region.y2 - region.y1) * srcH) };
  const fills = !!px && Math.abs(px.w / px.h / pane.aspect - 1) < 0.02;
  const setRegion = (r: ContentRegion) => setFields(fieldsOf(tidy(r)));
  const set = (k: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) => setFields((f) => ({ ...f, [k]: e.target.value }));
  /** the height that gives a width the pane's shape (fractions of the source) */
  const heightFor = (w: number) => (w * srcW) / pane.aspect / srcH;
  const widthFor = (h: number) => (h * srcH * pane.aspect) / srcW;
  /** the box reshaped to the pane's shape around its centre, as big as fits */
  const matchShape = () => {
    if (!region) return;
    const cx = (region.x1 + region.x2) / 2;
    const cy = (region.y1 + region.y2) / 2;
    let w = region.x2 - region.x1;
    let h = heightFor(w);
    if (h > 1) {
      h = 1;
      w = widthFor(h);
    }
    setRegion({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 });
  };

  const at = (e: React.PointerEvent) => {
    const r = frameRef.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
  };
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !frameRef.current || !region) return;
    e.preventDefault();
    const target = e.target as HTMLElement;
    const handle = target.dataset.handle as Handle | undefined;
    const p = at(e);
    if (handle) drag.current = { kind: "size", handle, orig: region };
    else if (target.dataset.box) drag.current = { kind: "move", grab: { x: p.x - region.x1, y: p.y - region.y1 }, orig: region };
    else drag.current = { kind: "draw", from: p };
    frameRef.current.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = at(e);
    if (d.kind === "move") {
      const w = d.orig.x2 - d.orig.x1;
      const h = d.orig.y2 - d.orig.y1;
      const x1 = clamp(p.x - d.grab.x, 0, 1 - w);
      const y1 = clamp(p.y - d.grab.y, 0, 1 - h);
      setRegion({ x1, y1, x2: x1 + w, y2: y1 + h });
      return;
    }
    if (d.kind === "draw") {
      const x1 = Math.min(d.from.x, p.x);
      const y1 = Math.min(d.from.y, p.y);
      let w = Math.max(MIN, Math.abs(p.x - d.from.x));
      let h = Math.max(MIN, Math.abs(p.y - d.from.y));
      if (lock) {
        h = heightFor(w);
        if (y1 + h > 1) {
          h = 1 - y1;
          w = widthFor(h);
        }
      }
      setRegion({ x1, y1, x2: x1 + w, y2: y1 + h });
      return;
    }
    // resize: the edges named by the handle follow the pointer, the others stay
    let { x1, y1, x2, y2 } = d.orig;
    const hnd = d.handle;
    if (hnd.includes("w")) x1 = Math.min(p.x, x2 - MIN);
    if (hnd.includes("e")) x2 = Math.max(p.x, x1 + MIN);
    if (hnd.includes("n")) y1 = Math.min(p.y, y2 - MIN);
    if (hnd.includes("s")) y2 = Math.max(p.y, y1 + MIN);
    if (lock) {
      // the dragged axis sets the size; the other axis follows, anchored at the still edge (or centred on an edge handle)
      const sideways = hnd === "e" || hnd === "w";
      const w = sideways || hnd.length === 2 ? x2 - x1 : widthFor(y2 - y1);
      const h = sideways || hnd.length === 2 ? heightFor(w) : y2 - y1;
      const ww = sideways || hnd.length === 2 ? w : widthFor(h);
      if (hnd.length === 2) {
        if (hnd.includes("n")) y1 = y2 - h;
        else y2 = y1 + h;
      } else if (sideways) {
        const cy = (d.orig.y1 + d.orig.y2) / 2;
        y1 = cy - h / 2;
        y2 = cy + h / 2;
      } else {
        const cx = (d.orig.x1 + d.orig.x2) / 2;
        x1 = cx - ww / 2;
        x2 = cx + ww / 2;
      }
      if (x1 < 0 || y1 < 0 || x2 > 1 || y2 > 1) return; // would leave the frame: hold
    }
    setRegion({ x1, y1, x2, y2 });
  };
  const onUp = () => {
    drag.current = null;
  };

  const field = (label: string, k: keyof Fields) => (
    <label className="flex flex-col gap-1 text-xs text-ink2">
      {label}
      <span className="relative">
        <input className="input pr-7 font-mono" inputMode="decimal" value={fields[k]} onChange={set(k)} aria-label={`${label}, percent of the source`} />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink3">%</span>
      </span>
    </label>
  );
  const box = region ?? pane.auto;
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Set the crop" width={720}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!region) return;
          onApply(key, region);
          onOpenChange(false);
        }}
      >
        <Dialog.Description className="text-sm leading-relaxed text-ink2">
          Drag the box over the picture, pull its corners, or draw a new one; the numbers are percentages of the source. The box starts where the pane looks
          now.
        </Dialog.Description>
        {panes.length > 1 && (
          <Segmented size="sm" ariaLabel="Which pane" value={key} options={panes.map((p) => ({ value: p.key, label: p.name }))} onChange={(k) => setKey(k)} />
        )}
        <div
          ref={frameRef}
          className="relative w-full cursor-crosshair touch-none select-none overflow-hidden rounded-[10px] bg-black"
          style={{ aspectRatio: `${srcW} / ${srcH}` }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
          <div
            data-box="1"
            className="absolute cursor-move border-2 border-acc shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
            style={{ left: `${box.x1 * 100}%`, top: `${box.y1 * 100}%`, width: `${(box.x2 - box.x1) * 100}%`, height: `${(box.y2 - box.y1) * 100}%` }}
            role="img"
            aria-label={`Crop box, ${fields.left}% from the left, ${fields.top}% from the top, ${fields.width}% wide, ${fields.height}% tall`}
          >
            {HANDLES.map(({ h, cls, cursor }) => (
              <span key={h} data-handle={h} className={`absolute h-3 w-3 rounded-[3px] border border-white bg-acc ${cls} ${cursor}`} />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {field("Left", "left")}
          {field("Top", "top")}
          {field("Width", "width")}
          {field("Height", "height")}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-relaxed text-ink3">
          <span>
            {!region
              ? "Enter four numbers."
              : fills
                ? `${px!.w}×${px!.h} px, the shape of the pane: it fills it.`
                : `${px!.w}×${px!.h} px, not the shape of the pane: shown at its own shape over a blurred copy.`}
          </span>
          {region && !fills && (
            <button type="button" className="font-semibold text-acc-text" onClick={matchShape}>
              Match the pane's shape
            </button>
          )}
          <label className="ml-auto flex items-center gap-1.5 text-ink2">
            <input
              type="checkbox"
              className="accent-[var(--acc)]"
              checked={lock}
              onChange={(e) => {
                setLock(e.target.checked);
                if (e.target.checked) matchShape();
              }}
            />
            Keep the pane's shape
          </label>
        </div>
        <div className="flex items-center gap-2">
          {pane.current && (
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => {
                onApply(key, null);
                onOpenChange(false);
              }}
            >
              Back to automatic
            </button>
          )}
          <button type="button" className="btn-ghost ml-auto" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!region}>
            Apply
          </button>
        </div>
      </form>
    </Modal>
  );
}
