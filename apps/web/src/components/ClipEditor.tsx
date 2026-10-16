import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Undo2, Redo2, Keyboard, PanelLeft, Loader2, X, Link2 } from "lucide-react";
import { useTRPC } from "../lib/trpc";
import { useToast } from "../lib/toast";
import { readHash, writeHash, linkWith, fmtSec } from "../lib/hash";
import { ScrollArea } from "./scroll-area";
import { scrollWithin } from "../lib/scroll";
import { VerticalPreview, safeZoneWarning, PLATFORM_NAME, type Framing, type Platform, type PreviewLayout } from "./VerticalPreview";
import { Timeline, normalizeSections, MODE_LABEL, SPLIT_SHORTCUT, type EditorSection } from "./Timeline";
import { Segmented, Modal, Kbd } from "./ui";
import { ThemeToggle } from "../App";
import { useHistory } from "../lib/history";
import {
  defaultStyle,
  formatTime,
  resolveStyle,
  type ClipDiagnostics,
  type DetectedSegment,
  type LayoutSection,
  type ProjectSettings,
  type SectionMode,
  type SourceOverlay,
  type Style,
  type StyleOverride,
  type TranscriptFlag,
  type TranscriptSegment,
  type Word,
} from "@reelsaw/shared";

export interface EditorClip {
  id: string;
  index: number;
  title: string;
  hook: string;
  caption: string;
  hashtags: string[];
  startSec: number;
  endSec: number;
  layoutOverride: string | null;
  layout: string | null;
  layoutSections: LayoutSection[];
  layoutSegments: DetectedSegment[];
  style: StyleOverride | null;
  emphasis: string[];
  status: string;
  diagnostics: ClipDiagnostics | null;
}

interface Props {
  projectId: string;
  projectTitle: string;
  clipCount: number;
  sourceVideoUrl: string;
  durationSec: number;
  srcW: number;
  srcH: number;
  settings: ProjectSettings;
  /** cleaned words (what captions say) */
  words: Word[];
  /** as-heard words, for the transcript and the hatched cuts on the timeline */
  rawWords: Word[];
  segments: TranscriptSegment[];
  flags: TranscriptFlag[];
  sceneCuts: number[];
  /** burned-in source text the render will blur / avoid (empty when the project keeps it) */
  overlays: SourceOverlay[];
  clip: EditorClip;
  /** live render progress for this clip, 0..1 */
  renderProgress?: number;
  onExit: () => void;
}

const FRAME = 1 / 30;
const MODES: SectionMode[] = ["auto", "face", "split", "stack", "fit", "center"];
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
type Tab = "captions" | "framing" | "text" | "cuts" | "transcript";
type Layout = "classic" | "transcript";
const LAYOUT_KEY = "rs-editor-layout";

interface EditorDoc {
  range: [number, number];
  sections: EditorSection[];
  title: string;
  hook: string;
  caption: string;
  hashtags: string[];
  style: Style;
  emphasis: string[];
}

const MODE_EXPLAIN: Record<string, string> = {
  face: "9:16 crop that follows whoever is talking.",
  split: "Two speakers, one above the other.",
  stack: "Whole frame on top, speaker zoomed below. For screen shares with a webcam.",
  fit: "Whole frame over a blurred background. For slides, b-roll and wide shots.",
  center: "Static centre crop.",
};

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
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
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
      className="w-[74px] rounded-[8px] border border-line bg-panel px-1.5 py-1 text-center font-mono text-xs text-ink outline-none focus:border-acc"
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

function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-ink2">{label}</span>
        {hint && <span className="text-[11px] text-ink3">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-[13px]">
      <span>{label}</span>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? "bg-acc" : "bg-line2"}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
      </button>
    </label>
  );
}

function Swatches({ colors, value, onChange, label }: { colors: string[]; value: string; onChange: (c: string) => void; label: string }) {
  const on = (c: string) => c.toUpperCase() === value.toUpperCase();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`${label} ${c}`}
          onClick={() => onChange(c)}
          className="h-[30px] w-[30px] rounded-full"
          style={{ background: c, border: on(c) ? "2px solid var(--ink)" : "2px solid var(--line)", outline: on(c) ? "2px solid var(--panel)" : "none", outlineOffset: -4 }}
        />
      ))}
      <label className="relative grid h-[30px] w-[30px] cursor-pointer place-items-center rounded-full border-2 border-dashed border-line2 text-xs text-ink3" title="Custom colour">
        +
        <input type="color" className="absolute inset-0 cursor-pointer opacity-0" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />
      </label>
    </div>
  );
}

const HL = ["#C6A8FF", "#FFD84D", "#5EE0A0", "#FFFFFF"];
const KW = ["#FFD84D", "#FF8A5C", "#5EE0A0", "#C6A8FF"];
const SIZES: Array<{ v: number; l: string }> = [
  { v: 0.8, l: "S" },
  { v: 1, l: "M" },
  { v: 1.25, l: "L" },
];

/**
 * Full-screen clip editor: live 9:16 preview of the source with the clip's framing and captions,
 * inspector tabs (captions, framing, text, cuts, transcript) and a multi-lane timeline. Every edit is
 * one undoable document; saving keeps you here so the re-render can be watched.
 */
export function ClipEditor(props: Props) {
  const { projectId, projectTitle, clipCount, sourceVideoUrl, durationSec, srcW, srcH, settings, words, rawWords, segments, flags, sceneCuts, overlays, clip, renderProgress, onExit } = props;
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const projectStyle = useMemo(() => resolveStyle(settings), [settings]);
  const history = useHistory<EditorDoc>(() => ({
    range: [clip.startSec, clip.endSec],
    sections: initialSections(clip, [clip.startSec, clip.endSec]),
    title: clip.title,
    hook: clip.hook,
    caption: clip.caption,
    hashtags: clip.hashtags,
    style: resolveStyle(settings, clip.style),
    emphasis: clip.emphasis,
  }));
  const { range, sections, title, hook, caption, hashtags, style, emphasis } = history.state;
  const edit = (patch: Partial<EditorDoc> | ((d: EditorDoc) => Partial<EditorDoc>), key?: string) => history.set((d) => ({ ...d, ...(typeof patch === "function" ? patch(d) : patch) }), key);
  const setStyle = (patch: Partial<Style>, key?: string) => edit((d) => ({ style: { ...d.style, ...patch } }), key);
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    if (selected !== null && selected >= sections.length) setSelected(sections.length - 1);
  }, [sections.length, selected]);
  const [styleScope, setStyleScope] = useState<"clip" | "all">("clip");
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(clip.startSec);
  const [buffering, setBuffering] = useState(true);
  // deep link: #tab=<tab>&t=<seconds into the clip>
  const TABS: Tab[] = ["captions", "framing", "text", "cuts", "transcript"];
  const [tab, setTab] = useState<Tab>(() => {
    const h = readHash().get("tab") as Tab | null;
    return h && TABS.includes(h) ? h : "captions";
  });
  useEffect(() => writeHash({ tab: tab === "captions" ? null : tab }), [tab]);
  const [safe, setSafe] = useState(true);
  const [platform, setPlatform] = useState<Platform>("tiktok");
  const [kwDraft, setKwDraft] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [guard, setGuard] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [txSel, setTxSel] = useState<{ start: number; end: number } | null>(null);
  const [layout, setLayoutRaw] = useState<Layout>(() => {
    try {
      return localStorage.getItem(LAYOUT_KEY) === "transcript" ? "transcript" : "classic";
    } catch {
      return "classic";
    }
  });
  const setLayout = (l: Layout) => {
    setLayoutRaw(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* private mode */
    }
    if (l === "transcript" && tab === "transcript") setTab("captions");
  };
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const compact = size.w < 900;
  const short = !compact && size.h < 720;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const update = useMutation(trpc.clips.update.mutationOptions());
  const setSourceText = useMutation(trpc.projects.setSourceText.mutationOptions());
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
      const t = Number(readHash().get("t"));
      const [a, b] = rangeRef.current;
      v.currentTime = Number.isFinite(t) && t > 0 ? Math.min(b - 0.05, a + t) : a;
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

  useEffect(() => {
    if (playing) return;
    const id = setTimeout(() => writeHash({ t: current > range[0] + 0.05 ? fmtSec(current - range[0]) : null }), 400);
    return () => clearTimeout(id);
  }, [current, playing, range]);
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
  const setIn = (t: number) => setRange([Math.min(t, range[1] - 1), range[1]]);
  const setOut = (t: number) => setRange([range[0], Math.max(t, range[0] + 1)]);
  const splitAt = (t: number) => {
    if (t <= range[0] + 0.5 || t >= range[1] - 0.5) return toast("Move the playhead inside the clip to split");
    if (sections.some((s) => Math.abs(s.start - t) < 0.5 && s.start > range[0])) return toast("Too close to an existing transition");
    const i = sections.findIndex((s) => t > s.start && t < s.end);
    if (i < 0) return;
    const s = sections[i]!;
    setSections([...sections.slice(0, i), { ...s, end: t }, { ...s, start: t }, ...sections.slice(i + 1)]);
    setSelected(i + 1);
    toast(`Split at ${fmtPrecise(t - range[0])}`);
  };
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
  const setMode = (i: number, mode: SectionMode) => setSections(sections.map((s, j) => (j === i ? { ...s, mode } : s)));
  const resetLayout = () => {
    setSections([{ start: range[0], end: range[1], mode: "auto" }]);
    setSelected(null);
  };

  // framing at the playhead: forced section → that layout; auto → what the last render detected there.
  const secIdx = Math.max(0, sections.findLastIndex((s) => current >= s.start - 0.02));
  const framing: Framing = useMemo(() => {
    const t = current;
    const sec = sections[secIdx] ?? sections[0]!;
    const det = clip.layoutSegments.find((d) => t >= d.start && t < d.end) ?? clip.layoutSegments.find((d) => !d.manual);
    const fallback: PreviewLayout = clip.layout && clip.layout !== "mixed" ? (clip.layout as PreviewLayout) : "fit";
    const lay: PreviewLayout = sec.mode === "auto" ? (det && !det.manual ? det.layout : fallback) : sec.mode;
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
    const base = lay === "center" ? 0.5 : x - (det?.offsetX ?? 0);
    return {
      layout: lay,
      cx: Math.max(0, Math.min(1, base + (sec.offsetX ?? 0))),
      cy: det?.cy ?? 0.45,
      cx2: det?.cx2 !== undefined ? det.cx2 - (det.offsetX ?? 0) + (sec.offsetX ?? 0) : undefined,
      cy2: det?.cy2,
      size: det?.size,
      size2: det?.size2,
    };
  }, [current, sections, secIdx, clip.layoutSegments, clip.layout]);
  const autoChoiceFor = (s: EditorSection) => [...new Set(clip.layoutSegments.filter((d) => !d.manual && d.end > s.start && d.start < s.end).map((d) => MODE_LABEL[d.layout]))].join(" / ");

  const panSection = (dx: number) => {
    const i = secIdx;
    setSections(
      sections.map((s, j) => (j === i ? { ...s, offsetX: Math.max(-0.5, Math.min(0.5, Number(((s.offsetX ?? 0) + dx).toFixed(4)))) } : s)),
      `pan-${i}`,
    );
  };
  const resetOffset = (i: number) => setSections(sections.map((s, j) => (j === i ? { ...s, offsetX: undefined } : s)));

  const clipWords = useMemo(
    () => words.filter((w) => w.end > range[0] && w.start < range[1]).map((w) => ({ text: w.text, start: Math.max(0, w.start - range[0]), end: w.end - range[0] })),
    [words, range],
  );
  const cutSpans = useMemo(() => flags.filter((f) => f.kind === "disfluency" && (f.status === "auto" || f.status === "accepted")).map((f) => ({ start: f.start, end: f.end })), [flags]);

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
  const tagsChanged = JSON.stringify(hashtags) !== JSON.stringify(clip.hashtags);
  const boundsChanged = range[0] !== clip.startSec || range[1] !== clip.endSec;
  const hookChanged = hook !== clip.hook;
  const dirtyCount = [title !== clip.title, hookChanged, caption !== clip.caption, tagsChanged, boundsChanged, sectionsChanged, styleChanged, emphasisChanged].filter(Boolean).length;
  const changed = dirtyCount > 0;
  const needsRender = boundsChanged || sectionsChanged || styleChanged || emphasisChanged || hookChanged;

  async function save(rerender: boolean): Promise<boolean> {
    try {
      if (styleChanged && styleScope === "all") await updateStyle.mutateAsync({ id: projectId, style, rerender });
      await update.mutateAsync({
        id: clip.id,
        title: title.trim() || clip.title,
        hook,
        caption,
        ...(tagsChanged ? { hashtags } : {}),
        startSec: range[0],
        endSec: range[1],
        ...(emphasisChanged ? { emphasis } : {}),
        ...(sectionsChanged ? { layoutSections: forcedSections, layoutOverride: null } : {}),
        ...(styleChanged && styleScope === "clip" ? { style: Object.keys(styleOverride).length ? styleOverride : null } : {}),
        rerender,
      });
      await qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: projectId }) });
      toast(rerender && needsRender ? (styleScope === "all" && styleChanged ? "Saved · re-rendering every clip" : "Saved · re-rendering") : "Saved");
      return true;
    } catch (err) {
      toast((err as Error).message);
      return false;
    }
  }
  const busy = update.isPending || updateStyle.isPending;
  const requestExit = () => (changed ? setGuard(true) : onExit());

  // warn on tab close with unsaved edits
  useEffect(() => {
    const on = (e: BeforeUnloadEvent) => {
      if (changed) e.preventDefault();
    };
    window.addEventListener("beforeunload", on);
    return () => window.removeEventListener("beforeunload", on);
  }, [changed]);

  // keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && (k === "z" || k === "y") && !el.closest("[data-native-undo]")) {
        e.preventDefault();
        if (k === "y" || e.shiftKey) history.redo();
        else history.undo();
        return;
      }
      if (mod && k === "s") {
        e.preventDefault();
        if (changed && !busy) void save(needsRender);
        return;
      }
      if (mod && (k === "b" || k === "k")) {
        e.preventDefault();
        splitAt(current);
        return;
      }
      if (el.closest("input:not([type=checkbox]):not([type=range]), textarea, select, [contenteditable]")) return;
      if (mod) return;
      if (e.key === "Escape") {
        if (keysOpen) setKeysOpen(false);
        return;
      }
      if (e.key === "?") setKeysOpen((o) => !o);
      else if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (k === "i") setIn(current);
      else if (k === "o") setOut(current);
      else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        videoRef.current?.pause();
        seek(current + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 1 : FRAME));
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected !== null && selected > 0) mergeSection(selected, "left");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ----- transcript (panel or tab) -----
  const txViewport = useRef<HTMLDivElement>(null);
  const txActive = useRef<HTMLSpanElement>(null);
  const txContent = useRef<HTMLDivElement>(null);
  const showTranscript = layout === "transcript" && !compact ? true : tab === "transcript";
  useEffect(() => {
    if (showTranscript && txViewport.current && txActive.current && playing) scrollWithin(txViewport.current, txActive.current, { block: "nearest", behavior: "auto" });
  }, [current, showTranscript, playing]);
  const txLines = useMemo(() => {
    const lo = range[0] - 40;
    const hi = range[1] + 40;
    return segments
      .filter((s) => s.end > lo && s.start < hi)
      .map((s) => ({ s, ws: rawWords.filter((w) => w.start >= s.start - 0.02 && w.start < s.end - 0.02) }));
  }, [segments, rawWords, range]);
  const readTxSelection = () => {
    const sel = window.getSelection();
    const el = txContent.current;
    if (!sel || sel.isCollapsed || !sel.rangeCount || !el) return setTxSel(null);
    const r = sel.getRangeAt(0);
    if (!el.contains(r.commonAncestorContainer)) return setTxSel(null);
    const spans = [...el.querySelectorAll<HTMLElement>("[data-s]")].filter((n) => r.intersectsNode(n));
    if (!spans.length) return setTxSel(null);
    setTxSel({ start: Math.min(...spans.map((n) => Number(n.dataset.s))), end: Math.max(...spans.map((n) => Number(n.dataset.e))) });
  };
  const transcript = (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1" viewportRef={txViewport}>
        <div ref={txContent} className="flex flex-col gap-3 px-4 py-3" onMouseUp={() => setTimeout(readTxSelection, 0)}>
          {txLines.length === 0 && <p className="text-ink3">No transcript around this clip.</p>}
          {txLines.map(({ s, ws }, i) => {
            const outside = s.end < range[0] || s.start > range[1];
            return (
              <div key={i} className={outside ? "opacity-55" : ""}>
                <button className="font-mono text-[11px] text-ink3 hover:text-ink" onClick={() => seek(s.start)}>
                  {formatTime(s.start)}
                </button>
                <p className="text-[14px] leading-[1.7]">
                  {ws.map((w, k) => {
                    const inside = w.start >= range[0] - 0.01 && w.end <= range[1] + 0.05;
                    const cur = current >= w.start && current < w.end + 0.06;
                    const cut = cutSpans.some((c) => w.start >= c.start - 0.02 && w.end <= c.end + 0.02);
                    return (
                      <span key={k}>
                        <span
                          ref={cur ? txActive : undefined}
                          data-s={w.start}
                          data-e={w.end}
                          onClick={() => !window.getSelection()?.toString() && seek(w.start)}
                          className={`cursor-pointer rounded-[3px] ${cur ? "bg-acc text-acc-ink" : inside ? "bg-acc-soft" : ""} ${cut ? "line-through decoration-ink3" : ""}`}
                        >
                          {w.text}
                        </span>{" "}
                      </span>
                    );
                  })}
                </p>
              </div>
            );
          })}
        </div>
      </ScrollArea>
      {txSel && (
        <div className="absolute inset-x-3 bottom-3 z-10 flex items-center gap-2 rounded-[12px] bg-ink px-3 py-2 text-xs text-bg shadow-pop">
          <span className="font-mono">{(txSel.end - txSel.start).toFixed(1)}s selected</span>
          <div className="flex-1" />
          <button
            className="rounded-[8px] bg-acc px-2.5 py-1 font-semibold text-acc-ink"
            onClick={() => {
              if (txSel.end - txSel.start < 3) return toast("Clips need at least 3s");
              window.getSelection()?.removeAllRanges();
              setRange([txSel.start - 0.1, txSel.end + 0.2]);
              seek(txSel.start);
              setTxSel(null);
              toast("Range set from transcript");
            }}
          >
            Set range
          </button>
          <button
            aria-label="Cancel"
            className="rounded-[8px] px-1.5 py-1 hover:bg-white/10"
            onClick={() => {
              window.getSelection()?.removeAllRanges();
              setTxSel(null);
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );

  // ----- inspector tabs -----
  const cropLayout = framing.layout !== "fit" && framing.layout !== "none";
  const curSec = sections[secIdx];
  const capWarn = safe && style.captions !== "none" ? safeZoneWarning(platform, style.captionX, style.captionY) : "";

  const captionsTab = (
    <div className="flex flex-col gap-5">
      {/* the follow-up action lives in the label row's reserved slot, so toggling never pushes the panel down */}
      <Field
        label="Apply style to"
        hint={
          styleScope === "all" ? (
            <span>re-renders every clip</span>
          ) : (
            <button
              className={`text-xs font-semibold text-acc-text ${Object.keys(styleOverride).length > 0 ? "" : "invisible"}`}
              aria-hidden={Object.keys(styleOverride).length === 0}
              tabIndex={Object.keys(styleOverride).length > 0 ? 0 : -1}
              onClick={() => edit({ style: projectStyle })}
            >
              Use the project style
            </button>
          )
        }
      >
        <Segmented
          value={styleScope}
          onChange={setStyleScope}
          options={[
            { value: "clip", label: "This clip" },
            { value: "all", label: `All ${clipCount} clips`, title: "Updates the project style and re-renders every clip" },
          ]}
        />
      </Field>
      <Field label="Look">
        <div className="grid grid-cols-4 gap-2">
          {(
            [
              ["karaoke", "Highlight"],
              ["box", "Boxed"],
              ["plain", "Outlined"],
              ["none", "Off"],
            ] as const
          ).map(([v, l]) => (
            <button
              key={v}
              onClick={() => setStyle({ captions: v })}
              className={`flex flex-col items-center gap-1 rounded-[10px] bg-panel px-1 py-2 text-xs ${style.captions === v ? "border-2 border-acc" : "border border-line"}`}
            >
              <span
                className="rounded-[5px] px-1.5 text-base font-extrabold"
                style={
                  v === "karaoke"
                    ? { color: "var(--acc-text)" }
                    : v === "box"
                      ? { background: "var(--acc)", color: "var(--acc-ink)" }
                      : v === "plain"
                        ? { color: "var(--panel)", WebkitTextStroke: "1.5px var(--ink)" }
                        : { color: "var(--ink3)", textDecoration: "line-through" }
                }
              >
                Aa
              </span>
              {l}
            </button>
          ))}
        </div>
      </Field>
      {style.captions !== "none" && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Size">
              <Segmented size="sm" value={SIZES.find((x) => Math.abs(x.v - style.captionSize) < 0.06)?.v ?? -1} onChange={(v) => setStyle({ captionSize: v })} options={SIZES.map((x) => ({ value: x.v, label: x.l }))} />
            </Field>
            <Field label="Words on screen" hint={<span className="font-mono">{style.wordsPerLine}</span>}>
              <input type="range" min={1} max={6} step={1} value={Math.min(6, style.wordsPerLine)} onChange={(e) => setStyle({ wordsPerLine: Number(e.target.value) }, "words")} className="accent-[var(--acc)]" />
            </Field>
          </div>
          {style.captions === "karaoke" || style.captions === "box" ? (
            <Field label="Highlight">
              <Swatches label="Highlight" colors={HL} value={style.highlightColor} onChange={(c) => setStyle({ highlightColor: c })} />
            </Field>
          ) : null}
          <Field label={<Switch checked={style.emphasis} onChange={(v) => setStyle({ emphasis: v })} label={<span className="text-xs font-semibold text-ink2">Key words</span>} />}>
            {style.emphasis && (
              <>
                <Swatches label="Key word" colors={KW} value={style.emphasisColor} onChange={(c) => setStyle({ emphasisColor: c })} />
                <div className="flex flex-wrap items-center gap-1.5 rounded-[10px] border border-line bg-panel p-1.5">
                  {emphasis.map((w, i) => (
                    <span key={w} className="inline-flex items-center gap-1 rounded-full bg-sunk py-0.5 pl-2.5 pr-1 text-xs font-semibold">
                      {w}
                      <button className="grid h-4 w-4 place-items-center rounded-full text-ink3 hover:bg-line hover:text-ink" aria-label={`Remove ${w}`} onClick={() => edit((d) => ({ emphasis: d.emphasis.filter((_, j) => j !== i) }))}>
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    className="min-w-[90px] flex-1 bg-transparent px-1 py-0.5 text-xs outline-none placeholder:text-ink3"
                    placeholder="Add key word…"
                    value={kwDraft}
                    onChange={(e) => setKwDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === ",") && kwDraft.trim()) {
                        e.preventDefault();
                        const w = kwDraft.trim().toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, "");
                        if (w && !emphasis.includes(w)) edit((d) => ({ emphasis: [...d.emphasis, w] }));
                        setKwDraft("");
                      } else if (e.key === "Backspace" && !kwDraft && emphasis.length) edit((d) => ({ emphasis: d.emphasis.slice(0, -1) }));
                    }}
                  />
                </div>
              </>
            )}
          </Field>
          <Switch checked={style.uppercase} onChange={(v) => setStyle({ uppercase: v })} label="Uppercase" />
          <div className="flex items-center justify-between gap-2 text-[13px]">
            <span>
              Caption position{" "}
              <span className="font-mono text-xs text-ink3">
                x {Math.round(style.captionX * 100)}% · y {Math.round(style.captionY * 100)}%
              </span>
            </span>
            <button className="btn-ghost px-2.5 py-1 text-xs" disabled={style.captionX === defaultStyle.captionX && style.captionY === defaultStyle.captionY} onClick={() => setStyle({ captionX: defaultStyle.captionX, captionY: defaultStyle.captionY })}>
              Reset
            </button>
          </div>
        </>
      )}
      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <Switch checked={style.showHook} onChange={(v) => setStyle({ showHook: v })} label="Hook text" />
        {style.showHook && (
          <>
            <Field label="Show for" hint={<span className="font-mono">{style.hookSeconds}s</span>}>
              <input type="range" min={1} max={10} step={0.5} value={style.hookSeconds} onChange={(e) => setStyle({ hookSeconds: Number(e.target.value) }, "hookdur")} className="accent-[var(--acc)]" />
            </Field>
            <div className="flex items-center justify-between gap-2 text-[13px]">
              <span>
                Hook position <span className="font-mono text-xs text-ink3">y {Math.round(style.hookY * 100)}%</span>
              </span>
              <button className="btn-ghost px-2.5 py-1 text-xs" disabled={style.hookX === defaultStyle.hookX && style.hookY === defaultStyle.hookY} onClick={() => setStyle({ hookX: defaultStyle.hookX, hookY: defaultStyle.hookY })}>
                Reset
              </button>
            </div>
          </>
        )}
        <p className="text-[11px] text-ink3">Drag the caption or hook on the preview to move them. They snap to the centre; hold Alt to place freely.</p>
      </div>
    </div>
  );

  const framingTab = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost text-xs" onClick={() => splitAt(current)}>
          Split at playhead <span className="font-mono text-ink3">{SPLIT_SHORTCUT}</span>
        </button>
        <button className="btn-ghost text-xs" disabled={selected === null || selected <= 0} onClick={() => selected !== null && mergeSection(selected, "left")}>
          Merge with previous
        </button>
        {(sections.length > 1 || sections[0]?.mode !== "auto" || sections[0]?.offsetX) && (
          <button className="btn-quiet text-xs" onClick={resetLayout}>
            Reset all to auto
          </button>
        )}
      </div>
      {sections.map((s, i) => {
        const chose = autoChoiceFor(s);
        const explain =
          s.mode === "auto"
            ? chose
              ? `Auto chose ${chose}${chose.includes("Two stacked") ? ": both speakers in frame" : chose === "Follow speaker" ? ": tracking whoever talks" : ""}.`
              : "Auto decides at render: follow the speaker, two stacked for two people, screen + speaker for a webcam over a screen, whole frame when nobody is on screen."
            : `${MODE_EXPLAIN[s.mode] ?? ""} ${chose ? `Auto would choose ${chose}.` : ""}`;
        return (
          <div
            key={i}
            onClick={() => {
              setSelected(i);
              if (current < s.start || current >= s.end) seek(s.start);
            }}
            className={`flex cursor-pointer flex-col gap-1.5 rounded-[12px] p-2.5 ${selected === i ? "border-2 border-acc" : "border border-line"}`}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-ink2">
                {fmtPrecise(s.start - range[0])}–{fmtPrecise(s.end - range[0])}
              </span>
              <select
                className="ml-auto rounded-[8px] border border-line bg-panel px-2 py-1 text-[13px] text-ink"
                value={s.mode}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setMode(i, e.target.value as SectionMode)}
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABEL[m]}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs leading-snug text-ink2">{explain}</p>
            {s.offsetX ? (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-ink3">Re-centred</span>
                <span className="font-mono">
                  {s.offsetX > 0 ? "+" : ""}
                  {Math.round(s.offsetX * 100)}%
                </span>
                <button
                  className="font-semibold text-acc-text"
                  onClick={(e) => {
                    e.stopPropagation();
                    resetOffset(i);
                  }}
                >
                  Reset
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
      <p className="text-[11px] leading-snug text-ink3">Drag the picture to re-centre the section under the playhead. On the timeline: drag a transition to move it, double-click to remove it, right-click for more.</p>
    </div>
  );

  const textTab = (
    <div className="flex flex-col gap-4">
      <Field label="Title" hint={`${title.length}/120`}>
        <input className="input" value={title} maxLength={120} onChange={(e) => edit({ title: e.target.value }, "title")} />
      </Field>
      <Field label="On-screen hook" hint={<span className={hookChanged ? "text-warn" : ""}>{hook.length}/80{hookChanged ? " · needs re-render" : ""}</span>}>
        <input className="input" value={hook} maxLength={80} onChange={(e) => edit({ hook: e.target.value }, "hook")} />
      </Field>
      <Field label="Post caption" hint={`${caption.length}/300 · no re-render needed`}>
        <textarea className="input resize-none" rows={4} value={caption} maxLength={300} onChange={(e) => edit({ caption: e.target.value }, "caption")} />
      </Field>
      <Field label="Hashtags" hint="no re-render needed">
        <div className="flex flex-wrap items-center gap-1.5 rounded-[10px] border border-line bg-panel p-1.5">
          {hashtags.map((h, i) => (
            <span key={`${h}${i}`} className="inline-flex items-center gap-1 rounded-full bg-acc-soft py-0.5 pl-2.5 pr-1 text-xs font-semibold text-acc-text">
              #{h}
              <button className="grid h-4 w-4 place-items-center rounded-full hover:bg-acc/20" aria-label={`Remove #${h}`} onClick={() => edit((d) => ({ hashtags: d.hashtags.filter((_, j) => j !== i) }))}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <input
            className="min-w-[90px] flex-1 bg-transparent px-1 py-0.5 text-xs outline-none placeholder:text-ink3"
            placeholder="#add"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === "," || e.key === " ") && tagDraft.trim()) {
                e.preventDefault();
                const t = tagDraft.trim().replace(/^#+/, "").replace(/[^\p{L}\p{N}_]+/gu, "");
                if (t && !hashtags.includes(t)) edit((d) => ({ hashtags: [...d.hashtags, t] }));
                setTagDraft("");
              } else if (e.key === "Backspace" && !tagDraft && hashtags.length) edit((d) => ({ hashtags: d.hashtags.slice(0, -1) }));
            }}
          />
        </div>
      </Field>
    </div>
  );

  const cuts = useMemo(() => {
    const skipped = clip.diagnostics?.cuts.skipped ?? [];
    return flags
      .filter((f) => f.kind === "disfluency" && f.start >= range[0] - 0.01 && f.end <= range[1] + 0.05)
      .sort((a, b) => a.start - b.start)
      .map((f) => {
        const applied = f.status === "auto" || f.status === "accepted";
        const refused = applied ? skipped.find((s) => Math.abs(s.start - f.start) < 0.35) : undefined;
        const label = refused ? "Kept in audio" : applied ? "Cut" : f.status === "pending" ? "Needs review" : "Kept";
        const tone = refused || f.status === "pending" ? "bg-warn-soft" : applied ? "bg-ok-soft" : "bg-sunk";
        const reason = refused
          ? "The removal couldn’t be verified, so the audio was kept. Captions still drop the word."
          : f.status === "pending"
            ? "Waiting for your call in the project transcript."
            : f.status === "rejected"
              ? "You kept it."
              : f.subkind === "manual" ? "You marked this to cut." : `${f.subkind === "repair" ? "False start" : f.subkind === "repetition" ? "Repeated word" : "Filler"} · ${Math.round(f.confidence * 100)}% confident.`;
        return { f, label, tone, reason, refused };
      });
  }, [flags, range, clip.diagnostics]);
  const nCut = cuts.filter((c) => c.label === "Cut").length;
  const nKept = cuts.filter((c) => c.refused).length;
  const pauses = clip.diagnostics?.pauses;
  const cutsTab = (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] leading-snug text-ink2">
        {cuts.length ? `${nCut} cut${nCut === 1 ? "" : "s"} applied${nKept ? `; ${nKept} kept because removal couldn’t be verified. Captions still drop the word.` : "."}` : "No disfluencies in this range."}
        {pauses?.cuts ? ` ${pauses.cuts} pause${pauses.cuts === 1 ? "" : "s"} shortened to ${pauses.maxPause}s (${pauses.removedSec.toFixed(1)}s removed).` : ""}
      </p>
      {cuts.map(({ f, label, tone, reason }) => (
        <div
          key={f.id}
          role="button"
          tabIndex={0}
          onClick={() => seek(Math.max(range[0], f.start - 1))}
          onKeyDown={(e) => e.key === "Enter" && seek(Math.max(range[0], f.start - 1))}
          className="flex cursor-pointer flex-col gap-1 rounded-[12px] border border-line p-2.5 text-left hover:bg-sunk"
        >
          <div className="flex items-center gap-2">
            <s className="text-[13px] font-semibold">{f.heard}</s>
            <span className="font-mono text-[11px] text-ink3">{fmtPrecise(f.start - range[0])}</span>
            <span className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{label}</span>
          </div>
          <span className="text-xs leading-snug text-ink2">{reason}</span>
          <a
            href={`/p/${projectId}#fix=${f.id}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="w-max text-xs font-semibold text-acc-text no-underline"
            title="Review this cut in the project transcript (new tab)"
          >
            Open in transcript ↗
          </a>
        </div>
      ))}
      <p className="text-[11px] text-ink3">Accept or reject cuts in the project transcript; they apply to every clip that contains them.</p>
    </div>
  );

  const tabs: Array<[Tab, string]> = [
    ["captions", "Captions"],
    ["framing", "Framing"],
    ["text", "Text"],
    ["cuts", "Cuts"],
  ];
  if (layout !== "transcript" || compact) tabs.push(["transcript", "Transcript"]);
  const activeTab: Tab = layout === "transcript" && !compact && tab === "transcript" ? "captions" : tab;

  const inspector = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 py-2">
        {tabs.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-[8px] px-3 py-[7px] text-[13px] font-semibold whitespace-nowrap ${activeTab === k ? "bg-sunk text-ink" : "text-ink2 hover:text-ink"}`}>
            {l}
          </button>
        ))}
      </div>
      {activeTab === "transcript" ? (
        transcript
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4">
            {activeTab === "captions" && captionsTab}
            {activeTab === "framing" && framingTab}
            {activeTab === "text" && textTab}
            {activeTab === "cuts" && cutsTab}
          </div>
        </ScrollArea>
      )}
    </div>
  );

  // ----- preview -----
  const frameTag = curSec ? (curSec.mode === "auto" ? `Auto → ${MODE_LABEL[framing.layout] ?? framing.layout}` : MODE_LABEL[curSec.mode]) : undefined;
  const len = range[1] - range[0];
  const tbtn = "grid h-[34px] min-w-[34px] place-items-center rounded-[10px] border border-line bg-panel px-2 text-[13px] text-ink hover:bg-sunk";
  const preview = (
    <div className={`flex min-h-0 min-w-0 flex-col items-center gap-2.5 px-4 pb-3 pt-3.5 ${compact ? "" : "flex-1"}`}>
      <div className={`relative flex w-full justify-center ${compact ? "h-[min(62vh,520px)]" : "min-h-0 flex-1"}`}>
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
          onPan={panSection}
          overlays={overlays}
          alwaysShowHook={activeTab === "captions" && !playing}
          onStyleChange={(p) => setStyle(p, "drag-text")}
          showSafeZones={safe}
          platform={platform}
          tag={frameTag}
        />
        {buffering && <div className="pointer-events-none absolute left-1/2 top-12 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white">Loading…</div>}
        {/* overlaid on the frame: a warning that pushed the transport down would move the buttons under the cursor */}
        {capWarn && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 w-[min(320px,90%)] -translate-x-1/2 rounded-[10px] bg-warn-soft/95 px-3 py-1.5 text-center text-xs text-ink shadow-pop">{capWarn}</div>
        )}
        <video ref={videoRef} src={sourceVideoUrl} preload="auto" playsInline className="pointer-events-none absolute h-px w-px opacity-0" />
      </div>
      <div className="flex w-full flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-ink2">
        <span className="flex items-center gap-1.5" title={cropLayout ? "Drag the picture to re-centre this section" : `Not adjustable in ${MODE_LABEL[framing.layout]}`}>
          Offset <span className="font-mono text-ink">{curSec?.offsetX ? `${curSec.offsetX > 0 ? "+" : ""}${Math.round(curSec.offsetX * 100)}%` : "0%"}</span>
          <button className="btn-ghost px-2 py-0.5 text-xs" disabled={!curSec?.offsetX} onClick={() => resetOffset(secIdx)}>
            Reset
          </button>
        </span>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={safe} onChange={(e) => setSafe(e.target.checked)} className="accent-[var(--acc)]" /> Safe zones
        </label>
        <select className="rounded-[8px] border border-line bg-panel px-2 py-1 text-xs text-ink" value={platform} onChange={(e) => setPlatform(e.target.value as Platform)} aria-label="Platform">
          {(Object.keys(PLATFORM_NAME) as Platform[]).map((k) => (
            <option key={k} value={k}>
              {PLATFORM_NAME[k]}
            </option>
          ))}
        </select>
        {overlays.length > 0 && (
          <span className="flex items-center gap-1.5 rounded-full bg-acc-soft px-2.5 py-1 text-ink" title="Text already in the video (captions, logos) is blurred so it doesn't clash with yours">
            <span className="font-mono text-[10px]">CC</span> Burned-in text blurred
            <button
              className="font-semibold text-acc-text disabled:opacity-50"
              disabled={setSourceText.isPending}
              onClick={() =>
                setSourceText
                  .mutateAsync({ id: projectId, sourceText: "keep" })
                  .then((r) => qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: projectId }) }).then(() => toast(`Source text kept · re-rendering ${r.rerendered} clip${r.rerendered === 1 ? "" : "s"}`)))
                  .catch((err) => toast((err as Error).message))
              }
              title="Show the source's own text in every clip of this project (re-renders them)"
            >
              Show it
            </button>
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <button className={tbtn} onClick={() => (videoRef.current?.pause(), seek(current - FRAME))} title="Previous frame (←)">
          ◀︎❙
        </button>
        <button className="grid h-[38px] w-[46px] place-items-center rounded-[12px] bg-ink text-bg" onClick={togglePlay} title="Play / pause (Space)" aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button className={tbtn} onClick={() => (videoRef.current?.pause(), seek(current + FRAME))} title="Next frame (→)">
          ❙▶︎
        </button>
        <span className="mx-2 font-mono text-xs text-ink2">
          {fmtPrecise(Math.max(0, current - range[0]))} / {fmtPrecise(len)}
        </span>
        <button className={tbtn} onClick={() => setIn(current)} title="Set in point at playhead (I)">
          [ In
        </button>
        <button className={tbtn} onClick={() => setOut(current)} title="Set out point at playhead (O)">
          Out ]
        </button>
      </div>
    </div>
  );

  const nudge = (which: "in" | "out", d: number) => (which === "in" ? setIn(range[0] + d) : setOut(range[1] + d));
  const nb = "rounded-[7px] border border-line bg-panel px-1.5 py-1 font-mono text-[11px] text-ink hover:bg-sunk";
  const trimTools = (
    <>
      {(["in", "out"] as const).map((k) => (
        <div key={k} className="flex items-center gap-1">
          <span className="w-7 text-xs font-semibold text-ink2">{k === "in" ? "In" : "Out"}</span>
          <button className={nb} onClick={() => nudge(k, -1)}>
            −1
          </button>
          <button className={nb} onClick={() => nudge(k, -0.1)}>
            −.1
          </button>
          <TimeField label={k === "in" ? "Clip start" : "Clip end"} value={k === "in" ? range[0] : range[1]} onCommit={(t) => (k === "in" ? setIn(t) : setOut(t))} />
          <button className={nb} onClick={() => nudge(k, 0.1)}>
            +.1
          </button>
          <button className={nb} onClick={() => nudge(k, 1)}>
            +1
          </button>
        </div>
      ))}
    </>
  );
  const timeline = (
    <Timeline
      sourceDuration={durationSec}
      range={range}
      onRange={setRange}
      current={current}
      onSeek={seek}
      words={rawWords.length ? rawWords : words}
      cuts={cutSpans}
      sceneCuts={sceneCuts}
      sections={sections}
      onSections={setSections}
      onSplit={splitAt}
      onSetMode={setMode}
      onMerge={mergeSection}
      onResetLayout={resetLayout}
      onResetOffset={resetOffset}
      onUndo={history.undo}
      onRedo={history.redo}
      canUndo={history.canUndo}
      canRedo={history.canRedo}
      selected={selected}
      onSelect={(i) => {
        setSelected(i);
        if (i !== null && tab === "transcript") setTab("framing");
      }}
      detected={clip.layoutSegments}
      toolbar={trimTools}
      compactHints={short || compact}
    />
  );

  // ----- header -----
  const rendering = clip.status === "rendering" || clip.status === "pending";
  let dirtyLabel: string;
  let dirtyCls: string;
  if (changed) {
    dirtyLabel = `${dirtyCount} unsaved${needsRender ? " · needs re-render" : ""}`;
    dirtyCls = "bg-warn-soft";
  } else if (rendering) {
    dirtyLabel = clip.status === "pending" ? "Queued to render" : `Rendering ${Math.round((renderProgress ?? 0) * 100)}%`;
    dirtyCls = "bg-acc-soft";
  } else if (clip.status === "failed") {
    dirtyLabel = "▲ Render failed";
    dirtyCls = "bg-err-soft";
  } else {
    dirtyLabel = clip.status === "done" ? "● Rendered" : "● Saved";
    dirtyCls = "bg-ok-soft";
  }
  const hb = "grid h-[34px] w-[34px] place-items-center rounded-[10px] border border-line bg-panel text-ink hover:bg-sunk disabled:cursor-not-allowed disabled:text-ink3 disabled:hover:bg-panel";
  const header = (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 sm:gap-3 sm:px-4">
      <button className="btn-quiet px-2" onClick={requestExit} title="Back to the project">
        <ArrowLeft className="h-4 w-4" /> <span className="hidden sm:inline">Project</span>
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] text-ink3">
          {projectTitle} · clip #{clip.index + 1}
        </div>
        <div className="truncate text-[15px] font-bold leading-tight">{title || "Untitled"}</div>
      </div>
      <button className={hb} disabled={!history.canUndo} onClick={history.undo} title={`Undo (${MOD}Z)`} aria-label="Undo">
        <Undo2 className="h-4 w-4" />
      </button>
      <button className={hb} disabled={!history.canRedo} onClick={history.redo} title={`Redo (${MOD}⇧Z)`} aria-label="Redo">
        <Redo2 className="h-4 w-4" />
      </button>
      <span className={`hidden whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold md:inline ${dirtyCls}`}>{dirtyLabel}</span>
      {!compact && (
        <button className={`${hb} ${layout === "transcript" ? "!border-acc !bg-acc-soft !text-acc-text" : ""}`} onClick={() => setLayout(layout === "transcript" ? "classic" : "transcript")} title={layout === "transcript" ? "Hide the transcript column" : "Show the transcript as a column"} aria-pressed={layout === "transcript"}>
          <PanelLeft className="h-4 w-4" />
        </button>
      )}
      <button
        className={`${hb} hidden sm:grid`}
        onClick={() =>
          navigator.clipboard
            .writeText(linkWith({ ...(tab !== "captions" ? { tab } : {}), ...(current > range[0] + 0.05 ? { t: fmtSec(current - range[0]) } : {}) }))
            .then(() => toast("Link copied"))
            .catch(() => toast("Couldn’t copy the link"))
        }
        title="Copy a link to this clip at the playhead"
        aria-label="Copy link"
      >
        <Link2 className="h-4 w-4" />
      </button>
      <button className={`${hb} hidden sm:grid`} onClick={() => setKeysOpen(true)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
        <Keyboard className="h-4 w-4" />
      </button>
      <ThemeToggle className="hidden sm:inline-flex" />
      <button
        className="btn-primary sm:min-w-[148px]"
        disabled={busy || (!changed && clip.status !== "failed")}
        onClick={() => void save(needsRender || (!changed && clip.status === "failed"))}
        title={needsRender ? `Saves and re-renders the clip (${MOD}S)` : `Saves; text-only edits don't need a re-render (${MOD}S)`}
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {!changed && clip.status === "failed" ? "Retry render" : needsRender ? (styleScope === "all" && styleChanged ? "Save & re-render all" : "Save & re-render") : "Save"}
      </button>
    </header>
  );

  const keyList: Array<[string, string]> = [
    ["Play / pause", "Space"],
    ["Previous / next frame", "← →"],
    ["Back / forward 1s", "⇧← ⇧→"],
    ["Set in / out at playhead", "I  O"],
    ["Split framing at playhead", `${MOD}B`],
    ["Remove selected transition", "Delete"],
    ["Undo / redo", `${MOD}Z  ⇧${MOD}Z`],
    ["Save", `${MOD}S`],
    ["Disable snapping while dragging", "hold Alt"],
    ["Zoom timeline", `${MOD} + scroll`],
    ["This sheet", "?"],
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      {compact ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col">
            {preview}
            <div className="border-y border-line bg-panel">{timeline}</div>
            <div className="flex h-[70vh] flex-col bg-panel">{inspector}</div>
          </div>
        </ScrollArea>
      ) : (
        <div
          className="grid min-h-0 flex-1"
          style={{ gridTemplateColumns: layout === "transcript" ? "320px minmax(0,1fr) 380px" : "minmax(0,1fr) 380px", gridTemplateRows: "minmax(0,1fr) auto" }}
        >
          {layout === "transcript" && (
            <div className="flex min-h-0 flex-col border-r border-line bg-panel">
              <div className="shrink-0 border-b border-line px-4 py-3 text-[13px] font-bold">Transcript</div>
              {transcript}
            </div>
          )}
          <div className="flex min-h-0 min-w-0 flex-col">{preview}</div>
          <div className="flex min-h-0 flex-col border-l border-line bg-panel">{inspector}</div>
          <div className="border-t border-line bg-panel" style={{ gridColumn: "1 / -1" }}>
            {timeline}
          </div>
        </div>
      )}

      <Modal open={guard} onOpenChange={setGuard} title="Unsaved changes">
        <p className="text-sm leading-relaxed text-ink2">
          You have {dirtyCount} unsaved change{dirtyCount === 1 ? "" : "s"} to this clip{needsRender ? ", and some need a re-render" : ""}.
        </p>
        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <button className="btn-ghost" onClick={() => setGuard(false)}>
            Keep editing
          </button>
          <button className="btn-danger" onClick={onExit}>
            Discard
          </button>
          <button
            className="btn-primary"
            disabled={busy}
            onClick={async () => {
              if (await save(needsRender)) onExit();
            }}
          >
            Save &amp; leave
          </button>
        </div>
      </Modal>
      <Modal open={keysOpen} onOpenChange={setKeysOpen} title="Keyboard shortcuts" width={460}>
        <div className="flex flex-col gap-2 text-[13px]">
          {keyList.map(([a, b]) => (
            <div key={a} className="flex items-center justify-between gap-4">
              <span className="text-ink2">{a}</span>
              <Kbd>{b}</Kbd>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
