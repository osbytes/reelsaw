import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { ZoomIn, ZoomOut, Maximize2, Scissors, Undo2, Redo2, ChevronRight, Check } from "lucide-react";
import { formatTime, type DetectedSegment, type SectionMode, type Word } from "@reelsaw/shared";

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
export const SPLIT_SHORTCUT = `${MOD}B`;

export interface EditorSection {
  start: number;
  end: number;
  mode: SectionMode;
  /** manual horizontal re-centring, fraction of source width */
  offsetX?: number;
}

export const MODE_COLOR: Record<string, string> = {
  auto: "#6b7280",
  face: "#3b82f6",
  split: "#a855f7",
  stack: "#14b8a6",
  fit: "#f59e0b",
  center: "#64748b",
  none: "#334155",
};
export const MODE_LABEL: Record<string, string> = { auto: "Auto", face: "Face", split: "Split", stack: "Stack", fit: "Fit", center: "Center", none: "Original" };

const MIN_SECTION = 0.3;
const MIN_CLIP = 3;
const SNAP_PX = 8;
const LABEL_W = 56;

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
  snap: boolean;
}

type DragState =
  | { kind: "scrub" }
  | { kind: "start" | "end" }
  | { kind: "move"; grabT: number; orig: [number, number] }
  | { kind: "boundary"; index: number }
  | { kind: "pan"; grabX: number; orig: [number, number] };

/**
 * Multi-lane editor timeline: time ruler (click/drag to scrub), transcript words, the clip range
 * (drag either edge or the body), and the layout track (click a section to select, drag a boundary
 * to move a transition, double-click to add one). Cmd/Ctrl+wheel zooms, wheel pans.
 */
export function Timeline({ sourceDuration, range, onRange, current, onSeek, words, sceneCuts, sections, onSections, onSplit, onSetMode, onMerge, onResetLayout, onUndo, onRedo, canUndo, canRedo, selected, onSelect, detected, snap }: Props) {
  const lanesRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const fitView = useCallback((): [number, number] => {
    const len = range[1] - range[0];
    const pad = Math.max(3, len * 0.15);
    return [Math.max(0, range[0] - pad), Math.min(sourceDuration || range[1] + pad, range[1] + pad)];
  }, [range, sourceDuration]);
  const [view, setView] = useState<[number, number]>(fitView);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [hoverLane, setHoverLane] = useState<string | null>(null);
  const gesture = useRef<string | undefined>(undefined);
  /** where the context menu was opened: time + lane + section under the cursor */
  const [menuAt, setMenuAt] = useState<{ t: number; lane: string; section: number } | null>(null);

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
      const s = Math.max(0, current - span * 0.1);
      setView([s, s + span]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const visibleWords = useMemo(() => words.filter((wd) => wd.end >= view[0] && wd.start <= view[1]), [words, view]);

  /** Snap targets near t: word edges, scene cuts, playhead. Alt (or snap off) disables. */
  const snapT = (t: number, prefer: "start" | "end" | "any", alt: boolean) => {
    if (!snap || alt) return t;
    const tol = (SNAP_PX / w) * span;
    let best = t;
    let bestD = tol;
    const consider = (c: number) => {
      const d = Math.abs(c - t);
      if (d < bestD) {
        best = c;
        bestD = d;
      }
    };
    for (const wd of visibleWords) {
      if (prefer !== "end") consider(Math.max(0, wd.start - 0.05));
      if (prefer !== "start") consider(wd.end + 0.08);
    }
    for (const c of sceneCuts) if (c >= view[0] && c <= view[1]) consider(c);
    consider(current);
    return Number(best.toFixed(2));
  };

  function zoom(factor: number, around = (view[0] + view[1]) / 2) {
    const newSpan = Math.max(2, Math.min(sourceDuration || 3600, span * factor));
    const frac = (around - view[0]) / span;
    const s = Math.max(0, around - frac * newSpan);
    setView([s, s + newSpan]);
  }

  function onWheel(e: React.WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, tAt(e.clientX));
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      const d = ((e.shiftKey ? e.deltaY : e.deltaX) / w) * span;
      const s = Math.max(0, view[0] + d);
      setView([s, s + span]);
    }
  }
  // React's wheel listener is passive; block page zoom on ctrl+wheel with a native one
  useEffect(() => {
    const el = lanesRef.current?.parentElement;
    if (!el) return;
    const block = (e: WheelEvent) => (e.ctrlKey || e.metaKey) && e.preventDefault();
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
      const s = Math.max(0, drag.orig[0] + d);
      setView([s, s + span]);
    }
  }
  function end(e: React.PointerEvent) {
    lanesRef.current?.releasePointerCapture?.(e.pointerId);
    setDrag(null);
    gesture.current = undefined;
  }

  const sectionAt = (t: number) => sections.findIndex((s) => t >= s.start && t < s.end);
  const canSplitAt = (t: number) => sections.some((s) => t > s.start + MIN_SECTION && t < s.end - MIN_SECTION);
  function onContext(e: React.MouseEvent) {
    const lane = (e.target as HTMLElement).closest<HTMLElement>("[data-lane]")?.dataset.lane ?? "ruler";
    const t = Number(tAt(e.clientX).toFixed(2));
    const section = sectionAt(Math.max(range[0], Math.min(range[1] - 0.01, t)));
    setMenuAt({ t, lane, section });
    if (lane === "layout" && section >= 0) onSelect(section);
  }

  // ruler ticks: pick a step that gives ~80px between labels
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((st) => (st / span) * w >= 70) ?? 600;
  const ticks: number[] = [];
  for (let t = Math.ceil(view[0] / step) * step; t <= view[1]; t += step) ticks.push(t);

  const playX = x(current);
  const lane = "relative border-b border-border/60";

  return (
    <div className="select-none rounded-md border border-border bg-panel-2/40 text-[11px]">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1 text-muted">
        <span className="font-mono">{formatTime(view[0])}</span>
        <span className="mx-1">–</span>
        <span className="font-mono">{formatTime(view[1])}</span>
        <span className="mx-1 h-4 w-px bg-border" />
        <button type="button" className="flex items-center gap-1 rounded px-1.5 py-1 text-text hover:bg-panel-2 disabled:opacity-40" disabled={!canSplitAt(current)} onClick={() => onSplit(current)} title={`Split layout at playhead (${SPLIT_SHORTCUT} or S)`}>
          <Scissors className="h-3.5 w-3.5" /> Split
        </button>
        <button type="button" className="rounded p-1 hover:bg-panel-2 disabled:opacity-40" disabled={!canUndo} onClick={onUndo} title={`Undo (${MOD}Z)`}>
          <Undo2 className="h-3.5 w-3.5" />
        </button>
        <button type="button" className="rounded p-1 hover:bg-panel-2 disabled:opacity-40" disabled={!canRedo} onClick={onRedo} title={`Redo (${MOD}Shift+Z)`}>
          <Redo2 className="h-3.5 w-3.5" />
        </button>
        <span className="ml-auto hidden lg:inline">Right-click for options · {MOD}scroll zooms · Alt disables snapping</span>
        <button type="button" className="rounded p-1 hover:bg-panel-2" onClick={() => zoom(1 / 1.5, current)} title="Zoom in">
          <ZoomIn className="h-3.5 w-3.5" />
        </button>
        <button type="button" className="rounded p-1 hover:bg-panel-2" onClick={() => zoom(1.5, current)} title="Zoom out">
          <ZoomOut className="h-3.5 w-3.5" />
        </button>
        <button type="button" className="rounded p-1 hover:bg-panel-2" onClick={() => setView(fitView())} title="Fit clip">
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex" onWheel={onWheel}>
        {/* lane labels */}
        <div className="shrink-0 border-r border-border text-muted" style={{ width: LABEL_W }}>
          <div className="flex h-5 items-center px-1.5 border-b border-border/60" />
          <div className="flex h-6 items-center px-1.5 border-b border-border/60">Words</div>
          <div className="flex h-8 items-center px-1.5 border-b border-border/60">Clip</div>
          <div className="flex h-9 items-center px-1.5">Layout</div>
        </div>

        <ContextMenu.Root modal={false}>
        <ContextMenu.Trigger asChild>
        <div ref={lanesRef} className="relative min-w-0 flex-1 overflow-hidden" onPointerMove={move} onPointerUp={end} onPointerCancel={end} onPointerLeave={() => setHoverT(null)} onContextMenu={onContext}>
          {/* ruler */}
          <div data-lane="ruler" className={`${lane} h-5 cursor-ew-resize bg-panel/60`} onPointerDown={(e) => begin(e, { kind: "scrub" })}>
            {ticks.map((t) => (
              <div key={t} className="absolute top-0 h-full border-l border-border/80 pl-1 font-mono text-muted" style={{ left: x(t) }}>
                {formatTime(t)}
              </div>
            ))}
            {sceneCuts.filter((c) => c >= view[0] && c <= view[1]).map((c) => (
              <div key={c} className="absolute bottom-0 h-1.5 w-px bg-accent-2/70" style={{ left: x(c) }} title={`Scene cut ${formatTime(c)}`} />
            ))}
          </div>

          {/* words */}
          <div data-lane="words" className={`${lane} h-6 cursor-grab`} onPointerDown={(e) => e.button === 0 && begin(e, { kind: "pan", grabX: e.clientX, orig: view })}>
            {visibleWords.map((wd, i) => {
              const left = x(wd.start);
              const width = Math.max(2, x(wd.end) - left);
              const inClip = wd.end > range[0] && wd.start < range[1];
              return (
                <div
                  key={`${wd.start}-${i}`}
                  className={`absolute top-1 bottom-1 overflow-hidden whitespace-nowrap rounded-sm px-0.5 leading-4 ${inClip ? "bg-accent/25 text-text" : "bg-panel text-muted"}`}
                  style={{ left, width }}
                  title={`${wd.text} ${formatTime(wd.start)}`}
                  onDoubleClick={() => onSeek(wd.start)}
                >
                  {width > 18 ? wd.text : ""}
                </div>
              );
            })}
          </div>

          {/* clip range */}
          <div data-lane="clip" className={`${lane} h-8`}>
            <div className="absolute inset-y-0 left-0 bg-black/30" style={{ width: Math.max(0, x(range[0])) }} />
            <div className="absolute inset-y-0 right-0 bg-black/30" style={{ left: Math.min(w, x(range[1])) }} />
            <div
              className="absolute inset-y-1 cursor-grab rounded border border-accent bg-accent/25 active:cursor-grabbing"
              style={{ left: x(range[0]), width: Math.max(4, x(range[1]) - x(range[0])) }}
              onPointerDown={(e) => begin(e, { kind: "move", grabT: tAt(e.clientX), orig: range })}
              title="Drag to slide the whole clip"
            >
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[10px] text-text/80">{(range[1] - range[0]).toFixed(1)}s</span>
            </div>
            {(["start", "end"] as const).map((k) => (
              <div
                key={k}
                className="absolute inset-y-0 z-10 flex w-3 -translate-x-1/2 cursor-ew-resize items-center justify-center"
                style={{ left: x(k === "start" ? range[0] : range[1]) }}
                onPointerDown={(e) => begin(e, { kind: k })}
                title={k === "start" ? "Drag clip start" : "Drag clip end"}
              >
                <div className={`h-full w-1.5 rounded-sm ${drag?.kind === k ? "bg-accent-2" : "bg-accent"}`} />
              </div>
            ))}
          </div>

          {/* layout track */}
          <div data-lane="layout" className="relative h-9 cursor-crosshair" onPointerEnter={() => setHoverLane("layout")} onPointerLeave={() => setHoverLane(null)} onDoubleClick={(e) => onSplit(Number(tAt(e.clientX).toFixed(2)))}>
            {sections.map((s, i) => {
              const left = x(s.start);
              const width = Math.max(2, x(s.end) - left);
              const det = s.mode === "auto" ? detected.filter((d) => d.end > s.start && d.start < s.end) : [];
              const color = MODE_COLOR[s.mode]!;
              return (
                <div
                  key={i}
                  className={`absolute inset-y-1 cursor-pointer overflow-hidden rounded ${selected === i ? "ring-2 ring-accent-2" : ""}`}
                  style={{ left, width, background: `${color}33`, border: `1px ${s.mode === "auto" ? "dashed" : "solid"} ${color}` }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onSelect(i);
                  }}
                  title={`${MODE_LABEL[s.mode]} ${formatTime(s.start)}–${formatTime(s.end)}`}
                >
                  <span className="pointer-events-none absolute left-1 top-0.5 whitespace-nowrap font-medium" style={{ color }}>
                    {width > 40 ? MODE_LABEL[s.mode] : ""}
                    {width > 60 && s.offsetX ? ` ↔${s.offsetX > 0 ? "+" : ""}${Math.round(s.offsetX * 100)}%` : ""}
                    {width > 90 && s.mode === "auto" && det.length ? ` · ${[...new Set(det.map((d) => MODE_LABEL[d.layout]))].join("/")}` : ""}
                  </span>
                  {/* what the detector picked inside auto sections */}
                  {det.map((d, j) => (
                    <div
                      key={j}
                      className="pointer-events-none absolute bottom-0 h-1"
                      style={{ left: x(Math.max(s.start, d.start)) - left, width: Math.max(1, x(Math.min(s.end, d.end)) - x(Math.max(s.start, d.start))), background: MODE_COLOR[d.layout] }}
                      title={d.reason}
                    />
                  ))}
                </div>
              );
            })}
            {/* razor guide: where a double-click / right-click split would land */}
            {hoverLane === "layout" && hoverT !== null && !drag && canSplitAt(hoverT) && (
              <div className="pointer-events-none absolute inset-y-0 z-10 border-l border-dashed border-accent-2" style={{ left: x(hoverT) }}>
                <Scissors className="absolute -left-1.5 -top-0.5 h-3 w-3 -rotate-90 text-accent-2" />
              </div>
            )}
            {/* transition handles */}
            {sections.slice(1).map((s, k) => (
              <div
                key={`b${k}`}
                className="absolute inset-y-0 z-10 flex w-3 -translate-x-1/2 cursor-ew-resize items-center justify-center"
                style={{ left: x(s.start) }}
                onPointerDown={(e) => begin(e, { kind: "boundary", index: k + 1 })}
                title={`Transition at ${formatTime(s.start)} (drag to move)`}
              >
                <div className={`h-6 w-1 rounded-full ${drag?.kind === "boundary" && drag.index === k + 1 ? "bg-accent-2" : "bg-text/80"}`} />
              </div>
            ))}
          </div>

          {/* playhead + hover line */}
          {hoverT !== null && !drag && <div className="pointer-events-none absolute inset-y-0 w-px bg-text/20" style={{ left: x(hoverT) }} />}
          {playX >= 0 && playX <= w && (
            <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-danger" style={{ left: playX }}>
              <div className="absolute -left-1 top-0 h-2 w-2 rotate-45 bg-danger" />
            </div>
          )}
        </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <TimelineMenu
            at={menuAt}
            sections={sections}
            range={range}
            current={current}
            canSplitAt={canSplitAt}
            onSplit={onSplit}
            onSetMode={onSetMode}
            onMerge={onMerge}
            onResetLayout={onResetLayout}
            onSetIn={(t) => onRange([Math.min(t, range[1] - MIN_CLIP), range[1]])}
            onSetOut={(t) => onRange([range[0], Math.max(t, range[0] + MIN_CLIP)])}
            onSeek={onSeek}
            onUndo={onUndo}
            onRedo={onRedo}
            canUndo={canUndo}
            canRedo={canRedo}
          />
        </ContextMenu.Portal>
        </ContextMenu.Root>
      </div>
    </div>
  );
}

const MENU_MODES: SectionMode[] = ["auto", "face", "split", "stack", "fit", "center"];
const item = "menu-item text-xs";

function TimelineMenu(p: {
  at: { t: number; lane: string; section: number } | null;
  sections: EditorSection[];
  range: [number, number];
  current: number;
  canSplitAt: (t: number) => boolean;
  onSplit: (t: number) => void;
  onSetMode: (i: number, m: SectionMode) => void;
  onMerge: (i: number, side: "left" | "right") => void;
  onResetLayout: () => void;
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
  const inClip = at.t > p.range[0] && at.t < p.range[1];
  return (
    <ContextMenu.Content className="z-[60] min-w-56 rounded-md border border-border bg-panel p-1 shadow-xl outline-none" collisionPadding={8}>
      <ContextMenu.Label className="px-2 py-1 font-mono text-[10px] text-muted">{formatTime(at.t)}</ContextMenu.Label>
      <ContextMenu.Item className={item} disabled={!p.canSplitAt(at.t)} onSelect={() => p.onSplit(at.t)}>
        <Scissors className="h-3.5 w-3.5" /> Split layout here
      </ContextMenu.Item>
      <ContextMenu.Item className={item} disabled={!p.canSplitAt(p.current)} onSelect={() => p.onSplit(p.current)}>
        <Scissors className="h-3.5 w-3.5 opacity-60" /> Split at playhead <span className="menu-hint">{SPLIT_SHORTCUT}</span>
      </ContextMenu.Item>
      {sec && inClip && (
        <>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className={item}>
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: MODE_COLOR[sec.mode] }} /> Framing: {MODE_LABEL[sec.mode]}
              <ChevronRight className="ml-auto h-3.5 w-3.5" />
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="z-[61] min-w-36 rounded-md border border-border bg-panel p-1 shadow-xl outline-none" sideOffset={4}>
                {MENU_MODES.map((m) => (
                  <ContextMenu.Item key={m} className={item} onSelect={() => p.onSetMode(at.section, m)}>
                    <span className="h-2.5 w-2.5 rounded-sm" style={{ background: MODE_COLOR[m] }} /> {MODE_LABEL[m]}
                    {sec.mode === m && <Check className="ml-auto h-3.5 w-3.5" />}
                  </ContextMenu.Item>
                ))}
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Item className={item} disabled={at.section === 0} onSelect={() => p.onMerge(at.section, "left")}>
            Remove transition on the left
          </ContextMenu.Item>
          <ContextMenu.Item className={item} disabled={at.section >= p.sections.length - 1} onSelect={() => p.onMerge(at.section, "right")}>
            Remove transition on the right
          </ContextMenu.Item>
        </>
      )}
      <ContextMenu.Item className={item} disabled={p.sections.length < 2 && p.sections[0]?.mode === "auto"} onSelect={p.onResetLayout}>
        Reset layout to auto
      </ContextMenu.Item>
      <ContextMenu.Separator className="my-1 h-px bg-border" />
      <ContextMenu.Item className={item} onSelect={() => p.onSetIn(at.t)} disabled={at.t >= p.range[1] - MIN_CLIP}>
        Set clip start here <span className="menu-hint">I at playhead</span>
      </ContextMenu.Item>
      <ContextMenu.Item className={item} onSelect={() => p.onSetOut(at.t)} disabled={at.t <= p.range[0] + MIN_CLIP}>
        Set clip end here <span className="menu-hint">O at playhead</span>
      </ContextMenu.Item>
      <ContextMenu.Item className={item} onSelect={() => p.onSeek(at.t)}>
        Move playhead here
      </ContextMenu.Item>
      <ContextMenu.Separator className="my-1 h-px bg-border" />
      <ContextMenu.Item className={item} disabled={!p.canUndo} onSelect={p.onUndo}>
        <Undo2 className="h-3.5 w-3.5" /> Undo <span className="menu-hint">{MOD}Z</span>
      </ContextMenu.Item>
      <ContextMenu.Item className={item} disabled={!p.canRedo} onSelect={p.onRedo}>
        <Redo2 className="h-3.5 w-3.5" /> Redo <span className="menu-hint">{MOD}⇧Z</span>
      </ContextMenu.Item>
    </ContextMenu.Content>
  );
}
