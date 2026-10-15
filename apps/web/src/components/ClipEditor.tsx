import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Play, Pause, SkipBack, RefreshCw, Scissors, Trash2, ShieldAlert, ChevronLeft, ChevronRight, Magnet, RotateCcw } from "lucide-react";
import { useTRPC } from "../lib/trpc";
import { ScrollArea } from "./scroll-area";
import { scrollWithin } from "../lib/scroll";
import { VerticalPreview, type Framing, type PreviewLayout } from "./VerticalPreview";
import { StyleControls, Segmented } from "./StyleControls";
import { Timeline, normalizeSections, MODE_COLOR, MODE_LABEL, SPLIT_SHORTCUT, type EditorSection } from "./Timeline";
import { useHistory } from "../lib/history";
import { formatTime, resolveStyle, type DetectedSegment, type LayoutSection, type ProjectSettings, type SectionMode, type SourceOverlay, type Style, type StyleOverride, type Word } from "@reelsaw/shared";

export interface EditorClip {
  id: string;
  index: number;
  title: string;
  hook: string;
  caption: string;
  startSec: number;
  endSec: number;
  layoutOverride: string | null;
  layout: string | null;
  layoutSections: LayoutSection[];
  layoutSegments: DetectedSegment[];
  style: StyleOverride | null;
  emphasis: string[];
}

interface Props {
  projectId: string;
  sourceVideoUrl: string;
  durationSec: number;
  srcW: number;
  srcH: number;
  settings: ProjectSettings;
  words: Word[];
  sceneCuts: number[];
  /** burned-in source text the render will blur / avoid (empty when the project keeps it) */
  overlays: SourceOverlay[];
  clip: EditorClip;
  onClose: () => void;
}

const FRAME = 1 / 30;
const MODES: SectionMode[] = ["auto", "face", "split", "stack", "fit", "center"];
type Tab = "layout" | "captions" | "text" | "transcript";

interface EditorDoc {
  range: [number, number];
  sections: EditorSection[];
  title: string;
  hook: string;
  caption: string;
  style: Style;
  emphasis: string[];
}

/** Forced sections from the DB + auto in the gaps, covering the clip. */
function initialSections(clip: EditorClip, range: [number, number]): EditorSection[] {
  if (clip.layoutSections.length) {
    const forced = [...clip.layoutSections].sort((a, b) => a.start - b.start);
    const out: EditorSection[] = [];
    let t = range[0];
    for (const s of forced) {
      if (s.start > t + 0.05) out.push({ start: t, end: s.start, mode: "auto" });
      out.push({ ...s });
      t = Math.max(t, s.end);
    }
    if (t < range[1] - 0.05) out.push({ start: t, end: range[1], mode: "auto" });
    return normalizeSections(out, range);
  }
  const legacy = clip.layoutOverride && clip.layoutOverride !== "auto" ? (clip.layoutOverride === "none" ? "fit" : clip.layoutOverride) : "auto";
  return [{ start: range[0], end: range[1], mode: legacy as SectionMode }];
}

function parseTime(v: string): number | null {
  const t = v.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
function fmtPrecise(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

function TimeField({ value, onCommit, label }: { value: number; onCommit: (t: number) => void; label: string }) {
  const [text, setText] = useState(fmtPrecise(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(fmtPrecise(value));
  }, [value, focused]);
  const commit = () => {
    const t = parseTime(text);
    if (t !== null) onCommit(t);
    else setText(fmtPrecise(value));
  };
  return (
    <input
      aria-label={label}
      data-native-undo
      className="input w-24 px-2 py-1 text-center font-mono text-xs"
      value={text}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          onCommit(value + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 1 : 0.1));
        }
      }}
    />
  );
}

/**
 * Clip editor: live 9:16 preview of the source with the clip's framing and captions, a multi-lane
 * timeline (words, clip range, layout sections + transitions), precise trim controls, and tabs for
 * layout, caption style (this clip or all clips), text and transcript-based trimming.
 */
export function ClipEditor({ projectId, sourceVideoUrl, durationSec, srcW, srcH, settings, words, sceneCuts, overlays, clip, onClose }: Props) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  // everything the user edits lives in one document so Ctrl/Cmd+Z covers all of it
  const projectStyle = useMemo(() => resolveStyle(settings), [settings]);
  const history = useHistory<EditorDoc>(() => ({
    range: [clip.startSec, clip.endSec],
    sections: initialSections(clip, [clip.startSec, clip.endSec]),
    title: clip.title,
    hook: clip.hook,
    caption: clip.caption,
    style: resolveStyle(settings, clip.style),
    emphasis: clip.emphasis,
  }));
  const { range, sections, title, hook, caption, style, emphasis } = history.state;
  const [emInput, setEmInput] = useState("");
  const edit = (patch: Partial<EditorDoc> | ((d: EditorDoc) => Partial<EditorDoc>), key?: string) => history.set((d) => ({ ...d, ...(typeof patch === "function" ? patch(d) : patch) }), key);
  const setTitle = (v: string) => edit({ title: v }, "title");
  const setHook = (v: string) => edit({ hook: v }, "hook");
  const setCaption = (v: string) => edit({ caption: v }, "caption");
  const setStyle = (patch: Partial<Style>, key?: string) => edit((d) => ({ style: { ...d.style, ...patch } }), key);
  const [selected, setSelectedRaw] = useState<number | null>(null);
  const setSelected = setSelectedRaw;
  // undo can shrink the section list under the selection
  useEffect(() => {
    if (selected !== null && selected >= sections.length) setSelectedRaw(sections.length - 1);
  }, [sections.length, selected]);
  const [styleScope, setStyleScope] = useState<"clip" | "all">("clip");
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(clip.startSec);
  const [pendingStart, setPendingStart] = useState<number | null>(null);
  const [buffering, setBuffering] = useState(true);
  const [tab, setTab] = useState<Tab>("layout");
  const [snap, setSnap] = useState(true);
  const [safe, setSafe] = useState(false);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const update = useMutation(trpc.clips.update.mutationOptions());
  const updateStyle = useMutation(trpc.projects.updateStyle.mutationOptions());

  const setRange = (r: [number, number], key?: string) => {
    const a = Math.max(0, Number(r[0].toFixed(2)));
    const b = Math.min(durationSec || Infinity, Number(r[1].toFixed(2)));
    if (b - a < 3) return;
    edit((d) => ({ range: [a, b], sections: normalizeSections(d.sections, [a, b]) }), key);
  };
  const setSections = (s: EditorSection[], key?: string) => edit((d) => ({ sections: normalizeSections(s, d.range) }), key);

  // media listeners once; read the live range through a ref
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    setVideoEl(v);
    const onTime = () => {
      setCurrent(v.currentTime);
      const [a, b] = rangeRef.current;
      if (!v.paused && v.currentTime >= b) {
        v.pause();
        v.currentTime = a;
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onWaiting = () => setBuffering(true);
    const onReady = () => setBuffering(false);
    const onMeta = () => {
      v.currentTime = rangeRef.current[0];
    };
    const evs: Array<[string, () => void]> = [
      ["timeupdate", onTime],
      ["play", onPlay],
      ["pause", onPause],
      ["waiting", onWaiting],
      ["seeking", onWaiting],
      ["canplay", onReady],
      ["seeked", onReady],
      ["loadedmetadata", onMeta],
    ];
    for (const [n, f] of evs) v.addEventListener(n, f);
    if (v.readyState >= 1) onMeta();
    // timeupdate fires ~4×/s; poll faster while playing so karaoke and the playhead stay smooth
    let raf = 0;
    const tick = () => {
      if (!v.paused) onTime();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      for (const [n, f] of evs) v.removeEventListener(n, f);
    };
  }, []);

  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, t);
    setCurrent(Math.max(0, t));
  };
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime < range[0] - 0.05 || v.currentTime >= range[1] - 0.05) v.currentTime = range[0];
      v.play().catch((err) => console.warn("[editor] play rejected", err));
    } else v.pause();
  };
  const setIn = (t: number) => setRange([Math.min(t, range[1] - 3), range[1]]);
  const setOut = (t: number) => setRange([range[0], Math.max(t, range[0] + 3)]);
  /** Blade at time t (Premiere ⌘K / Final Cut ⌘B): the section under t becomes two with the same framing. */
  const splitAt = (t: number) => {
    const i = sections.findIndex((s) => t > s.start + 0.3 && t < s.end - 0.3);
    if (i < 0) return;
    const s = sections[i]!;
    setSections([...sections.slice(0, i), { ...s, end: t }, { ...s, start: t }, ...sections.slice(i + 1)]);
    setSelected(i + 1);
  };
  const splitAtPlayhead = () => splitAt(current);
  /** Remove the transition on one side of section i: it absorbs into that neighbour, which keeps its framing. */
  const mergeSection = (i: number, side: "left" | "right") => {
    if (sections.length < 2) return;
    const next = sections.map((s) => ({ ...s }));
    if (side === "left" && i > 0) {
      next[i - 1]!.end = next[i]!.end;
      next.splice(i, 1);
      setSelected(i - 1);
    } else if (side === "right" && i < next.length - 1) {
      next[i + 1]!.start = next[i]!.start;
      next.splice(i, 1);
      setSelected(i);
    } else return;
    setSections(next);
  };
  const removeTransition = (i: number) => mergeSection(i, i > 0 ? "left" : "right");
  const setMode = (i: number, mode: SectionMode) => setSections(sections.map((s, j) => (j === i ? { ...s, mode } : s)));
  const resetLayout = () => {
    setSections([{ start: range[0], end: range[1], mode: "auto" }]);
    setSelected(null);
  };

  // keyboard: space play, I/O in/out, S split, ←/→ frame step (shift = 1 s), Delete removes the selected transition
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      // undo/redo own the whole editor, text fields included (they are part of the document);
      // the timestamp fields keep native editing until committed
      if (mod && (k === "z" || k === "y") && !el.closest("[data-native-undo]")) {
        e.preventDefault();
        if (k === "y" || e.shiftKey) history.redo();
        else history.undo();
        return;
      }
      if (el.closest("input, textarea, select, [contenteditable]")) return;
      if (mod && (k === "b" || k === "k")) {
        e.preventDefault();
        splitAtPlayhead();
        return;
      }
      if (mod) return;
      if (e.key === "Escape") requestClose();
      else if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "i" || e.key === "I") setIn(current);
      else if (e.key === "o" || e.key === "O") setOut(current);
      else if (e.key === "s" || e.key === "S") splitAtPlayhead();
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        seek(current + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 1 : FRAME));
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected !== null) removeTransition(selected);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // framing at the playhead: forced section → that layout; auto → what the last render detected there.
  // The crop follows the stored face track over time; manual offsets are re-applied on top.
  const secIdx = Math.max(0, sections.findIndex((s) => current >= s.start && current < s.end));
  const framing: Framing = useMemo(() => {
    const t = current;
    const sec = sections[secIdx] ?? sections[0]!;
    const det = clip.layoutSegments.find((d) => t >= d.start && t < d.end) ?? clip.layoutSegments.find((d) => !d.manual);
    const fallback: PreviewLayout = clip.layout && clip.layout !== "mixed" ? (clip.layout as PreviewLayout) : "fit";
    const layout: PreviewLayout = sec.mode === "auto" ? (det && !det.manual ? det.layout : fallback) : sec.mode;
    let x = det?.cx ?? 0.5;
    const tr = det?.track;
    if (tr?.length) {
      const k = tr.findIndex(([pt]) => pt > t);
      if (k <= 0) x = tr[k === 0 ? 0 : tr.length - 1]![1];
      else {
        const [t0, x0] = tr[k - 1]!;
        const [t1, x1] = tr[k]!;
        x = x0 + ((x1 - x0) * (t - t0)) / Math.max(0.01, t1 - t0);
      }
    }
    // centre crops start at the middle; tracked crops at the detected face (minus any offset already baked into the render)
    const base = layout === "center" ? 0.5 : x - (det?.offsetX ?? 0);
    return {
      layout,
      cx: Math.max(0, Math.min(1, base + (sec.offsetX ?? 0))),
      cy: det?.cy ?? 0.45,
      cx2: det?.cx2 !== undefined ? det.cx2 - (det.offsetX ?? 0) + (sec.offsetX ?? 0) : undefined,
      cy2: det?.cy2,
      size: det?.size,
      size2: det?.size2,
    };
  }, [current, sections, secIdx, clip.layoutSegments, clip.layout]);

  const panSection = (dx: number) => {
    const i = secIdx;
    const next = sections.map((s, j) => (j === i ? { ...s, offsetX: Math.max(-0.5, Math.min(0.5, Number(((s.offsetX ?? 0) + dx).toFixed(4)))) } : s));
    setSections(next, `pan-${i}`);
  };
  const resetOffset = (i: number) => setSections(sections.map((s, j) => (j === i ? { ...s, offsetX: undefined } : s)));

  const clipWords = useMemo(
    () => words.filter((w) => w.end > range[0] && w.start < range[1]).map((w) => ({ text: w.text, start: Math.max(0, w.start - range[0]), end: w.end - range[0] })),
    [words, range],
  );

  const activeWordRef = useRef<HTMLSpanElement>(null);
  const wordsViewportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (tab === "transcript" && wordsViewportRef.current && activeWordRef.current) scrollWithin(wordsViewportRef.current, activeWordRef.current, { block: "nearest", behavior: "auto" });
  }, [current, tab]);
  const transcriptWords = useMemo(() => words.filter((w) => w.end >= range[0] - 60 && w.start <= range[1] + 60), [words, range]);
  function clickWord(w: Word) {
    if (pendingStart === null) {
      setPendingStart(w.start);
      seek(w.start);
    } else {
      const a = Math.min(pendingStart, w.end);
      const b = Math.max(pendingStart, w.end);
      setRange([a - 0.05, b + 0.08]);
      setPendingStart(null);
      seek(a);
    }
  }

  // ----- dirty tracking + save -----
  const toSaved = (s: { start: number; end: number; mode: SectionMode; offsetX?: number }) => ({ start: Number(s.start.toFixed(2)), end: Number(s.end.toFixed(2)), mode: s.mode, ...(s.offsetX ? { offsetX: Number(s.offsetX.toFixed(4)) } : {}) });
  const forcedSections = sections.filter((s) => s.mode !== "auto" || s.offsetX).map(toSaved);
  const sectionsChanged = JSON.stringify(forcedSections) !== JSON.stringify(clip.layoutSections.map(toSaved)) || (!!clip.layoutOverride && !forcedSections.length && clip.layoutOverride !== "auto");
  const styleOverride: StyleOverride = useMemo(() => {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(style) as Array<keyof Style>) if (style[k] !== projectStyle[k]) o[k] = style[k];
    return o as StyleOverride;
  }, [style, projectStyle]);
  const initialStyle = useMemo(() => resolveStyle(settings, clip.style), [settings, clip.style]);
  const styleChanged = JSON.stringify(style) !== JSON.stringify(initialStyle) || (styleScope === "all" && Object.keys(styleOverride).length > 0);
  const emphasisChanged = JSON.stringify(emphasis) !== JSON.stringify(clip.emphasis);
  const textChanged = title !== clip.title || hook !== clip.hook || caption !== clip.caption;
  const boundsChanged = range[0] !== clip.startSec || range[1] !== clip.endSec;
  const changed = textChanged || boundsChanged || sectionsChanged || styleChanged || emphasisChanged;
  const needsRender = boundsChanged || sectionsChanged || styleChanged || emphasisChanged || hook !== clip.hook;

  async function save(rerender: boolean) {
    if (styleChanged && styleScope === "all") await updateStyle.mutateAsync({ id: projectId, style, rerender });
    await update.mutateAsync({
      id: clip.id,
      title,
      hook,
      caption,
      startSec: range[0],
      endSec: range[1],
      ...(emphasisChanged ? { emphasis } : {}),
      ...(sectionsChanged ? { layoutSections: forcedSections, layoutOverride: null } : {}),
      ...(styleChanged && styleScope === "clip" ? { style: Object.keys(styleOverride).length ? styleOverride : null } : {}),
      rerender,
    });
    await qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: projectId }) });
    onClose();
  }

  const sel = selected !== null ? sections[selected] : undefined;
  const len = range[1] - range[0];
  const busy = update.isPending || updateStyle.isPending;
  const err = update.error ?? updateStyle.error;

  const requestClose = () => {
    if (!changed || window.confirm("Discard your changes to this clip?")) onClose();
  };
  const nudge = (which: "start" | "end", d: number) => (which === "start" ? setIn(range[0] + d) : setOut(range[1] + d));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-0 sm:p-4" onClick={requestClose}>
      <div className="card flex h-full w-full max-w-7xl flex-col overflow-hidden sm:h-[94vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
          <h2 className="truncate text-sm font-semibold">
            Edit clip #{clip.index + 1} · <span className="font-normal text-muted">{clip.title}</span>
          </h2>
          <button className="btn-ghost px-2" onClick={requestClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="grid gap-4 p-4 pb-2 lg:grid-cols-[minmax(240px,340px)_minmax(0,1fr)]">
            {/* preview */}
            <div className="space-y-2">
              <div className="relative h-[46vh] min-h-[300px] sm:h-[calc(94vh-360px)]">
                <VerticalPreview
                  source={videoEl}
                  srcW={srcW}
                  srcH={srcH}
                  framing={framing}
                  style={style}
                  words={clipWords}
                  time={current - range[0]}
                  hook={hook}
                  emphasis={emphasis}
                  onPan={tab === "layout" ? panSection : undefined}
                  overlays={overlays}
                  alwaysShowHook={tab === "captions" && !playing}
                  onStyleChange={(p) => setStyle(p, "drag-text")}
                  showSafeZones={safe}
                />
                {buffering && <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded bg-black/60 px-2 py-1 text-xs text-muted">Loading…</div>}
                <video ref={videoRef} src={sourceVideoUrl} preload="auto" playsInline className="pointer-events-none absolute h-px w-px opacity-0" />
              </div>
              <div className="flex items-center justify-center gap-1 text-xs text-muted">
                <button className="btn-ghost px-2" onClick={() => seek(range[0])} title="Jump to clip start">
                  <SkipBack className="h-4 w-4" />
                </button>
                <button className="btn-ghost px-2" onClick={() => seek(current - FRAME)} title="Previous frame (←)">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button className="btn-primary px-3" onClick={togglePlay} title="Play/pause (space)">
                  {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                </button>
                <button className="btn-ghost px-2" onClick={() => seek(current + FRAME)} title="Next frame (→)">
                  <ChevronRight className="h-4 w-4" />
                </button>
                <button className={`btn-ghost px-2 ${safe ? "text-danger" : ""}`} onClick={() => setSafe(!safe)} title="Platform safe zones">
                  <ShieldAlert className="h-4 w-4" />
                </button>
                <span className="ml-2 font-mono">{fmtPrecise(Math.max(0, current - range[0]))}</span>
              </div>
            </div>

            {/* tabs */}
            <div className="min-w-0 space-y-3">
              <Segmented
                value={tab}
                onChange={setTab}
                options={[
                  { value: "layout", label: "Layout" },
                  { value: "captions", label: "Captions" },
                  { value: "text", label: "Text" },
                  { value: "transcript", label: "Transcript" },
                ]}
              />

              {tab === "layout" && (
                <div className="space-y-3 text-sm">
                  <p className="text-xs text-muted">
                    The layout track below splits the clip into sections. <b>Auto</b> sections follow face detection (the coloured strip shows what it picked). Split with <kbd>{SPLIT_SHORTCUT}</kbd>, the Split button, a double-click, or right-click → Split layout here. Drag a transition to move it; right-click a section to change its framing or remove a transition. Everything is undoable.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button className="btn-ghost px-2 py-1 text-xs" onClick={splitAtPlayhead} title="S">
                      <Scissors className="h-3.5 w-3.5" /> Split at playhead <span className="text-muted">{SPLIT_SHORTCUT}</span>
                    </button>
                    <button className="btn-ghost px-2 py-1 text-xs" disabled={sections.length < 2} onClick={resetLayout}>
                      <RotateCcw className="h-3.5 w-3.5" /> Reset all to auto
                    </button>
                  </div>
                  {(() => {
                    const s = sections[secIdx];
                    if (!s) return null;
                    const crop = framing.layout !== "fit" && framing.layout !== "none";
                    return (
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                        <span>
                          Centering at playhead (section {secIdx + 1}):{" "}
                          <span className="font-mono text-text">{s.offsetX ? `${s.offsetX > 0 ? "+" : ""}${Math.round(s.offsetX * 100)}%` : "auto"}</span>
                        </span>
                        {crop ? <span>· drag the picture left/right to re-centre</span> : <span>· not adjustable in {MODE_LABEL[framing.layout]}</span>}
                        {s.offsetX ? (
                          <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => resetOffset(secIdx)}>
                            Reset
                          </button>
                        ) : null}
                      </div>
                    );
                  })()}
                  {sel ? (
                    <div className="card space-y-2 p-3">
                      <div className="flex items-center justify-between text-xs">
                        <span>
                          Section {selected! + 1} of {sections.length} · <span className="font-mono">{fmtPrecise(sel.start)} – {fmtPrecise(sel.end)}</span>
                        </span>
                        {sections.length > 1 && (
                          <button className="btn-ghost px-2 py-1 text-xs text-danger" onClick={() => removeTransition(selected!)} title="Delete">
                            <Trash2 className="h-3.5 w-3.5" /> Remove transition
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {MODES.map((m) => (
                          <button
                            key={m}
                            onClick={() => setMode(selected!, m)}
                            className={`rounded-md border px-2.5 py-1 text-xs ${sel.mode === m ? "text-text" : "border-border text-muted hover:text-text"}`}
                            style={sel.mode === m ? { borderColor: MODE_COLOR[m], background: `${MODE_COLOR[m]}33` } : undefined}
                          >
                            {MODE_LABEL[m]}
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-muted">
                        {sel.mode === "auto" && "Face detection decides: face crop, split for two people, stack for webcam over screen, fit when nobody is on screen."}
                        {sel.mode === "face" && "9:16 crop that follows the main face."}
                        {sel.mode === "split" && "Two speakers, one above the other."}
                        {sel.mode === "stack" && "Whole frame on top, zoomed face below. For screen shares with a webcam."}
                        {sel.mode === "fit" && "Whole frame over a blurred background. For slides, b-roll and wide shots."}
                        {sel.mode === "center" && "Static centre crop."}
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-muted">Click a section on the layout track to change its framing.</p>
                  )}
                </div>
              )}

              {tab === "captions" && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-muted">Apply to</span>
                    <Segmented
                      value={styleScope}
                      onChange={setStyleScope}
                      options={[
                        { value: "clip", label: "This clip" },
                        { value: "all", label: "All clips", title: "Updates the project style and re-renders every clip" },
                      ]}
                    />
                    {Object.keys(styleOverride).length > 0 && styleScope === "clip" && (
                      <button className="btn-ghost px-2 py-1 text-xs" onClick={() => edit({ style: projectStyle })}>
                        Use project style
                      </button>
                    )}
                  </div>
                  {style.emphasis && (
                    <div>
                      <label className="label">Key words in this clip</label>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {emphasis.map((w) => (
                          <span key={w} className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs" style={{ color: style.emphasisColor }}>
                            {w}
                            <button className="text-muted hover:text-text" onClick={() => edit((d) => ({ emphasis: d.emphasis.filter((x) => x !== w) }))} aria-label={`Remove ${w}`}>
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                        <input
                          className="input w-32 px-2 py-1 text-xs"
                          placeholder="add word…"
                          value={emInput}
                          onChange={(e) => setEmInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter" && e.key !== ",") return;
                            e.preventDefault();
                            const w = emInput.trim().toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
                            if (w && !emphasis.includes(w)) edit((d) => ({ emphasis: [...d.emphasis, w] }));
                            setEmInput("");
                          }}
                        />
                      </div>
                    </div>
                  )}
                  <StyleControls style={style} onChange={(p) => setStyle(p, `style:${Object.keys(p).join(",")}`)} />
                </div>
              )}

              {tab === "text" && (
                <div className="grid gap-3">
                  <div>
                    <label className="label">Title</label>
                    <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
                  </div>
                  <div>
                    <label className="label">Hook (burned in)</label>
                    <input className="input" value={hook} onChange={(e) => setHook(e.target.value)} maxLength={80} />
                  </div>
                  <div>
                    <label className="label">Post caption</label>
                    <textarea className="input" rows={3} value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={300} />
                  </div>
                </div>
              )}

              {tab === "transcript" && (
                <div className="card flex h-[40vh] flex-col">
                  <p className="border-b border-border px-3 py-2 text-xs text-muted">
                    {pendingStart === null ? "Click a word to set the start, then another to set the end." : `Start at ${formatTime(pendingStart)}; now click the last word.`}
                  </p>
                  <ScrollArea className="min-h-0 flex-1" viewportRef={wordsViewportRef}>
                    <p className="p-3 text-sm leading-7">
                      {transcriptWords.map((w, i) => {
                        const inRange = w.end > range[0] && w.start < range[1];
                        const active = current >= w.start && current < w.end;
                        return (
                          <span
                            key={i}
                            ref={active ? activeWordRef : undefined}
                            onClick={() => clickWord(w)}
                            className={`cursor-pointer rounded px-0.5 ${active ? "bg-accent text-black" : inRange ? "bg-accent/20" : "text-muted hover:text-text"} ${pendingStart === w.start ? "ring-1 ring-accent-2" : ""}`}
                          >
                            {w.text}{" "}
                          </span>
                        );
                      })}
                    </p>
                  </ScrollArea>
                </div>
              )}
            </div>
          </div>

        </ScrollArea>

        {/* trim controls + timeline: pinned under the scrolling area */}
        <div className="shrink-0 space-y-2 border-t border-border px-4 py-2">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
              {(["start", "end"] as const).map((k) => (
                <div key={k} className="flex items-center gap-1">
                  <span className="w-8 text-muted">{k === "start" ? "In" : "Out"}</span>
                  <button className="btn-ghost px-1.5 py-1 text-[11px]" onClick={() => nudge(k, -1)}>
                    −1s
                  </button>
                  <button className="btn-ghost px-1.5 py-1 text-[11px]" onClick={() => nudge(k, -0.1)}>
                    −.1
                  </button>
                  <TimeField label={k === "start" ? "Clip start" : "Clip end"} value={k === "start" ? range[0] : range[1]} onCommit={(t) => (k === "start" ? setIn(t) : setOut(t))} />
                  <button className="btn-ghost px-1.5 py-1 text-[11px]" onClick={() => nudge(k, 0.1)}>
                    +.1
                  </button>
                  <button className="btn-ghost px-1.5 py-1 text-[11px]" onClick={() => nudge(k, 1)}>
                    +1s
                  </button>
                  <button className="btn-ghost px-1.5 py-1 text-[11px]" onClick={() => (k === "start" ? setIn(current) : setOut(current))} title={k === "start" ? "Set to playhead (I)" : "Set to playhead (O)"}>
                    ⇥ playhead
                  </button>
                </div>
              ))}
              <span className="font-mono text-muted">{len.toFixed(2)}s</span>
              <label className="ml-auto flex items-center gap-1.5 text-muted" title="Snap edges and transitions to word boundaries, scene cuts and the playhead">
                <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
                <Magnet className="h-3.5 w-3.5" /> Snap
              </label>
            </div>
            <Timeline
              sourceDuration={durationSec}
              range={range}
              onRange={setRange}
              current={current}
              onSeek={seek}
              words={words}
              sceneCuts={sceneCuts}
              sections={sections}
              onSections={setSections}
              onSplit={splitAt}
              onSetMode={setMode}
              onMerge={mergeSection}
              onResetLayout={resetLayout}
              onUndo={history.undo}
              onRedo={history.redo}
              canUndo={history.canUndo}
              canRedo={history.canRedo}
              selected={selected}
              onSelect={(i) => {
                setSelected(i);
                if (i !== null) setTab("layout");
              }}
              detected={clip.layoutSegments}
              snap={snap}
            />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2">
          <span className="text-xs text-muted">
            {err ? <span className="text-danger">{err.message}</span> : changed ? (needsRender ? "Unsaved changes · needs a re-render" : "Unsaved changes") : "No changes"}
            <span className="ml-3 hidden md:inline">Space play · I/O in/out · {SPLIT_SHORTCUT} split · ←/→ frame · right-click timeline for more</span>
          </span>
          <div className="flex gap-2">
            <button className="btn-ghost" disabled={!changed || busy} onClick={() => save(false)}>
              Save only
            </button>
            <button className="btn-primary" disabled={!changed || busy} onClick={() => save(true)}>
              <RefreshCw className="h-4 w-4" /> {styleScope === "all" && styleChanged ? "Save & re-render all" : "Save & re-render"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
