import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Scissors, Undo2, Redo2, Check } from "lucide-react";
import { formatTime, contentLabel, type ContentRegion, type DetectedSegment, type SectionMode, type Word } from "@reelsaw/shared";

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
export const SPLIT_SHORTCUT = `${MOD}B`;

export interface EditorSection {
  start: number;
  end: number;
  mode: SectionMode;
  /** manual horizontal re-centring, fraction of source width */
  offsetX?: number;
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
  /** controls shown at the left of the toolbar (trim fields) */
  toolbar?: React.ReactNode;
  /** hide the hint line on short screens */
  compactHints?: boolean;
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
export function Timeline({ sourceDuration, range, onRange, current, onSeek, words, sceneCuts, sections, onSections, onSplit, onSetMode, onMerge, onResetLayout, onUndo, onRedo, canUndo, canRedo, selected, onSelect, detected, cuts = [], onResetOffset, toolbar, compactHints }: Props) {
  const lanesRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const fitView = useCallback((): [number, number] => {
    const len = range[1] - range[0];
    const pad = Math.max(2, len * 0.25);
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

  const [snapHit, setSnapHit] = useState<{ t: number; kind: string } | null>(null);
  /** Snap within 8px to word edges, scene changes and the playhead. Alt disables. */
  const snapT = (t: number, prefer: "start" | "end" | "any", alt: boolean) => {
    if (alt) {
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
    setSnapHit(kind ? { t: best, kind } : null);
    return Number(best.toFixed(2));
  };

  function zoom(factor: number, around = (view[0] + view[1]) / 2) {
    setSpan(span * factor, around);
  }
  function setSpan(next: number, around = (view[0] + view[1]) / 2) {
    const newSpan = Math.max(MIN_SPAN, Math.min(Math.max(MIN_SPAN, Math.min(MAX_SPAN, sourceDuration || MAX_SPAN)), next));
    const frac = (around - view[0]) / span;
    const s = Math.max(0, around - frac * newSpan);
    setView([s, s + newSpan]);
  }

  function onWheel(e: React.WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, tAt(e.clientX));
    } else {
      // plain scroll pans the timeline
      const d = ((Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / w) * span;
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
    setSnapHit(null);
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

  // ruler ticks
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((st) => (st / span) * w >= 64) ?? 600;
  const ticks: number[] = [];
  for (let t = Math.ceil(view[0] / step) * step; t <= view[1]; t += step) ticks.push(t);

  const playX = x(current);
  const lane = "relative";
  const len = range[1] - range[0];
  const zoomMax = Math.max(MIN_SPAN + 1, Math.min(MAX_SPAN, sourceDuration || MAX_SPAN));
  const zoomVal = Math.round((1 - (Math.log(span) - Math.log(MIN_SPAN)) / (Math.log(zoomMax) - Math.log(MIN_SPAN))) * 100);
  const isCut = (wd: Word) => cuts.some((c) => wd.start >= c.start - 0.02 && wd.end <= c.end + 0.02);
  const label = "flex items-center px-4 text-xs font-semibold text-ink2";

  return (
    <div className="select-none">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        {toolbar}
        <span className="font-mono text-xs text-ink2">{len.toFixed(1)}s</span>
        <span className={`rounded-full px-2.5 py-[3px] font-mono text-[11px] whitespace-nowrap ${snapHit && drag ? "bg-acc text-acc-ink" : "bg-sunk text-ink2"}`}>{snapHit && drag ? `snap: ${snapHit.kind}` : "snapping on"}</span>
        <div className="ml-auto flex items-center gap-2 text-xs text-ink2">
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

          {/* clip range */}
          <div data-lane="clip" className={`${lane} mt-1.5 h-[34px] rounded-[8px] bg-sunk`}>
            <div
              className="absolute inset-y-0 flex cursor-grab items-center justify-center rounded-[8px] border-2 border-acc bg-acc-soft active:cursor-grabbing"
              style={{ left: x(range[0]), width: Math.max(4, x(range[1]) - x(range[0])) }}
              onPointerDown={(e) => begin(e, { kind: "move", grabT: tAt(e.clientX), orig: range })}
              title="Drag to slide the whole clip"
            >
              <span className="pointer-events-none font-mono text-[11px] font-semibold text-acc-text">{len.toFixed(1)}s</span>
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
                      {auto ? (chose ? `→ ${chose}` : "→ decided at render") : s.offsetX ? `offset ${s.offsetX > 0 ? "+" : ""}${Math.round(s.offsetX * 100)}%` : "forced"}
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
          />
        </ContextMenu.Portal>
        </ContextMenu.Root>
      </div>
      {!compactHints && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 pb-3 pr-4 text-[11px] text-ink3" style={{ paddingLeft: LABEL_W + 16 }}>
          <span>Drag the handles to trim; drag the clip to slide it</span>
          <span>Snaps to words, scene changes and the playhead · hold Alt to drag freely</span>
          <span>{MOD} + scroll zooms · right-click for framing</span>
        </div>
      )}
    </div>
  );
}

const MENU_MODES: SectionMode[] = ["auto", "face", "split", "stack", "fit", "center"];
const item = "menu-item";

function TimelineMenu(p: {
  at: { t: number; lane: string; section: number } | null;
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
            <ContextMenu.Item className={item} disabled={!sec.offsetX} onSelect={() => p.onResetOffset!(at.section)}>
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
