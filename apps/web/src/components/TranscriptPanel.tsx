import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Popover from "@radix-ui/react-popover";
import { ArrowDown, Check, X, Sparkles, Play, Loader2, ListChecks, Trash2, Link2 } from "lucide-react";
import { useTRPC } from "../lib/trpc";
import { toast } from "sonner";
import { useLocation } from "react-router";
import { readHash, writeHash, linkWith } from "../lib/hash";
import { ScrollArea } from "./scroll-area";
import { scrollWithin, isVisibleWithin } from "../lib/scroll";
import type { Playback } from "../lib/playback";
import { cutState, cutStateLabel, cutStateTitle, type CutDiagnostics, type CutState } from "../lib/cutState";
import { formatTime, type TranscriptSegment, type TranscriptFlag, type Word } from "@reelsaw/shared";

interface Props {
  projectId: string;
  language: string | null;
  segments: TranscriptSegment[];
  /** as-heard words; the panel shows replacements/deletions inline on top of them */
  words: Word[];
  flags: TranscriptFlag[];
  currentTime: number;
  clips: Array<TranscriptClip>;
  /** click on a clip marker: focus that clip (card + source position) */
  onFocusClip?: (id: string) => void;
  /** open the clip's preview */
  onPlayClip?: (id: string) => void;
  activeClipId?: string | null;
  onSeek: (t: number) => void;
  /** soft-deleted fixes (restorable from the Deleted filter) */
  deletedFlags?: Array<TranscriptFlag & { deletedAt: string }>;
  /** shared playback: play-in-context loops a span through it, so Space and Play stay in sync */
  playback?: Playback;
  className?: string;
}

type Variant = "orig" | "cut";
export interface TranscriptClip {
  id?: string;
  index: number;
  startSec: number;
  endSec: number;
  title?: string;
  hook?: string;
  status?: string;
  score?: number;
  thumbnailUrl?: string | null;
  videoUrl?: string | null;
  /** what the last render did with this clip's cuts */
  diagnostics?: CutDiagnostics | null;
}
const cutKind = (f: TranscriptFlag) => (f.subkind === "manual" ? "your cut" : f.subkind === "repair" ? "false start" : (f.subkind ?? "filler"));
interface CutPlan {
  flagId: string;
  cut: { start: number; end: number };
  source: "render" | "search" | "timestamps";
  refused?: string;
}
interface PlanState {
  plan?: CutPlan;
  loading?: "plan" | "exact";
  error?: string;
}

type Decision = { status: "accepted" | "rejected"; replacement?: string };
const EPS = 0.02;

/**
 * Chat-style transcript: follows playback (auto-scrolls the active line into view) until the user
 * scrolls away, then shows a "resume" pill. Lines are rendered word by word so each name fix is an
 * inline highlight with a hover/click popover (accept, reject, or type a replacement).
 */
export function TranscriptPanel({ projectId, language, segments, words, flags, currentTime, clips, onSeek, playback, deletedFlags = [], onFocusClip, onPlayClip, activeClipId, className = "" }: Props) {
  // fix whose surrounding audio is on repeat (owned by the shared playback), how much context, and
  // which version (A/B for cuts)
  const looping = playback?.loop?.key ?? null;
  const loopPaused = !!playback?.loopPaused;
  const [ctxSec, setCtxSec] = useState(2);
  const [variant, setVariant] = useState<Variant>("orig");
  const [plans, setPlans] = useState<Record<string, PlanState>>({});
  const fetchPlan = async (f: TranscriptFlag, exact = false): Promise<CutPlan | undefined> => {
    setPlans((x) => ({ ...x, [f.id]: { ...x[f.id], loading: exact ? "exact" : "plan", error: undefined } }));
    try {
      const r = await fetch(`/api/projects/${projectId}/flags/${f.id}/cut-plan${exact ? "?exact=1" : ""}`, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      const plan = (await r.json()) as CutPlan;
      setPlans((x) => ({ ...x, [f.id]: { plan } }));
      return plan;
    } catch (err) {
      setPlans((x) => ({ ...x, [f.id]: { ...x[f.id], loading: undefined, error: (err as Error).message } }));
      return undefined;
    }
  };
  const startLoop = async (f: TranscriptFlag, pad = ctxSec, v: Variant = f.kind === "disfluency" ? variant : "orig", plan?: CutPlan) => {
    if (!playback) return;
    setPinnedFlag(f.id);
    setOpenFlag(f.id);
    const span = { key: f.id, start: Math.max(0, f.start - pad), end: f.end + pad };
    if (v === "orig") return playback.startLoop(span);
    // with the cut: the server renders the window with the seam, played on repeat instead of the video
    const pl = plan ?? plans[f.id]?.plan ?? (await fetchPlan(f));
    if (!pl) return;
    playback.startLoop({ ...span, src: `/api/projects/${projectId}/flags/${f.id}/preview.mp3?pad=${pad}&cutStart=${pl.cut.start}&cutEnd=${pl.cut.end}` });
  };
  const stopLoop = () => playback?.stopLoop();
  const toggleLoop = (f: TranscriptFlag) => (looping === f.id ? stopLoop() : void startLoop(f));
  const trpc = useTRPC();
  const qc = useQueryClient();
  const review = useMutation(trpc.transcripts.review.mutationOptions());
  const viewportRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const programmaticUntil = useRef(0);
  const justResumed = useRef(false);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [openFlag, setOpenFlag] = useState<string | null>(null);
  const [pinnedFlag, setPinnedFlag] = useState<string | null>(null);
  const flagRefs = useRef<Record<string, HTMLElement | null>>({});
  const [flagCursor, setFlagCursor] = useState(-1);
  const orderedFlags = useMemo(() => flags.slice().sort((a, b) => a.start - b.start), [flags]);

  // ----- select text → make a clip -----
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [pick, setPick] = useState<{ start: number; end: number; top: number; left: number } | null>(null);
  // correcting the selected words: the bar turns into a text field (selection kept while typing)
  const [fixText, setFixText] = useState<string | null>(null);
  const fixing = useRef(false);
  fixing.current = fixText !== null;
  useEffect(() => setFixText(null), [pick?.start, pick?.end]);
  const createClip = useMutation(trpc.clips.create.mutationOptions());
  const addCut = useMutation(trpc.transcripts.addCut.mutationOptions());
  const delFlag = useMutation(trpc.transcripts.deleteFlag.mutationOptions());
  async function deleteOne(f: TranscriptFlag) {
    try {
      const r = await delFlag.mutateAsync({ projectId, flagId: f.id });
      if (looping === f.id) stopLoop();
      setDecisions((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== f.id)));
      setPinnedFlag(null);
      setOpenFlag(null);
      await qc.invalidateQueries({ queryKey: trpc.transcripts.get.queryKey({ projectId }) });
      toast(`${f.subkind === "manual" ? "Cut" : "Fix"} deleted${r.rerendered ? ` · re-rendering ${r.rerendered} clip${r.rerendered === 1 ? "" : "s"}` : ""} · restore it from Deleted`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  const restore = useMutation(trpc.transcripts.restoreFlag.mutationOptions());
  async function restoreOne(id: string) {
    try {
      const r = await restore.mutateAsync({ projectId, flagId: id });
      await qc.invalidateQueries({ queryKey: trpc.transcripts.get.queryKey({ projectId }) });
      if (deletedFlags.length <= 1) setFilter("all");
      toast(`Restored${r.rerendered ? ` · re-rendering ${r.rerendered} clip${r.rerendered === 1 ? "" : "s"}` : ""}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  const addCorrection = useMutation(trpc.transcripts.addCorrection.mutationOptions());
  const selectedText = (p: { start: number; end: number }) =>
    words
      .filter((w) => w.start >= p.start - 0.02 && w.end <= p.end + 0.02)
      .map((w) => w.text)
      .join(" ");
  async function correctSelection() {
    if (!pick || fixText === null || !fixText.trim()) return;
    try {
      const r = await addCorrection.mutateAsync({ projectId, start: pick.start, end: pick.end, text: fixText.trim() });
      window.getSelection()?.removeAllRanges();
      setFixText(null);
      setPick(null);
      await qc.invalidateQueries({ queryKey: trpc.transcripts.get.queryKey({ projectId }) });
      toast(r.rerendered ? `Corrected · re-rendering ${r.rerendered} clip${r.rerendered === 1 ? "" : "s"}` : "Corrected");
    } catch {
      /* error shown in the bar */
    }
  }
  async function cutSelection() {
    if (!pick) return;
    try {
      const r = await addCut.mutateAsync({ projectId, start: pick.start, end: pick.end });
      window.getSelection()?.removeAllRanges();
      setPick(null);
      await qc.invalidateQueries({ queryKey: trpc.transcripts.get.queryKey({ projectId }) });
      toast(r.rerendered ? `Cut added · re-rendering ${r.rerendered} clip${r.rerendered === 1 ? "" : "s"}` : "Cut added");
    } catch {
      /* error shown in the bar */
    }
  }
  const readSelection = () => {
    const sel = window.getSelection();
    const content = contentRef.current;
    const root = rootRef.current;
    if (!sel || sel.isCollapsed || !sel.rangeCount || !content || !root) return setPick(null);
    const r = sel.getRangeAt(0);
    if (!content.contains(r.commonAncestorContainer)) return setPick(null);
    const els = [...content.querySelectorAll<HTMLElement>("[data-s]")].filter((el) => r.intersectsNode(el));
    if (!els.length) return setPick(null);
    const start = Math.min(...els.map((e) => Number(e.dataset.s)));
    const end = Math.max(...els.map((e) => Number(e.dataset.e)));
    // snap the visible highlight to whole words: what's highlighted is exactly what Make clip / Cut / Correct use
    const first = els.reduce((a, e) => (Number(e.dataset.s) < Number(a.dataset.s) ? e : a));
    const last = els.reduce((a, e) => (Number(e.dataset.e) > Number(a.dataset.e) ? e : a));
    const snapped = document.createRange();
    snapped.setStartBefore(first);
    snapped.setEndAfter(last);
    if (snapped.compareBoundaryPoints(Range.START_TO_START, r) !== 0 || snapped.compareBoundaryPoints(Range.END_TO_END, r) !== 0) {
      sel.removeAllRanges();
      sel.addRange(snapped);
    }
    const rect = snapped.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    const top = Math.min(box.height - 44, Math.max(40, rect.bottom - box.top + 6));
    const left = Math.max(150, Math.min(box.width - 150, rect.left - box.left + rect.width / 2));
    setFollowing(false); // don't scroll the selection away during playback
    setPick({ start, end, top, left });
  };
  useEffect(() => {
    const onChange = () => {
      const sel = window.getSelection();
      if ((!sel || sel.isCollapsed) && !fixing.current) setPick(null);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);
  // keep the bar attached to the selection while the transcript scrolls
  useEffect(() => {
    const v = viewportRef.current;
    if (!v || !pick) return;
    const onScroll = () => readSelection();
    v.addEventListener("scroll", onScroll, { passive: true });
    return () => v.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!pick]);
  async function makeClip(mode: "exact" | "ai") {
    if (!pick) return;
    // pad so the first/last word is not clipped
    const startSec = Math.max(0, pick.start - 0.15);
    const endSec = pick.end + 0.25;
    try {
      await createClip.mutateAsync({ projectId, startSec, endSec, mode });
      window.getSelection()?.removeAllRanges();
      setPick(null);
      await qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: projectId }) });
    } catch {
      /* error shown in the bar */
    }
  }

  // tokens per line: plain words, or one token per flag span (so a multi-word fix is one highlight)
  const lines = useMemo(() => {
    const byIndex = new Map<number, TranscriptFlag>();
    for (const f of flags) byIndex.set(f.wordIndex, f);
    let wi = 0;
    return segments.map((s) => {
      const ws: Array<{ w: Word; flag?: TranscriptFlag; heard?: string }> = [];
      while (wi < words.length && words[wi]!.start < s.end - EPS) {
        const w = words[wi]!;
        const f = byIndex.get(wi);
        if (f) {
          const span = words.slice(wi, wi + f.span);
          ws.push({ w: { text: span.map((x) => x.text).join(" "), start: w.start, end: span[span.length - 1]!.end }, flag: f });
          wi += f.span;
          continue;
        }
        if (w.end > s.start + EPS) ws.push({ w });
        wi++;
      }
      return { s, ws };
    });
  }, [segments, words, flags]);

  // which clip each line belongs to, and runs of consecutive lines in the same clip
  const clipOfLine = useMemo(() => lines.map(({ s }) => clips.find((c) => s.start < c.endSec - 0.3 && s.end > c.startSec + 0.3)), [lines, clips]);
  const clipGroups = useMemo(() => {
    const out: Array<{ clip: TranscriptClip | undefined; items: number[] }> = [];
    clipOfLine.forEach((c, i) => {
      const last = out.at(-1);
      if (last && last.clip === c) last.items.push(i);
      else out.push({ clip: c, items: [i] });
    });
    return out;
  }, [clipOfLine]);

  // auto-scroll the transcript viewport (never the page) while following
  useEffect(() => {
    const v = viewportRef.current;
    const a = activeRef.current;
    if (!following || !v || !a) return;
    if (isVisibleWithin(v, a, 0) && !justResumed.current) return;
    justResumed.current = false;
    programmaticUntil.current = Date.now() + 900;
    scrollWithin(v, a, { block: "center" });
  }, [Math.floor(currentTime * 2), following]);

  // any user-driven scroll turns following off
  useEffect(() => {
    const v = viewportRef.current;
    if (!v) return;
    const stop = () => setFollowing(false);
    const onScroll = () => {
      if (Date.now() < programmaticUntil.current) return;
      const a = activeRef.current;
      if (a && !isVisibleWithin(v, a)) setFollowing(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) stop();
    };
    v.addEventListener("wheel", stop, { passive: true });
    v.addEventListener("touchmove", stop, { passive: true });
    v.addEventListener("keydown", onKey);
    v.addEventListener("scroll", onScroll, { passive: true });
    const root = v.parentElement;
    const onBarDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest("[data-radix-scroll-area-scrollbar]")) stop();
    };
    root?.addEventListener("pointerdown", onBarDown);
    return () => {
      v.removeEventListener("wheel", stop);
      v.removeEventListener("touchmove", stop);
      v.removeEventListener("keydown", onKey);
      v.removeEventListener("scroll", onScroll);
      root?.removeEventListener("pointerdown", onBarDown);
    };
  }, []);

  function resume() {
    justResumed.current = true;
    setFollowing(true);
    const v = viewportRef.current;
    const a = activeRef.current;
    if (v && a) {
      programmaticUntil.current = Date.now() + 900;
      scrollWithin(v, a, { block: "center" });
    }
  }

  function jumpToFlag(i: number, tries = 0) {
    const f = orderedFlags[i];
    const v = viewportRef.current;
    if (!f || !v) return;
    // a flag hidden by the current filter has no anchor yet: show everything, retry after render
    if (!visibleFlag(f)) {
      setFilter("all");
      if (tries < 20) requestAnimationFrame(() => jumpToFlag(i, tries + 1));
      return;
    }
    const el = flagRefs.current[f.id];
    if (!el) {
      if (tries < 20) requestAnimationFrame(() => jumpToFlag(i, tries + 1));
      return;
    }
    setFollowing(false);
    setFlagCursor(i);
    programmaticUntil.current = Date.now() + 900;
    scrollWithin(v, el, { block: "center" });
    setPinnedFlag(f.id);
    setOpenFlag(f.id);
  }

  const pendingFlags = flags.filter((f) => f.status === "pending" && !decisions[f.id]);
  const dirty = Object.keys(decisions).length > 0;

  async function submit() {
    await review.mutateAsync({ projectId, decisions: Object.entries(decisions).map(([id, d]) => ({ id, status: d.status, replacement: d.replacement })), rerender: true });
    setDecisions({});
    setPinnedFlag(null);
    setOpenFlag(null);
    await qc.invalidateQueries({ queryKey: trpc.transcripts.get.queryKey({ projectId }) });
  }

  type Filter = "all" | "review" | "reviewed" | "entity" | "disfluency" | "deleted";
  const [filter, setFilter] = useState<Filter>("all");
  const isReviewed = (f: TranscriptFlag) => !!decisions[f.id] || f.status === "accepted" || f.status === "rejected";
  const visibleFlag = (f: TranscriptFlag) =>
    filter === "deleted" ? false : filter === "all" || (filter === "review" ? f.status === "pending" && !decisions[f.id] : filter === "reviewed" ? isReviewed(f) : f.kind === filter);
  const [listOpen, setListOpenRaw] = useState(() => {
    try {
      // phones start with the transcript itself; the pane would cover it
      return window.innerWidth >= 900 && localStorage.getItem("rs-fixes-pane") === "1";
    } catch {
      return false;
    }
  });
  const setListOpen = (o: boolean) => {
    setListOpenRaw(o);
    try {
      localStorage.setItem("rs-fixes-pane", o ? "1" : "0");
    } catch {
      /* private mode */
    }
  };
  const reviewedCount = flags.filter(isReviewed).length;
  const nextPending = () => {
    const isP = (f: TranscriptFlag) => f.status === "pending" && !decisions[f.id];
    const next = orderedFlags.findIndex((f, i) => i > flagCursor && isP(f));
    jumpToFlag(next >= 0 ? next : orderedFlags.findIndex(isP));
  };
  const decide = (id: string, d: Decision | null) => setDecisions((x) => (d ? { ...x, [id]: d } : Object.fromEntries(Object.entries(x).filter(([key]) => key !== id))));
  // N next fix · A accept · R reject · ↑/↓ previous/next while a fix is pinned
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || el.closest("input, textarea, select, [contenteditable]")) return;
      const k = e.key.toLowerCase();
      if (k === "n" && orderedFlags.length) {
        e.preventDefault();
        nextPending();
        return;
      }
      const cur = pinnedFlag ? orderedFlags.find((f) => f.id === pinnedFlag) : undefined;
      if (!cur) return;
      if (k === "a") decide(cur.id, { status: "accepted" });
      else if (k === "p" && playback) toggleLoop(cur);
      else if (k === "r") decide(cur.id, { status: "rejected" });
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const i = orderedFlags.indexOf(cur);
        jumpToFlag((i + (e.key === "ArrowDown" ? 1 : -1) + orderedFlags.length) % orderedFlags.length);
      } else if (e.key === "Escape") onPinClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    if (looping && openFlag !== looping) stopLoop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFlag]);
  useEffect(() => () => playback?.stopLoop(), []); // eslint-disable-line react-hooks/exhaustive-deps
  // ----- deep links: #fix=<id> pins a fix, #sel=<start>-<end> selects a range (both kept in sync) -----
  const hydrated = useRef(false);
  const copyLink = (params: Record<string, string>) =>
    navigator.clipboard
      .writeText(linkWith(params))
      .then(() => toast("Link copied"))
      .catch(() => toast.error("Couldn’t copy the link"));
  const selectRange = (a: number, b: number, tries = 0) => {
    const v = viewportRef.current;
    const content = contentRef.current;
    const spans = content ? [...content.querySelectorAll<HTMLElement>("[data-s]")].filter((el) => Number(el.dataset.s) >= a - 0.02 && Number(el.dataset.e) <= b + 0.02) : [];
    if (!v || !spans.length) {
      if (tries < 20) requestAnimationFrame(() => selectRange(a, b, tries + 1));
      return;
    }
    setFollowing(false);
    programmaticUntil.current = Date.now() + 900;
    scrollWithin(v, spans[0]!, { block: "center", behavior: "auto" });
    const r = document.createRange();
    r.setStartBefore(spans[0]!);
    r.setEndAfter(spans.at(-1)!);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    requestAnimationFrame(readSelection);
  };
  const applyHash = () => {
    const h = readHash();
    const fix = h.get("fix");
    const range = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(h.get("sel") ?? "");
    if (fix) {
      window.getSelection()?.removeAllRanges();
      setPick(null);
      const i = orderedFlags.findIndex((f) => f.id === fix);
      if (i >= 0) jumpToFlag(i);
      else if (deletedFlags.some((d) => d.id === fix)) {
        setFilter("deleted");
        setListOpen(true);
      }
    } else if (range) {
      // a pinned popover would swallow the new selection: close it first
      setPinnedFlag(null);
      setOpenFlag(null);
      requestAnimationFrame(() => selectRange(Number(range[1]), Number(range[2])));
    }
  };
  useEffect(() => {
    if (hydrated.current || !segments.length) return;
    hydrated.current = true;
    applyHash();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments.length]);
  // later hash changes (a pasted link, back/forward) re-apply; our own replaceState writes don't reach the router
  const { hash: routeHash } = useLocation();
  const lastHash = useRef(routeHash);
  useEffect(() => {
    if (!hydrated.current || routeHash === lastHash.current) return;
    lastHash.current = routeHash;
    applyHash();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeHash]);
  useEffect(() => {
    if (hydrated.current) writeHash({ fix: pinnedFlag, ...(pinnedFlag ? { sel: null } : {}) });
  }, [pinnedFlag]);
  useEffect(() => {
    if (hydrated.current) writeHash({ sel: pick ? `${pick.start.toFixed(2)}-${pick.end.toFixed(2)}` : null });
  }, [pick?.start, pick?.end]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPinClose = () => {
    setPinnedFlag(null);
    setOpenFlag(null);
  };
  const nDecided = Object.keys(decisions).length;
  const affected = useMemo(() => {
    const ids = new Set(Object.keys(decisions));
    const hit = new Set<number>();
    for (const f of flags) if (ids.has(f.id)) for (const c of clips) if (f.start < c.endSec && f.end > c.startSec) hit.add(c.index + 1);
    return [...hit].sort((a, b) => a - b);
  }, [decisions, flags, clips]);
  const filterBtn = (v: Filter, label: string) => (
    <button
      key={v}
      role="radio"
      aria-checked={filter === v}
      onClick={() => {
        setFilter(v);
        if (!listOpen) setListOpen(true); // the chips filter the list: show it
      }}
      className={`rounded-full border px-2.5 py-[3px] text-xs font-semibold whitespace-nowrap ${filter === v ? "border-ink bg-ink text-bg" : "border-line text-ink2 hover:text-ink"}`}
    >
      {label}
    </button>
  );

  return (
    <div ref={rootRef} className={`relative flex min-h-0 flex-col ${className}`}>
      {/* one scrollable row on phones, wraps on wider screens */}
      <div className="flex shrink-0 items-center gap-x-3 gap-y-2 overflow-x-auto border-y border-line bg-panel px-4 py-2.5 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible sm:px-5">
        <h2 className="shrink-0 text-[15px] font-bold">Transcript</h2>
        {language && <span className="font-mono text-[11px] text-ink3">{language}</span>}
        {orderedFlags.length > 0 && (
          <div className="flex shrink-0 items-center gap-1.5 sm:flex-wrap">
            <span className={`chip ${pendingFlags.length ? "bg-warn-soft" : "bg-ok-soft"} text-ink`}>
              <span className="font-mono">{pendingFlags.length ? "?" : "✓"}</span> {pendingFlags.length ? `${pendingFlags.length} to review` : "All reviewed"}
            </span>
            <button data-flag-nav className="btn-ghost px-2.5 py-1 text-xs" disabled={!pendingFlags.length} onClick={nextPending} title="Next fix to review (N). Then A accept, R reject, ↑ ↓ move">
              Next fix <span className="kbd">N</span>
            </button>
          </div>
        )}
        <div className="flex-1" />
        {orderedFlags.length > 0 && (
          // filters sit beside the list they filter (they also narrow the highlights in the text)
          <div role="radiogroup" aria-label="Which fixes to show" className="flex shrink-0 gap-1">
            {filterBtn("all", `All ${orderedFlags.length}`)}
            {filterBtn("review", `To review ${pendingFlags.length}`)}
            {filterBtn("reviewed", `Reviewed ${reviewedCount}`)}
            {filterBtn("entity", "Names")}
            {filterBtn("disfluency", "Cuts")}
            {deletedFlags.length > 0 && filterBtn("deleted", `Deleted ${deletedFlags.length}`)}
          </div>
        )}
        {orderedFlags.length > 0 && (
          <button
            className={`btn shrink-0 px-2.5 py-1 text-xs ${listOpen ? "bg-ink font-semibold text-bg" : "border border-line bg-panel text-ink hover:bg-sunk"}`}
            onClick={() => setListOpen(!listOpen)}
            aria-pressed={listOpen}
            title="List every fix, reviewed or not"
          >
            <ListChecks className="h-3.5 w-3.5" /> Fixes list
          </button>
        )}
        <div className="hidden flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink2 xl:flex">
          <span><b className="font-mono text-[10px] text-acc-text">Aa</b> name fix</span>
          <span><b className="font-mono text-[10px]">✂</b> cut</span>
          <span><b className="font-mono text-[10px] text-warn">?</b> review</span>
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1">
      <ScrollArea className="min-h-0 min-w-0 flex-1" viewportRef={viewportRef}>
        <div ref={contentRef} className="mx-auto max-w-[760px] px-5 pb-28 pt-4" onMouseUp={() => setTimeout(readSelection, 0)} onTouchEnd={() => setTimeout(readSelection, 50)} onKeyUp={readSelection}>
          {segments.length === 0 && <p className="py-10 text-center text-ink3">The transcript appears here after transcription.</p>}
          {clipGroups.map((g) => (
            // a clip's lines share one bracket down the margin, labelled once; the label sticks while scrolling through it
            <div key={g.items[0]} className="grid grid-cols-[24px_minmax(0,1fr)] gap-1">
              <div className="relative">
                {g.clip && (
                  <>
                    <div className={`absolute bottom-2 left-[11px] top-3 w-0.5 rounded-full ${activeClipId && g.clip.id === activeClipId ? "bg-acc" : "bg-acc/40"}`} />
                    <div className="sticky top-2 z-[5] pt-2">
                      <ClipMarker clip={g.clip} projectId={projectId} active={!!activeClipId && g.clip.id === activeClipId} onFocus={onFocusClip} onPlay={onPlayClip} />
                    </div>
                  </>
                )}
              </div>
              <div className="min-w-0">
                {g.items.map((i) => {
            const { s, ws } = lines[i]!;
            const isActive = currentTime >= s.start && currentTime < s.end;
            const inClip = clipOfLine[i];
            const marks = ws.filter((x) => x.flag && visibleFlag(x.flag));
            return (
              <div
                key={i}
                ref={isActive ? activeRef : undefined}
                className={`-mx-3 grid grid-cols-[30px_minmax(0,1fr)] gap-2.5 rounded-[12px] px-3 py-2 ${isActive ? "bg-panel shadow-[0_0_0_1px_var(--line)]" : ""}`}
              >
                <div className="flex flex-col items-center gap-1 pt-0.5">
                  {marks.slice(0, 3).map(({ flag }) => (
                    <span key={flag!.id} className={`grid h-5 w-5 place-items-center rounded-[6px] font-mono text-[10px] font-semibold ${flag!.kind === "entity" ? "bg-acc-soft text-acc-text" : "bg-sunk text-ink"}`}>
                      {flag!.kind === "entity" ? "Aa" : "✂"}
                    </span>
                  ))}
                </div>
                <div className="min-w-0">
                  <button className="select-none font-mono text-[11px] text-ink3 hover:text-ink" onClick={() => onSeek(s.start)} title="Seek here">
                    {formatTime(s.start)}
                  </button>
                  <p className="text-base leading-[1.7] [text-wrap:pretty]">
                    {ws.length === 0 && (
                      <span data-s={s.start} data-e={s.end} onClick={() => onSeek(s.start)}>
                        {s.text}
                      </span>
                    )}
                    {ws.map(({ w, flag }, k) => {
                      const spoken = currentTime >= w.start && currentTime < w.end;
                      const inside = inClip && w.start >= inClip.startSec - 0.02 && w.end <= inClip.endSec + 0.05;
                      if (!flag || !visibleFlag(flag)) {
                        return (
                          <span key={k}>
                            <span
                              data-s={w.start}
                              data-e={w.end}
                              onClick={() => !window.getSelection()?.toString() && onSeek(w.start)}
                              className={`cursor-pointer rounded-[3px] ${spoken ? "bg-acc text-acc-ink" : inside ? "bg-acc-soft/70" : "hover:bg-sunk"}`}
                            >
                              {flag && (flag.status === "auto" || flag.status === "accepted") && flag.kind === "entity" ? (flag.replacement ?? flag.suggested) : w.text}
                            </span>{" "}
                          </span>
                        );
                      }
                      return (
                        <FlagWord
                          key={k}
                          word={w}
                          flag={flag}
                          decision={decisions[flag.id]}
                          open={openFlag === flag.id}
                          pinned={pinnedFlag === flag.id}
                          highlighted={orderedFlags[flagCursor]?.id === flag.id}
                          rendered={flag.kind === "disfluency" ? cutState(flag, clips) : null}
                          where={`${formatTime(flag.start)}${clips.filter((c) => flag.start < c.endSec && flag.end > c.startSec).map((c) => ` · in clip ${c.index + 1}`).join("")}`}
                          position={`${orderedFlags.indexOf(flag) + 1} of ${orderedFlags.length}`}
                          anchorRef={(el) => {
                            flagRefs.current[flag.id] = el;
                          }}
                          onOpenChange={(o) => {
                            if (o) setOpenFlag(flag.id);
                            else if (pinnedFlag !== flag.id) setOpenFlag((cur) => (cur === flag.id ? null : cur));
                          }}
                          onPin={(p) => {
                            setPinnedFlag(p ? flag.id : null);
                            setOpenFlag(p ? flag.id : null);
                            if (p) setFlagCursor(orderedFlags.indexOf(flag));
                          }}
                          onDecide={(d) => decide(flag.id, d)}
                          onDelete={() => void deleteOne(flag)}
                          deleting={delFlag.isPending}
                          onCopyLink={() => copyLink({ fix: flag.id })}
                          loop={
                            playback
                              ? {
                                  on: looping === flag.id,
                                  paused: looping === flag.id && loopPaused,
                                  sec: ctxSec,
                                  toggle: () => toggleLoop(flag),
                                  setSec: (n) => {
                                    setCtxSec(n);
                                    if (looping === flag.id) void startLoop(flag, n);
                                  },
                                  ab:
                                    flag.kind === "disfluency"
                                      ? {
                                          variant,
                                          setVariant: (v) => {
                                            setVariant(v);
                                            void startLoop(flag, ctxSec, v);
                                          },
                                          plan: plans[flag.id],
                                          loadPlan: () => void (plans[flag.id]?.plan || plans[flag.id]?.loading ? undefined : fetchPlan(flag)),
                                          findExact: async () => {
                                            const pl = await fetchPlan(flag, true);
                                            if (pl && looping === flag.id && variant === "cut") void startLoop(flag, ctxSec, "cut", pl);
                                          },
                                        }
                                      : undefined,
                                }
                              : undefined
                          }
                        />
                      );
                    })}
                  </p>
                </div>
              </div>
            );
                })}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
      {listOpen && orderedFlags.length > 0 && (
        <aside className="absolute inset-y-0 right-0 z-20 flex w-full flex-col sm:w-[340px] border-l border-line bg-panel shadow-pop xl:static xl:shadow-none">
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <b className="text-[13px]">Fixes</b>
            <span className="text-xs text-ink3">{filter === "deleted" ? deletedFlags.length : orderedFlags.filter(visibleFlag).length} shown</span>
            <button className="ml-auto text-ink2 hover:text-ink" onClick={() => setListOpen(false)} aria-label="Close fixes list">
              <X className="h-4 w-4" />
            </button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <ol className="flex flex-col gap-0.5 p-1.5">
              {filter === "deleted" &&
                [...deletedFlags].reverse().map((f) => (
                  <li key={f.id} className="grid grid-cols-[26px_1fr_auto] items-center gap-2 rounded-[10px] px-2 py-1.5">
                    <span className={`grid h-[26px] w-[26px] place-items-center rounded-[7px] font-mono text-[11px] font-semibold opacity-60 ${f.kind === "disfluency" ? "bg-sunk" : "bg-acc-soft text-acc-text"}`}>{f.kind === "disfluency" ? "✂" : "Aa"}</span>
                    <button className="min-w-0 text-left" onClick={() => onSeek(f.start)} title="Seek here">
                      <span className="block truncate text-[13px] text-ink2">{f.kind === "disfluency" ? `“${f.heard}”` : `${f.heard} → ${f.replacement ?? f.suggested}`}</span>
                      <span className="block text-[11px] text-ink3">
                        <span className="font-mono">{formatTime(f.start)}</span> · {f.kind === "disfluency" ? cutKind(f) : f.subkind === "manual" ? "your correction" : "name fix"} · deleted {new Date(f.deletedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                      </span>
                    </button>
                    <button className="btn-ghost px-2.5 py-1 text-xs" disabled={restore.isPending} onClick={() => void restoreOne(f.id)}>
                      Restore
                    </button>
                  </li>
                ))}
              {orderedFlags.map((f, i) => {
                if (!visibleFlag(f)) return null;
                const d = decisions[f.id] as Decision | undefined;
                const st = f.status;
                const isCut = f.kind === "disfluency";
                const rep = d?.replacement ?? f.replacement ?? f.suggested;
                const rendered = isCut && (st === "auto" || st === "accepted") ? cutState(f, clips) : null;
                const [label, tone] = d
                  ? [`Staged: ${d.status === "accepted" ? "accept" : "reject"}`, "bg-acc-soft"]
                  : st === "pending"
                    ? ["Needs review", "bg-warn-soft"]
                    : st === "auto"
                      ? ["Auto-applied", "bg-ok-soft"]
                      : st === "accepted"
                        ? ["Accepted", "bg-ok-soft"]
                        : ["Rejected", "bg-sunk"];
                return (
                  <li key={f.id}>
                    <button
                      data-flag-nav
                      onClick={() => jumpToFlag(i)}
                      className={`grid w-full grid-cols-[26px_1fr_auto] items-center gap-2 rounded-[10px] px-2 py-1.5 text-left hover:bg-sunk ${pinnedFlag === f.id ? "bg-sunk" : ""}`}
                    >
                      <span className={`grid h-[26px] w-[26px] place-items-center rounded-[7px] font-mono text-[11px] font-semibold ${isCut ? "bg-sunk" : "bg-acc-soft text-acc-text"}`}>{isCut ? "✂" : "Aa"}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13px]">
                          {isCut ? (
                            <>“<s>{f.heard}</s>”</>
                          ) : (
                            <>
                              <s className="text-ink3">{f.heard}</s> → {rep}
                            </>
                          )}
                        </span>
                        <span className="block text-[11px] text-ink3">
                          <span className="font-mono">{formatTime(f.start)}</span> · {isCut ? cutKind(f) : f.subkind === "manual" ? "your correction" : "name fix"} · {Math.round(f.confidence * 100)}%
                          {rendered && (
                            <span className={rendered.state === "applied" ? "" : "font-semibold text-warn"} title={cutStateTitle(rendered)}>
                              {" "}· {rendered.state === "applied" ? "cut in render" : rendered.state === "unverified" ? "▲ cut unverified" : "▲ kept in audio"}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-ink ${tone}`}>{label}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </ScrollArea>
        </aside>
      )}
      </div>
      {pick && (
        <div
          className="absolute z-30 w-max max-w-[calc(100%-12px)] -translate-x-1/2 rounded-[12px] bg-ink p-1 text-xs text-bg shadow-pop"
          style={{ top: pick.top, left: pick.left }}
          onMouseDown={(e) => !(e.target as HTMLElement).closest("input") && e.preventDefault()}
        >
          {fixText !== null ? (
            <div className="flex items-center gap-1">
              <span className="pl-2 pr-1 text-[11px] opacity-70">Should read</span>
              <input
                autoFocus
                aria-label="Corrected text"
                className="w-[min(360px,60vw)] rounded-[8px] bg-white/10 px-2 py-1.5 text-[13px] text-bg outline-none placeholder:text-bg/50 focus:bg-white/15"
                value={fixText}
                onChange={(e) => setFixText(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") void correctSelection();
                  if (e.key === "Escape") setFixText(null);
                }}
              />
              <button className="rounded-[8px] bg-acc px-2.5 py-1.5 font-semibold text-acc-ink disabled:opacity-40" disabled={addCorrection.isPending || !fixText.trim()} onClick={() => void correctSelection()}>
                {addCorrection.isPending ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> : null} Save
              </button>
              <button className="rounded-[8px] px-2 py-1.5 hover:bg-white/10" onClick={() => setFixText(null)} aria-label="Cancel correction">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
          <div className="flex items-center gap-1 whitespace-nowrap">
            <span className="px-2 font-mono">{(pick.end - pick.start).toFixed(1)}s</span>
            <button className="rounded-[8px] px-2 py-1.5 hover:bg-white/10" onClick={() => onSeek(pick.start)} aria-label="Play selection" title="Play from the start of the selection">
              <Play className="h-3.5 w-3.5" />
            </button>
            <button className="rounded-[8px] bg-acc px-2.5 py-1.5 font-semibold text-acc-ink disabled:opacity-40" disabled={createClip.isPending || pick.end - pick.start < 3} onClick={() => makeClip("exact")} title={pick.end - pick.start < 3 ? "Select at least 3s" : "Clip exactly this range; the AI writes the title, hook and caption"}>
              {createClip.isPending ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> : null} Make clip
            </button>
            <button className="rounded-[8px] px-2.5 py-1.5 font-semibold hover:bg-white/10 disabled:opacity-40" disabled={createClip.isPending || pick.end - pick.start < 8} onClick={() => makeClip("ai")} title={pick.end - pick.start < 8 ? "Select at least 8s for an AI pick" : "Let the AI find the best standalone clip inside this selection"}>
              <Sparkles className="inline h-3.5 w-3.5" /> AI pick
            </button>
            <span className="mx-0.5 h-4 w-px bg-white/20" />
            <button className="rounded-[8px] px-2.5 py-1.5 font-semibold hover:bg-white/10" onClick={() => setFixText(selectedText(pick))} title="Fix mistranscribed words: captions use your text">
              ✎ Correct
            </button>
            <button
              className="rounded-[8px] px-2.5 py-1.5 font-semibold hover:bg-white/10 disabled:opacity-40"
              disabled={addCut.isPending}
              onClick={cutSelection}
              title="Remove these words from the video and captions of every clip that contains them"
            >
              {addCut.isPending ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> : "✂"} Cut
            </button>
            <button className="rounded-[8px] px-2 py-1.5 hover:bg-white/10" onClick={() => copyLink({ sel: `${pick.start.toFixed(2)}-${pick.end.toFixed(2)}` })} aria-label="Copy link to this selection" title="Copy link to this selection">
              <Link2 className="h-3.5 w-3.5" />
            </button>
            <button
              className="rounded-[8px] px-2 py-1.5 hover:bg-white/10"
              onClick={() => {
                window.getSelection()?.removeAllRanges();
                setPick(null);
              }}
              aria-label="Cancel"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          )}
          {pick.end - pick.start < 8 && <p className="px-2 pb-1 pt-0.5 text-[11px] opacity-70">{pick.end - pick.start < 3 ? "Clips need at least 3s; any length can be cut." : "AI pick needs at least 8s."}</p>}
          {createClip.error && <p className="whitespace-normal px-2 pb-1 text-err">{createClip.error.message}</p>}
          {addCorrection.error && <p className="max-w-[420px] whitespace-normal px-2 pb-1 text-err">{addCorrection.error.message}</p>}
          {addCut.error && <p className="max-w-[420px] whitespace-normal px-2 pb-1 text-err">{addCut.error.message}</p>}
        </div>
      )}
      {!following && segments.length > 0 && (
        <button className="absolute left-1/2 top-[58px] z-20 -translate-x-1/2 rounded-full bg-ink px-3 py-1.5 text-xs font-semibold text-bg shadow-pop" onClick={resume}>
          <ArrowDown className="mr-1 inline h-3 w-3" /> Resume following · {formatTime(currentTime)}
        </button>
      )}
      {nDecided > 0 && (
        <div className="absolute inset-x-4 bottom-4 z-20 mx-auto flex max-w-[640px] flex-wrap items-center gap-3 rounded-[14px] border border-line bg-panel px-4 py-3 shadow-pop">
          <div className="min-w-0 flex-1 text-[13px]">
            <b>{nDecided} staged</b>{" "}
            <span className="text-ink2">· {affected.length ? `re-renders clip${affected.length === 1 ? "" : "s"} ${affected.join(", ")}` : "no clips affected"}</span>
          </div>
          <button className="btn-ghost" onClick={() => setDecisions({})}>
            Discard
          </button>
          <button className="btn-primary" disabled={review.isPending} onClick={submit}>
            {review.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Apply {nDecided} {affected.length ? "& re-render" : ""}
          </button>
        </div>
      )}
    </div>
  );
}

function FlagWord({
  word,
  flag,
  decision,
  rendered,
  open,
  pinned,
  highlighted,
  where,
  position,
  anchorRef,
  onOpenChange,
  onPin,
  onDecide,
  loop,
  onDelete,
  deleting,
  onCopyLink,
}: {
  onDelete?: () => void;
  deleting?: boolean;
  onCopyLink?: () => void;
  loop?: { on: boolean; paused: boolean; sec: number; toggle: () => void; setSec: (n: number) => void; ab?: { variant: Variant; setVariant: (v: Variant) => void; plan?: PlanState; loadPlan: () => void; findExact: () => void } };
  word: Word;
  flag: TranscriptFlag;
  decision?: Decision;
  /** what the last render did with this cut (disfluencies only) */
  rendered?: CutState | null;
  open: boolean;
  pinned: boolean;
  highlighted: boolean;
  where: string;
  position: string;
  anchorRef: (el: HTMLElement | null) => void;
  onOpenChange: (open: boolean) => void;
  onPin: (pinned: boolean) => void;
  onDecide: (d: Decision | null) => void;
}) {
  const status = decision?.status ?? flag.status;
  const applied = status === "auto" || status === "accepted";
  const shown = decision?.replacement ?? flag.replacement ?? flag.suggested;
  const [text, setText] = useState(shown);
  const closeTimer = useRef<number | undefined>(undefined);
  const pct = Math.round(flag.confidence * 100);
  const isDeletion = flag.kind === "disfluency";
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => {
    if (!open) setConfirmDel(false);
  }, [open]);

  const hoverOpen = () => {
    window.clearTimeout(closeTimer.current);
    onOpenChange(true);
  };
  const hoverClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => onOpenChange(false), 180);
  };
  const accept = () => {
    const t = text.trim();
    if (!t && !isDeletion) return;
    onDecide({ status: "accepted", replacement: t === flag.suggested ? undefined : t });
  };

  const pending = status === "pending";
  const glyph = (isDeletion ? "✂" : "Aa") + (pending ? "?" : status === "rejected" ? "✕" : status === "accepted" ? "✓" : "");
  const stateLabel = status === "auto" ? "Auto-applied" : pending ? "Needs review" : status === "accepted" ? "Accepted" : "Rejected";
  const stateTone = pending ? "bg-warn-soft" : applied ? "bg-ok-soft" : "bg-sunk";
  // the chip shapes from the component spec: dotted = auto, solid = accepted, dashed box = review, grey dotted = rejected
  let cls = "";
  if (pending) cls = "rounded-[5px] bg-warn-soft px-1 outline-[1.5px] outline-dashed -outline-offset-1 outline-warn";
  else if (isDeletion) cls = applied ? "line-through text-ink3" : "border-b-2 border-dotted border-line2";
  else cls = applied ? `border-b-2 ${status === "auto" ? "border-dotted" : "border-solid"} border-acc` : "border-b-2 border-dotted border-line2";
  const display = isDeletion || !applied ? word.text : shown;

  return (
    <Popover.Root open={open} onOpenChange={(o) => (o ? onOpenChange(true) : onPin(false))}>
      <Popover.Trigger asChild>
        <span
          ref={anchorRef}
          role="button"
          tabIndex={0}
          aria-label={`${isDeletion ? "Filler cut" : "Name fix"}, ${stateLabel}`}
          data-s={word.start}
          data-e={word.end}
          onMouseEnter={hoverOpen}
          onMouseLeave={hoverClose}
          onClick={(e) => {
            e.preventDefault();
            onPin(!pinned);
          }}
          className={`cursor-pointer ${cls} ${highlighted || pinned ? "ring-2 ring-acc ring-offset-1 ring-offset-bg" : ""}`}
        >
          {pending && !isDeletion && (
            <>
              <s className="text-ink3">{word.text}</s> →{" "}
            </>
          )}
          {pending && !isDeletion ? shown : display}
          <sup className={`ml-0.5 font-mono text-[9px] font-semibold ${pending ? "text-warn" : isDeletion ? "text-ink3" : "text-acc-text"}`}>{glyph}</sup>
        </span>
      </Popover.Trigger>{" "}
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          onMouseEnter={hoverOpen}
          onMouseLeave={hoverClose}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onFocusOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if ((e.target as HTMLElement | null)?.closest?.("[data-flag-nav]")) e.preventDefault();
          }}
          className="z-50 w-[340px] overflow-hidden rounded-[14px] border border-line bg-panel text-[13px] text-ink shadow-pop outline-none"
        >
          {/* never taller than the room Radix measured on screen; the body scrolls instead */}
          <ScrollArea style={{ maxHeight: "var(--radix-popover-content-available-height)" }}>
          <div className="flex flex-col gap-3 p-3.5">
          <div className="flex items-center gap-2">
            <span className={`grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] font-mono text-[11px] font-semibold ${isDeletion ? "bg-sunk" : "bg-acc-soft text-acc-text"}`}>{isDeletion ? "✂" : "Aa"}</span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold">{isDeletion ? `Cut · ${cutKind(flag)}` : flag.subkind === "manual" ? "Your correction" : "Name / term fix"}</div>
              <div className="text-xs text-ink3">{where}</div>
            </div>
            <span className={`chip ${stateTone}`}>{stateLabel}</span>
            {rendered && rendered.state !== "applied" && (
              <span className="chip bg-warn-soft" title={cutStateTitle(rendered)}>
                {cutStateLabel(rendered)}
              </span>
            )}
            {onCopyLink && (
              <button className="text-ink3 hover:text-ink" onClick={onCopyLink} aria-label="Copy link to this fix" title="Copy link to this fix">
                <Link2 className="h-4 w-4" />
              </button>
            )}
            {pinned && (
              <button className="text-ink2 hover:text-ink" onClick={() => onPin(false)} aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {isDeletion ? (
            <div>
              <span className="text-ink3">Cuts </span>
              <s>“{flag.heard}”</s>
              {rendered && <p className={`mt-1 whitespace-pre-line text-xs ${rendered.state === "applied" ? "text-ink3" : "text-warn"}`}>{rendered.state === "applied" ? "Cut in the last render." : cutStateTitle(rendered)}</p>}
            </div>
          ) : (
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
              <span className="text-xs text-ink3">Heard</span>
              <s>{flag.heard}</s>
              <label className="text-xs text-ink3" htmlFor={`rep-${flag.id}`}>
                Use
              </label>
              <input
                id={`rep-${flag.id}`}
                className="input py-1.5"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") accept();
                }}
              />
            </div>
          )}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-ink3">Confidence</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunk">
              <div className={`h-full rounded-full ${pct >= 80 ? "bg-ok" : pct >= 60 ? "bg-acc" : "bg-warn"}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="font-mono">{pct}%</span>
          </div>
          {loop && (
            <div className="flex items-center gap-2">
              <button
                className={`btn min-w-[9.5rem] justify-center px-2.5 py-1.5 text-xs ${loop.on ? "bg-ink font-semibold text-bg" : "border border-line bg-panel text-ink hover:bg-sunk"}`}
                onClick={loop.toggle}
                aria-pressed={loop.on}
                title={loop.on ? "Stop playing in context (P) · Space pauses" : "Play the audio around this fix on repeat (P)"}
              >
                {loop.on ? "■ Stop" : "↻ Play in context"} <span className="kbd">P</span>
              </button>
              <div role="radiogroup" aria-label="Seconds of context" className="seg">
                {[2, 4, 8].map((n) => (
                  <button
                    key={n}
                    role="radio"
                    aria-checked={loop.sec === n}
                    onClick={() => loop.setSec(n)}
                    className={`rounded-[7px] px-2 py-0.5 font-mono text-[11px] ${loop.sec === n ? "bg-panel text-ink shadow-[0_1px_2px_rgba(0,0,0,.12)]" : "text-ink2"}`}
                  >
                    ±{n}s
                  </button>
                ))}
              </div>
              {loop.on && !loop.ab && <span className="whitespace-nowrap text-[11px] text-ink3">{loop.paused ? "paused" : "original audio"}</span>}
            </div>
          )}
          {loop?.ab && <CutAB ab={loop.ab} playing={loop.on} paused={loop.paused} />}
          <div className="flex flex-wrap items-center gap-1.5">
            {flag.subkind === "manual" && !isDeletion && (
              <button className="btn-primary px-2.5 py-1.5 text-xs" disabled={!text.trim() || text.trim() === shown} onClick={accept} title="Stage the new text; apply from the bar">
                <Check className="h-3.5 w-3.5" /> Save text
              </button>
            )}
            {flag.subkind !== "manual" && (
              <>
                <button className="btn-primary px-2.5 py-1.5 text-xs" onClick={accept}>
                  <Check className="h-3.5 w-3.5" /> Accept <span className="kbd">A</span>
                </button>
                <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => onDecide({ status: "rejected" })}>
                  <X className="h-3.5 w-3.5" /> Reject <span className="kbd">R</span>
                </button>
              </>
            )}
            {onDelete &&
              (confirmDel ? (
                <span className="flex items-center gap-1">
                  <button className="btn bg-err px-2.5 py-1.5 text-xs font-semibold text-white hover:brightness-110" disabled={deleting} onClick={onDelete}>
                    {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} {flag.subkind === "manual" ? "Delete cut" : "Delete fix"}
                  </button>
                  <button className="btn-quiet px-2 py-1.5 text-xs" onClick={() => setConfirmDel(false)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  className="btn-quiet px-2.5 py-1.5 text-xs text-ink2"
                  onClick={() => setConfirmDel(true)}
                  title={flag.subkind === "manual" ? "Delete your cut; any automatic fixes it replaced come back as they were" : "Delete this fix; the words stay as heard"}
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </button>
              ))}
            {decision && (
              <button className="btn-quiet px-2.5 py-1.5 text-xs" onClick={() => onDecide(null)}>
                ↶ Undo
              </button>
            )}
            <span className="ml-auto font-mono text-[11px] text-ink3">{position}</span>
          </div>
          {/* always present, one line: swapping its text never resizes the popover */}
          <p className="flex items-center gap-1 truncate text-[11px] text-ink3">
            {decision ? (
              <span className="text-ink2">Staged · apply from the bar under the transcript</span>
            ) : (
              <>
                <span className="kbd">A</span> accept · <span className="kbd">R</span> reject · <span className="kbd">↑</span>
                <span className="kbd">↓</span> next · <span className="kbd">P</span> play
              </>
            )}
          </p>
          </div>
          </ScrollArea>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

const SOURCE_LABEL: Record<CutPlan["source"], string> = {
  render: "Exact: the cut from the last render",
  search: "Exact: found by the cut search",
  timestamps: "Approximate: word timestamps",
};

/** Original vs with-the-cut toggle for a disfluency, plus where the cut boundaries came from. */
function CutAB({ ab, playing, paused }: { ab: NonNullable<NonNullable<React.ComponentProps<typeof FlagWord>["loop"]>["ab"]>; playing: boolean; paused: boolean }) {
  const { plan, loading, error } = ab.plan ?? {};
  useEffect(() => {
    ab.loadPlan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] bg-sunk p-2">
      <div className="flex items-center gap-2">
        <div role="radiogroup" aria-label="Which version" className="seg bg-panel">
          {(
            [
              ["orig", "Original"],
              ["cut", "With cut"],
            ] as const
          ).map(([v, l]) => (
            <button
              key={v}
              role="radio"
              aria-checked={ab.variant === v}
              onClick={() => ab.setVariant(v)}
              className={`rounded-[7px] px-2.5 py-1 text-xs font-semibold ${ab.variant === v ? "bg-ink text-bg" : "text-ink2 hover:text-ink"}`}
            >
              {l}
            </button>
          ))}
        </div>
        {playing && <span className="whitespace-nowrap text-[11px] text-ink3">{paused ? "paused" : ab.variant === "cut" ? "playing with the cut" : "playing as recorded"}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink2">
        {loading === "plan" && <span>Checking for an exact cut…</span>}
        {loading === "exact" && (
          <span className="flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" /> Searching for a clean cut, usually 5–20 s…
          </span>
        )}
        {!loading && plan && <span>{SOURCE_LABEL[plan.source]}</span>}
        {!loading && plan?.source === "timestamps" && !plan.refused && (
          <button className="font-semibold text-acc-text" onClick={ab.findExact} title="Run the same cut search the renderer uses on this spot">
            Find exact cut
          </button>
        )}
        {error && <span className="text-err">{error.slice(0, 120)}</span>}
      </div>
      {!loading && plan?.refused && <Refusal reason={plan.refused} />}
    </div>
  );
}

/** One readable line for a refused cut, with the verifier's raw log behind a toggle. */
function Refusal({ reason }: { reason: string }) {
  const [open, setOpen] = useState(false);
  const tries = /after (\d+) attempt/.exec(reason)?.[1];
  const lostNext = /next lost/.test(reason);
  const lostPrev = /prev lost/.test(reason);
  const leftover = /deleted (?:heard|left)/.test(reason);
  const why = /within 30 s/.test(reason)
    ? "search ran out of time"
    : lostNext && lostPrev
      ? "it clipped the words around it"
      : lostNext
        ? "it clipped the next word"
        : lostPrev
          ? "it clipped the previous word"
          : leftover
            ? "part of it stayed audible"
            : "the seam wasn't clean";
  return (
    <div className="flex flex-col gap-1 text-[11px] leading-snug text-ink">
      <div className="flex items-center gap-2" title="Renders keep these words in the audio; “With cut” plays the approximate cut">
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold text-warn">No clean cut{tries ? ` (${tries} tries)` : ""}</span> · {why}
        </span>
        <button className="shrink-0 font-semibold text-acc-text" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide" : "Details"}
        </button>
      </div>
      {open && (
        <ScrollArea className="max-h-32 rounded-[8px] bg-panel">
          <p className="whitespace-pre-wrap break-words p-2 font-mono text-[10px] text-ink2">{reason.replace(/; (?=\d)/g, ";\n")}</p>
        </ScrollArea>
      )}
    </div>
  );
}

/** The one label of a clip's bracket: hover for a summary card, click to focus the clip. */
function ClipMarker({ clip, projectId, active, onFocus, onPlay }: { clip: TranscriptClip; projectId: string; active: boolean; onFocus?: (id: string) => void; onPlay?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), 120);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), 160);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          onMouseEnter={show}
          onMouseLeave={hide}
          onFocus={show}
          onBlur={hide}
          onClick={(e) => {
            e.preventDefault();
            setOpen(false);
            if (clip.id) onFocus?.(clip.id);
          }}
          aria-label={`Clip ${clip.index + 1}${clip.title ? `: ${clip.title}` : ""}`}
          className={`grid h-6 min-w-6 place-items-center rounded-[7px] px-1 font-mono text-[11px] font-semibold shadow-[0_0_0_3px_var(--bg)] transition ${active ? "bg-ink text-bg" : "bg-acc text-acc-ink hover:brightness-110"}`}
        >
          {clip.index + 1}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          onMouseEnter={show}
          onMouseLeave={hide}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className="z-50 flex w-[280px] gap-3 rounded-[14px] border border-line bg-panel p-3 text-ink shadow-pop outline-none"
        >
          <button
            className="film relative w-[54px] shrink-0 overflow-hidden rounded-[8px]"
            style={{ aspectRatio: "9 / 16" }}
            disabled={!clip.videoUrl || !clip.id}
            onClick={() => clip.id && onPlay?.(clip.id)}
            aria-label="Play preview"
          >
            {clip.thumbnailUrl && <img src={clip.thumbnailUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />}
            {clip.videoUrl && <span className="absolute inset-0 grid place-items-center text-[10px] text-white [text-shadow:0_1px_2px_#000]">▶</span>}
          </button>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-start gap-1.5">
              <span className="pt-px font-mono text-[11px] text-ink3">#{clip.index + 1}</span>
              <b className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug">{clip.title || "Untitled clip"}</b>
              {clip.score ? <span className="shrink-0 rounded-[6px] bg-acc-soft px-1.5 font-mono text-[11px] font-semibold text-acc-text">{Math.round(clip.score)}</span> : null}
            </div>
            <span className="font-mono text-[11px] text-ink2">
              {formatTime(clip.startSec)}–{formatTime(clip.endSec)} · {Math.round(clip.endSec - clip.startSec)}s
            </span>
            {clip.hook && <span className="line-clamp-2 text-xs text-ink2">“{clip.hook}”</span>}
            <div className="mt-0.5 flex flex-wrap gap-1">
              {clip.id && (
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => onFocus?.(clip.id!)}>
                  Show clip
                </button>
              )}
              {clip.id && (
                <a className="btn-quiet px-2 py-1 text-xs font-semibold text-acc-text no-underline" href={`/p/${projectId}/clips/${clip.id}`}>
                  Edit
                </a>
              )}
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
