import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as Popover from "@radix-ui/react-popover";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Scissors, Undo2, Redo2, Check, Plus, Trash2, Film, Image as ImageIcon, Type, Music } from "lucide-react";
import { formatTime, contentLabel, hasAdjust, type ContentRegion, type DetectedSegment, type LayoutSection, type SectionMode, type Word } from "@reelsaw/shared";

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
export const SPLIT_SHORTCUT = `${MOD}B`;

/** A framing section as edited: the stored shape (mode + per-pane adjustments), absolute source seconds. */
export type EditorSection = LayoutSection;

/** A layer as the timeline draws it: an image or video, a line of text, or a sound. */
export interface LayerBlock {
  id: string;
  start: number;
  end: number;
  name: string;
  kind: "video" | "image" | "text" | "audio";
  thumbnailUrl?: string;
}
export type LayerAddKind = "asset" | "text" | "audio";
/** The intro or outro a clip will render with, as a block on the clip lane. */
export interface BumperBlock {
  name: string;
  sec: number;
  kind: "video" | "image" | "audio";
  thumbnailUrl?: string;
  /** where the choice comes from */
  source: "clip" | "project";
}
export type BumperSlot = "intro" | "outro";
/** shortest a layer can be dragged to: pictures and text 0.1 s, sounds 0.5 s */
const minLayer = (kind: LayerBlock["kind"]) => (kind === "audio" ? 0.5 : 0.1);
const OV_ROW = 24;
const MAX_OV_ROWS = 4;
const BUMPER_SEC = { min: 1, max: 10 };

/**
 * Pack overlapping layers into rows (first free row wins), capped: the lane never grows past MAX_OV_ROWS.
 * Visual layers are placed first so sounds settle on the bottom rows.
 */
export function packLayerRows(blocks: LayerBlock[]): Map<string, number> {
  const rows: number[] = []; // end time of the last block per row
  const out = new Map<string, number>();
  const audio = (b: LayerBlock) => (b.kind === "audio" ? 1 : 0);
  for (const b of [...blocks].sort((p, q) => audio(p) - audio(q) || p.start - q.start || p.id.localeCompare(q.id))) {
    let r = rows.findIndex((end) => end <= b.start + 0.001);
    if (r < 0) {
      if (rows.length < MAX_OV_ROWS) {
        rows.push(b.end);
        r = rows.length - 1;
      } else r = rows.length - 1;
    }
    rows[r] = Math.max(rows[r]!, b.end);
    out.set(b.id, r);
  }
  return out;
}

export const MODE_LABEL: Record<string, string> = { auto: "Auto", face: "Follow speaker", split: "Two stacked", stack: "Screen + speaker", fit: "Whole frame", center: "Centre crop", none: "Original" };
/** What a rendered piece looks like: a stack says what it shows on top ("Stack", "Stack · content left 50%"). */
export const layoutLabel = (d: { layout: string; content?: ContentRegion }) => (d.layout === "stack" ? contentLabel(d.content) : MODE_LABEL[d.layout]);

const MIN_SECTION = 0.3;
const MIN_CLIP = 3;
const SNAP_PX = 8;
const LABEL_W = 96;
const MIN_SPAN = 6;
const MAX_SPAN = 180;

/** Clamp sections to the range and close gaps: the layout track always covers the clip exactly. */
export function normalizeSections(sections: EditorSection[], range: [number, number]): EditorSection[] {
  const [a, b] = range;
  const sorted = sections
    .map((s) => ({ ...s, start: Math.max(a, s.start), end: Math.min(b, s.end) }))
    .filter((s) => s.end - s.start >= 0.05)
    .sort((x, y) => x.start - y.start);
  if (!sorted.length) return [{ start: a, end: b, mode: "auto" }];
  sorted[0]!.start = a;
  sorted[sorted.length - 1]!.end = b;
  for (let i = 1; i < sorted.length; i++) sorted[i]!.start = sorted[i - 1]!.end;
  // equal neighbours are kept apart on purpose: a fresh split is two "auto" sections until one changes
  return sorted.filter((s) => s.end - s.start > 0.01);
}

interface Props {
  sourceDuration: number;
  range: [number, number];
  onRange: (r: [number, number], key?: string) => void;
  current: number;
  onSeek: (t: number) => void;
  words: Word[];
  sceneCuts: number[];
  sections: EditorSection[];
  /** `key` is set for every update within one drag so the whole drag is a single undo step */
  onSections: (s: EditorSection[], key?: string) => void;
  onSplit: (t: number) => void;
  onSetMode: (index: number, mode: SectionMode) => void;
  /** remove the transition on the given side of a section, merging it into that neighbour */
  onMerge: (index: number, side: "left" | "right") => void;
  onResetLayout: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  selected: number | null;
  onSelect: (i: number | null) => void;
  detected: DetectedSegment[];
  /** spans removed as disfluencies, drawn hatched on the words lane */
  cuts?: Array<{ start: number; end: number }>;
  onResetOffset?: (index: number) => void;
  /** the action bar: editing actions on the left, the transport in the middle, view tools on the right (zoom is the timeline's own) */
  toolbar?: ReactNode;
  transport?: ReactNode;
  tools?: ReactNode;
  /** snap drags to words, scene changes, the playhead and the clip edges (Alt skips it for one drag) */
  snap?: boolean;
  onSnap?: (v: boolean) => void;
  /** hide the hint line on short screens */
  compactHints?: boolean;
  /** the Layers lane: images, video, text and sounds in packed rows (drag to move, edges to trim, double-click to add) */
  layers?: LayerBlock[];
  selectedLayer?: string | null;
  onLayerSelect?: (id: string | null) => void;
  onLayerChange?: (id: string, range: [number, number], key?: string) => void;
  onLayerAdd?: (t: number, kind: LayerAddKind) => void;
  onLayerRemove?: (id: string) => void;
  /** the in/out editor (fields and nudges), shown in a popover from the clip block's length label */
  renderClipEditor?: () => ReactNode;
  /** the intro and outro the clip renders with, drawn as blocks around the clip range */
  bumpers?: { intro: BumperBlock | null; outro: BumperBlock | null };
  selectedBumper?: BumperSlot | null;
  onBumperSelect?: (slot: BumperSlot | null) => void;
  /** an image bumper's length, changed by dragging its outer edge */
  onBumperSeconds?: (slot: BumperSlot, sec: number, key?: string) => void;
  /** the editor for a slot, shown in a popover anchored on its block */
  renderBumperEditor?: (slot: BumperSlot) => ReactNode;
}

type DragState =
  | { kind: "scrub" }
  | { kind: "start" | "end" }
  | { kind: "move"; grabT: number; orig: [number, number] }
  | { kind: "boundary"; index: number }
  | { kind: "pan"; grabX: number; orig: [number, number] }
  | { kind: "ly-move"; id: string; grabT: number; orig: [number, number] }
  | { kind: "ly-start" | "ly-end"; id: string }
  | { kind: "bumper"; slot: BumperSlot };

/**
 * Multi-lane editor timeline: time ruler (click/drag to scrub), transcript words, the clip range
 * (drag either edge or the body), and the layout track (click a section to select, drag a boundary
 * to move a transition, double-click to add one). Cmd/Ctrl+wheel zooms, wheel pans.
 */
export function Timeline({ sourceDuration, range, onRange, current, onSeek, words, sceneCuts, sections, onSections, onSplit, onSetMode, onMerge, onResetLayout, onUndo, onRedo, canUndo, canRedo, selected, onSelect, detected, cuts = [], onResetOffset, toolbar, transport, tools, snap = true, onSnap, compactHints, layers = [], selectedLayer = null, onLayerSelect, onLayerChange, onLayerAdd, onLayerRemove, renderClipEditor, bumpers, selectedBumper = null, onBumperSelect, onBumperSeconds, renderBumperEditor }: Props) {
  const lanesRef = useRef<HTMLDivElement>(null);
  const [clipEditorOpen, setClipEditorOpen] = useState(false);
  const lyRows = useMemo(() => packLayerRows(layers), [layers]);
  const lyRowCount = Math.max(1, Math.min(MAX_OV_ROWS, layers.length ? Math.max(...[...lyRows.values()]) + 1 : 1));
  const lyLaneH = lyRowCount * OV_ROW - 2;
  const [w, setW] = useState(600);
  /**
   * The view may start before 0:00 by the room the intro block (or its "+ Intro" chip) needs to the left of
   * the clip, so a clip that starts at the head of the video still shows it. Depends on the zoom (the chip
   * is a fixed 76 px) and on the intro's seconds; computed from the current span by the callers.
   */
  const leadSec = (forSpan: number) => (76 / Math.max(1, w)) * forSpan + (bumpers?.intro?.sec ?? 0);
  const minStart = (forSpan: number) => (range[0] <= 0.05 ? -leadSec(forSpan) : 0);
  const fitView = useCallback((): [number, number] => {
    const len = range[1] - range[0];
    const pad = Math.max(2, len * 0.25);
    const end = Math.min(sourceDuration || range[1] + pad, range[1] + pad);
    const start = range[0] - pad;
    // at the head of the video, leave the intro its room instead of clamping at 0
    return [range[0] <= 0.05 ? Math.max(-(76 / Math.max(1, w)) * (end - start) - (bumpers?.intro?.sec ?? 0), start) : Math.max(0, start), end];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, sourceDuration, w, bumpers?.intro?.sec]);
  const [view, setView] = useState<[number, number]>(fitView);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [hoverLane, setHoverLane] = useState<string | null>(null);
  const gesture = useRef<string | undefined>(undefined);
  /** where the context menu was opened: time + lane + section under the cursor */
  const [menuAt, setMenuAt] = useState<{ t: number; lane: string; section: number; layer: string | null } | null>(null);

  useEffect(() => {
    const el = lanesRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const span = Math.max(0.5, view[1] - view[0]);
  const x = (t: number) => ((t - view[0]) / span) * w;
  const tAt = (clientX: number) => {
    const r = lanesRef.current!.getBoundingClientRect();
    return view[0] + ((clientX - r.left) / r.width) * span;
  };

  // keep the playhead visible while playing
  useEffect(() => {
    if (drag) return;
    if (current < view[0] || current > view[1]) {
      const s = Math.max(minStart(span), current - span * 0.1);
      setView([s, s + span]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const visibleWords = useMemo(() => words.filter((wd) => wd.end >= view[0] && wd.start <= view[1]), [words, view]);

  const [snapHit, setSnapHit] = useState<{ t: number; kind: string } | null>(null);
  /** Snap within 8px to word edges, scene changes, the playhead and the clip edges. Alt disables for one drag, the toolbar toggle for good. */
  const snapT = (t: number, prefer: "start" | "end" | "any", alt: boolean) => {
    if (alt || !snap) {
      setSnapHit(null);
      return t;
    }
    const tol = (SNAP_PX / w) * span;
    let best = t;
    let bestD = tol;
    let kind = "";
    const consider = (c: number, k: string) => {
      const d = Math.abs(c - t);
      if (d < bestD) {
        best = c;
        bestD = d;
        kind = k;
      }
    };
    for (const wd of visibleWords) {
      if (prefer !== "end") consider(Math.max(0, wd.start - 0.05), "word");
      if (prefer !== "start") consider(wd.end + 0.08, "word");
    }
    for (const c of sceneCuts) if (c >= view[0] && c <= view[1]) consider(c, "scene change");
    consider(current, "playhead");
    consider(range[0], "clip start");
    consider(range[1], "clip end");
    for (const s of sections.slice(1)) consider(s.start, "framing change");
    setSnapHit(kind ? { t: best, kind } : null);
    return Number(best.toFixed(2));
  };

  function zoom(factor: number, around = (view[0] + view[1]) / 2) {
    setSpan(span * factor, around);
  }
  function setSpan(next: number, around = (view[0] + view[1]) / 2) {
    const newSpan = Math.max(MIN_SPAN, Math.min(Math.max(MIN_SPAN, Math.min(MAX_SPAN, sourceDuration || MAX_SPAN)), next));
    const frac = (around - view[0]) / span;
    const s = Math.max(minStart(newSpan), around - frac * newSpan);
    setView([s, s + newSpan]);
  }

  function onWheel(e: React.WheelEvent) {
    // React bubbles events from portals (the intro / outro popover) up the component tree; only our own DOM pans
    if (!e.currentTarget.contains(e.target as Node)) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, tAt(e.clientX));
    } else {
      // plain scroll pans the timeline
      const d = ((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / w) * span;
      const s = Math.max(minStart(span), view[0] + d);
      setView([s, s + span]);
    }
  }
  // React's wheel listener is passive; block page zoom on ctrl+wheel with a native one
  useEffect(() => {
    const el = lanesRef.current?.parentElement;
    if (!el) return;
    const block = (e: WheelEvent) => el.contains(e.target as Node) && (e.ctrlKey || e.metaKey) && e.preventDefault();
    el.addEventListener("wheel", block, { passive: false });
    return () => el.removeEventListener("wheel", block);
  }, []);

  function begin(e: React.PointerEvent, d: DragState) {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return;
    lanesRef.current?.setPointerCapture(e.pointerId);
    gesture.current = `g:${d.kind}:${Date.now()}`;
    setDrag(d);
    if (d.kind === "scrub") onSeek(Math.max(0, tAt(e.clientX)));
  }
  function move(e: React.PointerEvent) {
    const t = tAt(e.clientX);
    setHoverT(t);
    if (!drag) return;
    const alt = e.altKey;
    if (drag.kind === "scrub") onSeek(Math.max(0, Math.min(sourceDuration || t, t)));
    else if (drag.kind === "start") {
      const s = Math.max(0, Math.min(range[1] - MIN_CLIP, snapT(t, "start", alt)));
      onRange([s, range[1]], gesture.current);
      onSeek(s);
    } else if (drag.kind === "end") {
      const en = Math.min(sourceDuration || Infinity, Math.max(range[0] + MIN_CLIP, snapT(t, "end", alt)));
      onRange([range[0], en], gesture.current);
      onSeek(Math.max(range[0], en - 2));
    } else if (drag.kind === "move") {
      const len = drag.orig[1] - drag.orig[0];
      let s = drag.orig[0] + (t - drag.grabT);
      s = Math.max(0, Math.min((sourceDuration || Infinity) - len, s));
      const snapped = snapT(s, "start", alt);
      onRange([snapped, Number((snapped + len).toFixed(2))], gesture.current);
    } else if (drag.kind === "boundary") {
      const i = drag.index; // boundary between sections i-1 and i
      const lo = sections[i - 1]!.start + MIN_SECTION;
      const hi = sections[i]!.end - MIN_SECTION;
      const nt = Math.max(lo, Math.min(hi, snapT(t, "any", alt)));
      const next = sections.map((s) => ({ ...s }));
      next[i - 1]!.end = nt;
      next[i]!.start = nt;
      onSections(next, gesture.current);
    } else if (drag.kind === "pan") {
      const d = ((drag.grabX - e.clientX) / w) * span;
      const s = Math.max(minStart(span), drag.orig[0] + d);
      setView([s, s + span]);
    } else if (drag.kind === "ly-move") {
      const len = drag.orig[1] - drag.orig[0];
      let s = drag.orig[0] + (t - drag.grabT);
      s = Math.max(range[0], Math.min(range[1] - len, s));
      const snapped = Math.max(range[0], Math.min(range[1] - len, snapT(s, "start", alt)));
      onLayerChange?.(drag.id, [snapped, Number((snapped + len).toFixed(2))], gesture.current);
    } else if (drag.kind === "ly-start" || drag.kind === "ly-end") {
      const o = layers.find((b) => b.id === drag.id);
      if (!o) return;
      const min = minLayer(o.kind);
      if (drag.kind === "ly-start") onLayerChange?.(drag.id, [Math.max(range[0], Math.min(o.end - min, snapT(t, "start", alt))), o.end], gesture.current);
      else onLayerChange?.(drag.id, [o.start, Math.min(range[1], Math.max(o.start + min, snapT(t, "end", alt)))], gesture.current);
    } else if (drag.kind === "bumper") {
      // the outer edge of an image intro/outro sets how long it shows
      const raw = drag.slot === "intro" ? range[0] - t : t - range[1];
      const sec = Math.max(BUMPER_SEC.min, Math.min(BUMPER_SEC.max, Math.round(raw * 2) / 2));
      onBumperSeconds?.(drag.slot, sec, gesture.current);
    }
  }
  function end(e: React.PointerEvent) {
    lanesRef.current?.releasePointerCapture?.(e.pointerId);
    setDrag(null);
    setSnapHit(null);
    gesture.current = undefined;
  }

  const sectionAt = (t: number) => sections.findIndex((s) => t >= s.start && t < s.end);
  const canSplitAt = (t: number) => sections.some((s) => t > s.start + MIN_SECTION && t < s.end - MIN_SECTION);
  function onContext(e: React.MouseEvent) {
    const el = e.target as HTMLElement;
    const lane = el.closest<HTMLElement>("[data-lane]")?.dataset.lane ?? "ruler";
    const layer = el.closest<HTMLElement>("[data-ly]")?.dataset.ly ?? null;
    const t = Number(tAt(e.clientX).toFixed(2));
    const section = sectionAt(Math.max(range[0], Math.min(range[1] - 0.01, t)));
    setMenuAt({ t, lane, section, layer });
    if (lane === "layout" && section >= 0) onSelect(section);
    if (layer) onLayerSelect?.(layer);
  }
  const inClip = (t: number) => t >= range[0] && t <= range[1];
  const bumperBlock = (slot: BumperSlot) => {
    const b = bumpers?.[slot] ?? null;
    const open = selectedBumper === slot;
    const left = slot === "intro" ? (b ? x(range[0] - b.sec) : x(range[0]) - 68) : x(range[1]) + (b ? 0 : 4);
    const width = b ? Math.max(28, slot === "intro" ? x(range[0]) - x(range[0] - b.sec) : x(range[1] + b.sec) - x(range[1])) : 64;
    const label = slot === "intro" ? "Intro" : "Outro";
    const node = b ? (
      <div
        className={`absolute inset-y-0 flex cursor-pointer items-center gap-1.5 overflow-hidden border-2 border-dashed px-1.5 ${slot === "intro" ? "rounded-l-[8px] border-r-0" : "rounded-r-[8px] border-l-0"} ${open ? "border-acc bg-acc-soft" : "border-line2 bg-panel hover:bg-sunk"}`}
        style={{ left, width }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          onBumperSelect?.(open ? null : slot);
        }}
        title={`${label}: ${b.name} · ${b.sec} s${b.source === "project" ? " (project default)" : ""} · click to change`}
      >
        {b.thumbnailUrl ? <img src={b.thumbnailUrl} alt="" className="h-[26px] w-[15px] shrink-0 rounded-[3px] object-cover" /> : b.kind === "video" ? <Film className="h-3.5 w-3.5 shrink-0 text-ink3" /> : <ImageIcon className="h-3.5 w-3.5 shrink-0 text-ink3" />}
        {width > 70 && (
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[11px] font-bold">
              {label} · {b.sec} s
            </span>
            <span className="block truncate text-[10px] text-ink3">
              {b.name}
              {b.source === "project" ? " · project" : ""}
            </span>
          </span>
        )}
      </div>
    ) : (
      <button
        type="button"
        className={`absolute inset-y-1 flex w-16 items-center justify-center gap-1 rounded-[8px] border border-dashed text-[11px] font-semibold ${open ? "border-acc bg-acc-soft text-acc-text" : "border-line2 text-ink3 hover:border-ink hover:text-ink"}`}
        style={{ left }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onBumperSelect?.(open ? null : slot)}
        title={`Add an ${slot}`}
      >
        <Plus className="h-3 w-3" /> {label}
      </button>
    );
    return (
      <Popover.Root key={slot} open={open} onOpenChange={(o) => !o && onBumperSelect?.(null)}>
        <Popover.Anchor asChild>{node}</Popover.Anchor>
        {b?.kind === "image" && onBumperSeconds && (
          <div
            className="absolute inset-y-0 z-[3] w-3 cursor-ew-resize"
            style={{ left: slot === "intro" ? left - 6 : left + width - 6 }}
            onPointerDown={(e) => begin(e, { kind: "bumper", slot })}
            title={`Drag to change how long the ${slot} shows (${BUMPER_SEC.min}–${BUMPER_SEC.max} s)`}
          />
        )}
        <Popover.Portal>
          <Popover.Content side="top" align={slot === "intro" ? "start" : "end"} sideOffset={8} collisionPadding={12} className="z-[80] w-[min(26rem,calc(100vw-24px))] rounded-[12px] border border-line bg-panel p-3 text-ink shadow-pop" onOpenAutoFocus={(e) => e.preventDefault()}>
            {renderBumperEditor?.(slot)}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  };

  // ruler ticks
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((st) => (st / span) * w >= 64) ?? 600;
  const ticks: number[] = [];
  for (let t = Math.max(0, Math.ceil(view[0] / step) * step); t <= view[1]; t += step) ticks.push(t);

  const playX = x(current);
  const lane = "relative";
  const len = range[1] - range[0];
  const zoomMax = Math.max(MIN_SPAN + 1, Math.min(MAX_SPAN, sourceDuration || MAX_SPAN));
  const zoomVal = Math.round((1 - (Math.log(span) - Math.log(MIN_SPAN)) / (Math.log(zoomMax) - Math.log(MIN_SPAN))) * 100);
  const isCut = (wd: Word) => cuts.some((c) => wd.start >= c.start - 0.02 && wd.end <= c.end + 0.02);
  const label = "flex items-center px-4 text-xs font-semibold text-ink2";

  return (
    <div className="select-none">
      {/* action bar: edit actions | transport | view tools + zoom. Wraps into rows on narrow screens. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">{toolbar}</div>
        <div className="mx-auto flex items-center gap-1.5">{transport}</div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink2">
          {tools}
          <button
            type="button"
            className={`min-w-[7.5rem] rounded-full px-2.5 py-[3px] text-center font-mono text-[11px] whitespace-nowrap ${snapHit && drag ? "bg-acc text-acc-ink" : snap ? "bg-sunk text-ink2 hover:text-ink" : "border border-dashed border-line2 text-ink3 hover:text-ink"}`}
            aria-pressed={snap}
            onClick={() => onSnap?.(!snap)}
            title={snap ? "Snapping to words, scene changes, the playhead and the clip edges (S toggles; hold Alt for one drag)" : "Snapping off (S toggles)"}
          >
            {snapHit && drag ? `snap: ${snapHit.kind}` : snap ? "snap on" : "snap off"}
          </button>
          <span>Zoom</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.max(0, Math.min(100, zoomVal))}
            onChange={(e) => {
              const z = Number(e.target.value) / 100;
              const next = Math.exp(Math.log(zoomMax) - z * (Math.log(zoomMax) - Math.log(MIN_SPAN)));
              setSpan(next, next < len ? current : (view[0] + view[1]) / 2);
            }}
            className="w-28 accent-[var(--acc)]"
            aria-label="Zoom timeline"
          />
          <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setView(fitView())} title="Fit the clip">
            Fit
          </button>
        </div>
      </div>
      <div className="flex" onWheel={onWheel}>
        {/* lane labels */}
        <div className="shrink-0" style={{ width: LABEL_W }}>
          <div className="h-6" />
          <div className={`${label} h-[26px]`}>Words</div>
          <div className={`${label} mt-1.5 justify-between pr-2`} style={{ height: lyLaneH }}>
            Layers
            {onLayerAdd && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button type="button" className="grid h-5 w-5 shrink-0 place-items-center rounded-[6px] border border-line text-ink2 hover:bg-sunk hover:text-ink" aria-label="Add a layer at the playhead" title="Add a layer at the playhead">
                    <Plus className="h-3 w-3" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content side="top" align="start" sideOffset={6} className="menu z-[80] w-[200px]">
                    <DropdownMenu.Item className="menu-item" onSelect={() => onLayerAdd(inClip(current) ? current : range[0], "asset")}>
                      <ImageIcon className="h-3.5 w-3.5" /> Image or video…
                    </DropdownMenu.Item>
                    <DropdownMenu.Item className="menu-item" onSelect={() => onLayerAdd(inClip(current) ? current : range[0], "text")}>
                      <Type className="h-3.5 w-3.5" /> Text
                    </DropdownMenu.Item>
                    <DropdownMenu.Item className="menu-item" onSelect={() => onLayerAdd(inClip(current) ? current : range[0], "audio")}>
                      <Music className="h-3.5 w-3.5" /> Sound…
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
          </div>
          <div className={`${label} mt-1.5 h-[34px]`}>Clip</div>
          <div className={`${label} mt-1.5 h-[38px]`}>Framing</div>
        </div>

        <ContextMenu.Root modal={false}>
        <ContextMenu.Trigger asChild>
        <div ref={lanesRef} className="relative mr-4 min-w-0 flex-1 overflow-hidden pb-2" onPointerMove={move} onPointerUp={end} onPointerCancel={end} onPointerLeave={() => setHoverT(null)} onContextMenu={onContext}>
          {/* ruler */}
          <div data-lane="ruler" className={`${lane} h-6 cursor-ew-resize`} onPointerDown={(e) => begin(e, { kind: "scrub" })}>
            {ticks.map((t) => (
              <div key={t} className="absolute top-0 h-6 border-l border-line2 pl-1 font-mono text-[10px] leading-4 text-ink3" style={{ left: x(t) }}>
                {formatTime(t)}
              </div>
            ))}
          </div>

          {/* words */}
          <div data-lane="words" className={`${lane} h-[26px] cursor-grab`} onPointerDown={(e) => e.button === 0 && begin(e, { kind: "pan", grabX: e.clientX, orig: view })}>
            {visibleWords.map((wd, i) => {
              const inClip = wd.start >= range[0] - 0.01 && wd.end <= range[1] + 0.05;
              const cut = isCut(wd);
              const left = x(wd.start);
              const width = Math.max(1, x(wd.end) - left - 1);
              return (
                <div
                  key={i}
                  className={`absolute top-0 h-[26px] overflow-hidden rounded-[4px] px-[3px] text-[10px] leading-[26px] whitespace-nowrap ${cut ? "text-ink3 line-through" : inClip ? "bg-acc-soft text-ink" : "bg-sunk text-ink"}`}
                  style={{ left, width, ...(cut ? { background: "repeating-linear-gradient(45deg, var(--line) 0 3px, transparent 3px 6px)" } : {}) }}
                  title={wd.text}
                >
                  {width > 22 ? wd.text.replace(/[,.?!]$/, "") : ""}
                </div>
              );
            })}
          </div>

          {/* layers: images, video, text and sounds in packed rows; double-click adds an image or video at that time */}
          <div
            data-lane="layers"
            className={`${lane} mt-1.5 rounded-[8px] bg-sunk/60`}
            style={{ height: lyLaneH }}
            onPointerDown={(e) => {
              if (e.button !== 0 || (e.target as HTMLElement).closest("[data-ly]")) return;
              onLayerSelect?.(null);
              begin(e, { kind: "pan", grabX: e.clientX, orig: view });
            }}
            onDoubleClick={(e) => {
              if ((e.target as HTMLElement).closest("[data-ly]")) return;
              const t = tAt(e.clientX);
              if (inClip(t)) onLayerAdd?.(Number(t.toFixed(2)), "asset");
            }}
            title={onLayerAdd ? "Double-click to add an image or video here; + for text or a sound" : undefined}
          >
            {layers.map((o) => {
              const left = x(o.start);
              const width = Math.max(6, x(o.end) - left);
              const row = lyRows.get(o.id) ?? 0;
              const sel = o.id === selectedLayer;
              const min = minLayer(o.kind);
              return (
                <div
                  key={o.id}
                  data-ly={o.id}
                  className={`absolute flex h-[22px] cursor-grab items-center gap-1 overflow-hidden rounded-[6px] border px-1 active:cursor-grabbing ${sel ? "border-acc bg-acc-soft text-ink shadow-[0_0_0_2px_var(--acc)]" : "border-line2 bg-panel text-ink hover:bg-sunk"}`}
                  style={{ left, width, top: row * OV_ROW }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    onLayerSelect?.(o.id);
                    begin(e, { kind: "ly-move", id: o.id, grabT: tAt(e.clientX), orig: [o.start, o.end] });
                  }}
                  title={`${o.name} ${formatTime(o.start)}–${formatTime(o.end)} · drag to move, edges to trim (min ${min} s)`}
                >
                  {o.kind === "text" ? <Type className="h-3 w-3 shrink-0 text-ink3" /> : o.kind === "audio" ? <Music className="h-3 w-3 shrink-0 text-ink3" /> : o.thumbnailUrl ? <img src={o.thumbnailUrl} alt="" className="h-[16px] w-[10px] shrink-0 rounded-[2px] object-cover" /> : o.kind === "video" ? <Film className="h-3 w-3 shrink-0 text-ink3" /> : <ImageIcon className="h-3 w-3 shrink-0 text-ink3" />}
                  {width > 50 && <span className="truncate text-[10px] font-semibold leading-none">{o.name}</span>}
                  {(["ly-start", "ly-end"] as const).map((k) => (
                    <div
                      key={k}
                      className={`absolute inset-y-0 w-1.5 cursor-ew-resize ${k === "ly-start" ? "left-0" : "right-0"} ${sel ? "bg-acc/60" : "hover:bg-line"}`}
                      onPointerDown={(e) => {
                        onLayerSelect?.(o.id);
                        begin(e, { kind: k, id: o.id });
                      }}
                    />
                  ))}
                </div>
              );
            })}
          </div>

          {/* clip range, with the intro and outro it renders with on either side */}
          <div data-lane="clip" className={`${lane} mt-1.5 h-[34px] rounded-[8px] bg-sunk`}>
            {bumpers && bumperBlock("intro")}
            {bumpers && bumperBlock("outro")}
            <div
              className="absolute inset-y-0 z-[2] flex cursor-grab items-center justify-center rounded-[8px] border-2 border-acc bg-acc-soft active:cursor-grabbing"
              style={{ left: x(range[0]), width: Math.max(4, x(range[1]) - x(range[0])) }}
              onPointerDown={(e) => begin(e, { kind: "move", grabT: tAt(e.clientX), orig: range })}
              title="Drag to slide the whole clip"
            >
              {renderClipEditor ? (
                <Popover.Root open={clipEditorOpen} onOpenChange={setClipEditorOpen}>
                  <Popover.Trigger asChild>
                    <button
                      type="button"
                      className={`rounded-[6px] px-1.5 font-mono text-[11px] font-semibold text-acc-text hover:bg-acc/20 ${clipEditorOpen ? "bg-acc/20" : ""}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      title="Clip length · click to edit the in and out points"
                      aria-label="Edit the in and out points"
                    >
                      {len.toFixed(1)}s
                    </button>
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content side="top" align="center" sideOffset={10} collisionPadding={12} className="z-[80] rounded-[12px] border border-line bg-panel p-3 text-ink shadow-pop" onOpenAutoFocus={(e) => e.preventDefault()}>
                      {renderClipEditor()}
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
              ) : (
                <span className="pointer-events-none font-mono text-[11px] font-semibold text-acc-text">{len.toFixed(1)}s</span>
              )}
            </div>
            {(["start", "end"] as const).map((k) => (
              <div
                key={k}
                className={`absolute inset-y-0 z-[3] grid w-3.5 -translate-x-1/2 cursor-ew-resize place-items-center rounded-[6px] bg-acc ${drag?.kind === k ? "brightness-110" : ""}`}
                style={{ left: x(range[k === "start" ? 0 : 1]) }}
                onPointerDown={(e) => begin(e, { kind: k })}
                title={k === "start" ? "Drag to set the in point (I)" : "Drag to set the out point (O)"}
              >
                <span className="h-3.5 w-[3px] rounded-full bg-acc-ink/70" />
              </div>
            ))}
          </div>

          {/* framing sections */}
          <div data-lane="layout" className="relative mt-1.5 h-[38px] cursor-pointer" onPointerEnter={() => setHoverLane("layout")} onPointerLeave={() => setHoverLane(null)}>
            {sections.map((s, i) => {
              const left = x(s.start);
              const width = Math.max(2, x(s.end) - left);
              const det = detected.filter((d) => !d.manual && d.end > s.start && d.start < s.end);
              const auto = s.mode === "auto";
              const chose = [...new Set(det.map(layoutLabel))].join(" / ");
              return (
                <div
                  key={i}
                  className={`absolute top-0 flex h-[38px] flex-col justify-center overflow-hidden rounded-[8px] px-2.5 ${auto ? "border-[1.5px] border-dashed border-line2 bg-panel text-ink" : "border-[1.5px] border-ink bg-ink text-bg"} ${selected === i ? "shadow-[0_0_0_2px_var(--acc)]" : ""}`}
                  style={{ left, width }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    onSelect(i);
                    onSeek(Math.max(s.start, Math.min(s.end - 0.01, tAt(e.clientX))));
                  }}
                  title={`${MODE_LABEL[s.mode]} ${formatTime(s.start)}–${formatTime(s.end)}`}
                >
                  {width > 44 && <span className="truncate text-[11px] font-bold leading-tight">{MODE_LABEL[s.mode]}</span>}
                  {width > 70 && (
                    <span className="truncate text-[10px] leading-tight opacity-75">
                      {auto ? (chose ? `→ ${chose}` : "→ decided at render") : hasAdjust(s) ? adjustLabel(s) : "forced"}
                      {auto && hasAdjust(s) ? ` · ${adjustLabel(s)}` : ""}
                    </span>
                  )}
                </div>
              );
            })}
            {hoverLane === "layout" && hoverT !== null && !drag && canSplitAt(hoverT) && (
              <div className="pointer-events-none absolute inset-y-0 z-10 border-l border-dashed border-acc" style={{ left: x(hoverT) }} />
            )}
            {sections.slice(1).map((s, k) => (
              <div
                key={`b${k}`}
                className="absolute top-0 z-[4] grid h-[38px] w-4 -translate-x-1/2 cursor-ew-resize place-items-center"
                style={{ left: x(s.start) }}
                onPointerDown={(e) => begin(e, { kind: "boundary", index: k + 1 })}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onMerge(k + 1, "left");
                }}
                title="Drag to move this transition · double-click to remove it"
              >
                <div className={`h-6 w-1 rounded-full ${drag?.kind === "boundary" && drag.index === k + 1 ? "bg-acc" : "bg-ink"} shadow-[0_0_0_2px_var(--panel)]`} />
              </div>
            ))}
          </div>

          {/* scene changes */}
          {sceneCuts
            .filter((c) => c > view[0] && c < view[1])
            .map((c) => (
              <div key={c} className="pointer-events-none absolute bottom-0 top-6 border-l-2 border-dashed border-warn opacity-60" style={{ left: x(c) }} title={`Scene change ${formatTime(c)}`} />
            ))}
          {/* snap target while dragging */}
          {drag && snapHit && <div className="pointer-events-none absolute bottom-0 top-6 z-[6] border-l-2 border-snap" style={{ left: x(snapHit.t) }} />}
          {/* playhead */}
          {playX >= -2 && playX <= w + 2 && (
            <div className="pointer-events-none absolute inset-y-0 z-[7] -ml-px w-0.5 bg-ink" style={{ left: playX }}>
              <div className="absolute -left-[5px] top-0 h-0 w-0 border-x-[6px] border-t-[7px] border-x-transparent border-t-ink" />
            </div>
          )}
        </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <TimelineMenu
            at={menuAt}
            sections={sections}
            detected={detected}
            range={range}
            current={current}
            canSplitAt={canSplitAt}
            onSplit={onSplit}
            onSetMode={onSetMode}
            onMerge={onMerge}
            onResetLayout={onResetLayout}
            onResetOffset={onResetOffset}
            onSetIn={(t) => onRange([Math.min(t, range[1] - MIN_CLIP), range[1]])}
            onSetOut={(t) => onRange([range[0], Math.max(t, range[0] + MIN_CLIP)])}
            onSeek={onSeek}
            onUndo={onUndo}
            onRedo={onRedo}
            canUndo={canUndo}
            canRedo={canRedo}
            layer={menuAt?.layer ? (layers.find((o) => o.id === menuAt.layer) ?? null) : null}
            onLayerAdd={onLayerAdd && ((t, kind) => inClip(t) && onLayerAdd(t, kind))}
            onLayerRemove={onLayerRemove}
          />
        </ContextMenu.Portal>
        </ContextMenu.Root>
      </div>
      {!compactHints && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 pb-3 pr-4 text-[11px] text-ink3" style={{ paddingLeft: LABEL_W + 16 }}>
          <span>Drag the handles to trim; drag the clip to slide it · click the intro or outro to change it</span>
          <span>Snaps to words, scene changes and the playhead · hold Alt to drag freely</span>
          <span>{MOD} + scroll zooms · right-click for framing and layers</span>
        </div>
      )}
    </div>
  );
}

/** "x +12% · y −5% · bottom x +3% · follows 72%" for a section's per-pane adjustments. */
export function adjustLabel(s: Pick<LayoutSection, "offsetX" | "offsetY" | "offsetX2" | "offsetY2" | "subjectX" | "subjectX2">): string {
  const pct = (v: number) => `${v > 0 ? "+" : "−"}${Math.round(Math.abs(v) * 100)}%`;
  const pane = (ox: number | undefined, oy: number | undefined, sub: number | undefined) => [...(sub !== undefined ? [`follows ${Math.round(sub * 100)}%`] : []), ...(ox ? [`x ${pct(ox)}`] : []), ...(oy ? [`y ${pct(oy)}`] : [])].join(" ");
  const a = pane(s.offsetX, s.offsetY, s.subjectX);
  const b = pane(s.offsetX2, s.offsetY2, s.subjectX2);
  return [a, b ? `bottom ${b}` : ""].filter(Boolean).join(" · ");
}

const MENU_MODES: SectionMode[] = ["auto", "face", "split", "stack", "fit", "center"];
const item = "menu-item";

function TimelineMenu(p: {
  at: { t: number; lane: string; section: number; layer: string | null } | null;
  layer: LayerBlock | null;
  onLayerAdd?: (t: number, kind: LayerAddKind) => void;
  onLayerRemove?: (id: string) => void;
  sections: EditorSection[];
  detected: DetectedSegment[];
  range: [number, number];
  current: number;
  canSplitAt: (t: number) => boolean;
  onSplit: (t: number) => void;
  onSetMode: (i: number, m: SectionMode) => void;
  onMerge: (i: number, side: "left" | "right") => void;
  onResetLayout: () => void;
  onResetOffset?: (i: number) => void;
  onSetIn: (t: number) => void;
  onSetOut: (t: number) => void;
  onSeek: (t: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  const at = p.at;
  if (!at) return null;
  const sec = at.section >= 0 ? p.sections[at.section] : undefined;
  const autoChose = sec ? [...new Set(p.detected.filter((d) => !d.manual && d.end > sec.start && d.start < sec.end).map(layoutLabel))].join(" / ") : "";
  return (
    <ContextMenu.Content className="menu z-[60] w-[240px]" collisionPadding={8}>
      <ContextMenu.Label className="px-2.5 py-1 font-mono text-[10px] text-ink3">{formatTime(at.t)}</ContextMenu.Label>
      <ContextMenu.Item className={item} disabled={!p.canSplitAt(at.t)} onSelect={() => p.onSplit(at.t)}>
        <Scissors className="h-3.5 w-3.5" /> Split here <span className="kbd ml-auto">{SPLIT_SHORTCUT}</span>
      </ContextMenu.Item>
      {p.layer && p.onLayerRemove ? (
        <ContextMenu.Item className={item} onSelect={() => p.onLayerRemove!(p.layer!.id)}>
          <Trash2 className="h-3.5 w-3.5" /> Remove layer “{p.layer.name}” <span className="kbd ml-auto">⌫</span>
        </ContextMenu.Item>
      ) : p.onLayerAdd ? (
        <>
          <ContextMenu.Item className={item} disabled={at.t < p.range[0] || at.t > p.range[1]} onSelect={() => p.onLayerAdd!(at.t, "asset")}>
            <ImageIcon className="h-3.5 w-3.5" /> Add image or video here
          </ContextMenu.Item>
          <ContextMenu.Item className={item} disabled={at.t < p.range[0] || at.t > p.range[1]} onSelect={() => p.onLayerAdd!(at.t, "text")}>
            <Type className="h-3.5 w-3.5" /> Add text here
          </ContextMenu.Item>
          <ContextMenu.Item className={item} disabled={at.t < p.range[0] || at.t > p.range[1]} onSelect={() => p.onLayerAdd!(at.t, "audio")}>
            <Music className="h-3.5 w-3.5" /> Add sound here
          </ContextMenu.Item>
        </>
      ) : null}
      {sec && (
        <>
          <ContextMenu.Separator className="mx-1.5 my-1 h-px bg-line" />
          <ContextMenu.Label className="px-2.5 pb-0.5 pt-1 text-[11px] font-semibold text-ink3">Framing</ContextMenu.Label>
          <ContextMenu.RadioGroup value={sec.mode} onValueChange={(m) => p.onSetMode(at.section, m as SectionMode)}>
            {MENU_MODES.map((m) => (
              <ContextMenu.RadioItem key={m} value={m} className={item}>
                <span className="w-3.5">
                  <ContextMenu.ItemIndicator>
                    <Check className="h-3.5 w-3.5" />
                  </ContextMenu.ItemIndicator>
                </span>
                {m === "auto" ? `Auto${autoChose ? ` (${autoChose})` : ""}` : MODE_LABEL[m]}
              </ContextMenu.RadioItem>
            ))}
          </ContextMenu.RadioGroup>
          <ContextMenu.Separator className="mx-1.5 my-1 h-px bg-line" />
          <ContextMenu.Item className={item} disabled={at.section === 0} onSelect={() => p.onMerge(at.section, "left")}>
            Merge with previous
          </ContextMenu.Item>
          <ContextMenu.Item className={item} disabled={at.section >= p.sections.length - 1} onSelect={() => p.onMerge(at.section, "right")}>
            Merge with next
          </ContextMenu.Item>
          {p.onResetOffset && (
            <ContextMenu.Item className={item} disabled={!hasAdjust(sec)} onSelect={() => p.onResetOffset!(at.section)}>
              Reset re-centring
            </ContextMenu.Item>
          )}
        </>
      )}
      <ContextMenu.Separator className="mx-1.5 my-1 h-px bg-line" />
      <ContextMenu.Item className={item} onSelect={() => p.onSetIn(at.t)} disabled={at.t >= p.range[1] - MIN_CLIP}>
        Set in point here
      </ContextMenu.Item>
      <ContextMenu.Item className={item} onSelect={() => p.onSetOut(at.t)} disabled={at.t <= p.range[0] + MIN_CLIP}>
        Set out point here
      </ContextMenu.Item>
      <ContextMenu.Item className={item} onSelect={() => p.onSeek(at.t)}>
        Move playhead here
      </ContextMenu.Item>
      <ContextMenu.Separator className="mx-1.5 my-1 h-px bg-line" />
      <ContextMenu.Item className={item} disabled={!p.canUndo} onSelect={p.onUndo}>
        <Undo2 className="h-3.5 w-3.5" /> Undo <span className="kbd ml-auto">{MOD}Z</span>
      </ContextMenu.Item>
      <ContextMenu.Item className={item} disabled={!p.canRedo} onSelect={p.onRedo}>
        <Redo2 className="h-3.5 w-3.5" /> Redo <span className="kbd ml-auto">{MOD}⇧Z</span>
      </ContextMenu.Item>
    </ContextMenu.Content>
  );
}
