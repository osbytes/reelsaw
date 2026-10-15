import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as Popover from "@radix-ui/react-popover";
import { ArrowDown, Check, X, Sparkles, RefreshCw, ChevronUp, ChevronDown, Scissors, Flag, Play, Loader2 } from "lucide-react";
import { useTRPC } from "../lib/trpc";
import { ScrollArea } from "./scroll-area";
import { scrollWithin, isVisibleWithin } from "../lib/scroll";
import { formatTime, type TranscriptSegment, type TranscriptFlag, type Word } from "@reelsaw/shared";

interface Props {
  projectId: string;
  language: string | null;
  segments: TranscriptSegment[];
  /** as-heard words; the panel shows replacements/deletions inline on top of them */
  words: Word[];
  flags: TranscriptFlag[];
  currentTime: number;
  clips: Array<{ index: number; startSec: number; endSec: number }>;
  onSeek: (t: number) => void;
}

type Decision = { status: "accepted" | "rejected"; replacement?: string };
const EPS = 0.02;

/**
 * Chat-style transcript: follows playback (auto-scrolls the active line into view) until the user
 * scrolls away, then shows a "resume" pill. Lines are rendered word by word so each name fix is an
 * inline highlight with a hover/click popover (accept, reject, or type a replacement).
 */
export function TranscriptPanel({ projectId, language, segments, words, flags, currentTime, clips, onSeek }: Props) {
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
  const createClip = useMutation(trpc.clips.create.mutationOptions());
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
    const rect = r.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    const top = Math.min(box.height - 44, Math.max(40, rect.bottom - box.top + 6));
    const left = Math.max(150, Math.min(box.width - 150, rect.left - box.left + rect.width / 2));
    setFollowing(false); // don't scroll the selection away during playback
    setPick({ start, end, top, left });
  };
  useEffect(() => {
    const onChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setPick(null);
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

  function jumpToFlag(i: number) {
    const f = orderedFlags[i];
    const v = viewportRef.current;
    const el = f && flagRefs.current[f.id];
    if (!f || !v || !el) return;
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
    await qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: projectId }) });
  }

  return (
    <div ref={rootRef} className="card relative flex flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted">
        <span>
          Transcript{language ? ` · ${language}` : ""}
          {segments.length > 0 && <span className="ml-1 hidden text-muted/70 sm:inline">· select text to make a clip</span>}
        </span>
        {orderedFlags.length > 0 && (
          <span className="flex items-center gap-1">
            <button className="rounded border border-border px-1 py-0.5 hover:bg-panel-2" title="Previous flag" onClick={() => jumpToFlag((flagCursor - 1 + orderedFlags.length) % orderedFlags.length)}>
              <ChevronUp className="h-3 w-3" />
            </button>
            <Popover.Root>
              <Popover.Trigger asChild>
                <button className="flex items-center gap-1 rounded border border-border px-2 py-0.5 tabular-nums hover:bg-panel-2" title="All flags">
                  <Flag className="h-3 w-3" />
                  {flagCursor >= 0 ? `${flagCursor + 1} / ${orderedFlags.length}` : orderedFlags.length}
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content side="bottom" align="end" sideOffset={6} className="z-50 w-96 rounded-md border border-border bg-panel p-2 text-xs shadow-xl outline-none">
                  <ScrollArea className="max-h-80">
                    <ul className="space-y-0.5 pr-2">
                      {orderedFlags.map((f, i) => {
                        const d = decisions[f.id];
                        const st = (d?.status ?? f.status) as TranscriptFlag["status"];
                        const text = d?.replacement ?? f.replacement ?? f.suggested;
                        return (
                          <li key={f.id}>
                            <Popover.Close asChild>
                              <button className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-panel-2 ${i === flagCursor ? "bg-panel-2" : ""}`} onClick={() => jumpToFlag(i)}>
                                <span className="w-10 shrink-0 font-mono text-muted">{formatTime(f.start)}</span>
                                {f.kind === "disfluency" ? <Scissors className="h-3 w-3 shrink-0 text-accent-2" /> : <Sparkles className="h-3 w-3 shrink-0 text-accent" />}
                                <span className="min-w-0 flex-1 truncate">
                                  {f.kind === "disfluency" ? (
                                    <>
                                      remove <span className="text-text line-through">{f.heard}</span> <span className="text-muted">({f.subkind === "repair" ? "false start" : f.subkind})</span>
                                    </>
                                  ) : (
                                    <>
                                      <span className="text-text line-through">{f.heard}</span> → <span className="text-text">{text}</span>
                                    </>
                                  )}
                                </span>
                                <span className={`shrink-0 ${st === "auto" || st === "accepted" ? "text-ok" : st === "rejected" ? "text-muted" : "text-accent"}`}>
                                  {st === "auto" ? "auto" : st === "pending" ? "review" : st}
                                </span>
                                <span className="w-8 shrink-0 text-right text-muted">{Math.round(f.confidence * 100)}%</span>
                              </button>
                            </Popover.Close>
                          </li>
                        );
                      })}
                    </ul>
                  </ScrollArea>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            <button className="rounded border border-border px-1 py-0.5 hover:bg-panel-2" title="Next flag" onClick={() => jumpToFlag((flagCursor + 1) % orderedFlags.length)}>
              <ChevronDown className="h-3 w-3" />
            </button>
          </span>
        )}
      </div>
      {(pendingFlags.length > 0 || dirty) && (
        <div className="flex items-center justify-between gap-3 border-b border-border bg-accent/5 px-3 py-1.5 text-xs">
          <span className="text-muted">
            {pendingFlags.length > 0 ? (
              <>
                <span className="font-medium text-accent">{pendingFlags.length}</span> to review
              </>
            ) : (
              "All flags reviewed"
            )}
            {dirty && <span className="ml-2">· {Object.keys(decisions).length} decided, not applied</span>}
          </span>
          <span className="flex items-center gap-2">
            {pendingFlags.length > 0 && (
              <button
                className="btn-ghost !py-1 text-xs"
                onClick={() => {
                  const next = orderedFlags.findIndex((f, i) => i > flagCursor && f.status === "pending" && !decisions[f.id]);
                  jumpToFlag(next >= 0 ? next : orderedFlags.findIndex((f) => f.status === "pending" && !decisions[f.id]));
                }}
              >
                Next to review
              </button>
            )}
            {dirty && (
              <button className="btn-primary !py-1 text-xs" disabled={review.isPending} onClick={submit}>
                <RefreshCw className="h-3 w-3" /> Apply {Object.keys(decisions).length} & re-render
              </button>
            )}
          </span>
        </div>
      )}
      <ScrollArea className="h-[46vh]" viewportRef={viewportRef}>
        <div ref={contentRef} className="space-y-0.5 p-3 text-sm selection:bg-accent-2/40" onMouseUp={() => setTimeout(readSelection, 0)} onTouchEnd={() => setTimeout(readSelection, 50)} onKeyUp={readSelection}>
          {segments.length === 0 && <p className="text-muted">Appears after transcription.</p>}
          {lines.map(({ s, ws }, i) => {
            const isActive = currentTime >= s.start && currentTime < s.end;
            const inClip = clips.find((c) => s.start >= c.startSec - 0.3 && s.end <= c.endSec + 0.3);
            return (
              <div
                key={i}
                ref={isActive ? activeRef : undefined}
                className={`rounded px-1.5 py-0.5 leading-7 ${isActive ? "bg-accent/20" : inClip ? "bg-accent-2/10" : "hover:bg-panel-2"}`}
                title={inClip ? `In clip #${inClip.index + 1}` : undefined}
              >
                <button className="mr-2 select-none font-mono text-[11px] text-muted hover:text-text" onClick={() => onSeek(s.start)} title="Seek here">
                  {formatTime(s.start)}
                </button>
                {ws.length === 0 && (
                  <span data-s={s.start} data-e={s.end} onClick={() => onSeek(s.start)}>
                    {s.text}
                  </span>
                )}
                {ws.map(({ w, flag }, k) => {
                  const spoken = currentTime >= w.start && currentTime < w.end;
                  if (!flag) {
                    return (
                      <span key={k} data-s={w.start} data-e={w.end} onClick={() => !window.getSelection()?.toString() && onSeek(w.start)} className={`cursor-pointer rounded-sm px-px ${spoken ? "text-accent" : ""}`}>
                        {w.text}{" "}
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
                      }}
                      onDecide={(d) => setDecisions((x) => (d ? { ...x, [flag.id]: d } : Object.fromEntries(Object.entries(x).filter(([key]) => key !== flag.id))))}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      </ScrollArea>
      {pick && (
        <div
          className="absolute z-30 w-max max-w-[calc(100%-12px)] -translate-x-1/2 rounded-md border border-border bg-panel p-1 text-xs shadow-xl"
          style={{ top: pick.top, left: pick.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="flex items-center gap-1 whitespace-nowrap">
          <span className="px-1.5 font-mono text-muted">
            {Math.round(pick.end - pick.start)}s
          </span>
          <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => onSeek(pick.start)} title="Play from the start of the selection">
            <Play className="h-3.5 w-3.5" />
          </button>
          <button className="btn-primary !px-2 !py-1 text-xs" disabled={createClip.isPending || pick.end - pick.start < 3} onClick={() => makeClip("exact")} title="Clip exactly this range; the AI writes the title, hook and caption">
            {createClip.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Scissors className="h-3.5 w-3.5" />} Make clip
          </button>
          <button className="btn-ghost !px-2 !py-1 text-xs" disabled={createClip.isPending || pick.end - pick.start < 8} onClick={() => makeClip("ai")} title="Let the AI find the best standalone clip inside this selection">
            <Sparkles className="h-3.5 w-3.5" /> AI pick
          </button>
          <button
            className="rounded p-1 text-muted hover:text-text"
            onClick={() => {
              window.getSelection()?.removeAllRanges();
              setPick(null);
            }}
            aria-label="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          </div>
          {createClip.error && <p className="whitespace-normal px-1.5 pt-1 text-danger">{createClip.error.message}</p>}
        </div>
      )}
      {!following && segments.length > 0 && (
        <button className="btn-primary absolute bottom-3 left-1/2 -translate-x-1/2 !py-1 text-xs shadow-lg" onClick={resume}>
          <ArrowDown className="h-3 w-3" /> Resume auto-scroll · {formatTime(currentTime)}
        </button>
      )}
    </div>
  );
}

function FlagWord({
  word,
  flag,
  decision,
  open,
  pinned,
  highlighted,
  anchorRef,
  onOpenChange,
  onPin,
  onDecide,
}: {
  word: Word;
  flag: TranscriptFlag;
  decision?: Decision;
  open: boolean;
  pinned: boolean;
  highlighted: boolean;
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

  const hoverOpen = () => {
    window.clearTimeout(closeTimer.current);
    onOpenChange(true);
  };
  const hoverClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => onOpenChange(false), 180);
  };
  const commit = () => {
    const t = text.trim();
    if (!t && !isDeletion) return;
    onDecide({ status: "accepted", replacement: t === flag.suggested ? undefined : t });
  };

  const isDeletion = flag.kind === "disfluency";
  const underline = applied ? "decoration-ok" : status === "rejected" ? "decoration-muted decoration-dashed" : "decoration-accent";
  const bg = applied ? (isDeletion ? "bg-danger/10" : "bg-ok/10") : status === "rejected" ? "" : "bg-accent/10";
  // what the caption will say: replacement text for entities, nothing (struck through) for deletions
  const display = isDeletion || !applied ? word.text : shown;

  return (
    <Popover.Root open={open} onOpenChange={(o) => (o ? onOpenChange(true) : onPin(false))}>
      <Popover.Trigger asChild>
        <span
          ref={anchorRef}
          data-s={word.start}
          data-e={word.end}
          onMouseEnter={hoverOpen}
          onMouseLeave={hoverClose}
          onClick={(e) => {
            e.preventDefault();
            onPin(!pinned);
          }}
          className={`cursor-pointer rounded-sm px-0.5 decoration-2 underline-offset-4 ${isDeletion && applied ? "line-through decoration-danger/70 text-muted" : `underline ${underline}`} ${bg} ${highlighted ? "ring-1 ring-accent" : ""}`}
          title={isDeletion ? `remove "${flag.heard}" (${flag.subkind}, ${pct}%)` : `${flag.heard} → ${shown} (${pct}%)`}
        >
          {display}{" "}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          onMouseEnter={hoverOpen}
          onMouseLeave={hoverClose}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-50 w-80 rounded-md border border-border bg-panel p-3 text-xs shadow-xl outline-none"
        >
          <div className="mb-2 flex items-center gap-2 text-muted">
            {isDeletion ? <Scissors className="h-3 w-3 text-accent-2" /> : <Sparkles className="h-3 w-3 text-accent" />}
            <span>
              {isDeletion ? `${flag.subkind}: remove ` : "heard "}
              <span className="text-text line-through decoration-danger/60">{flag.heard}</span>
            </span>
            <span className="ml-auto rounded bg-panel-2 px-1.5 py-0.5" title="Model confidence">
              {pct}%
            </span>
            <span className={applied ? "text-ok" : status === "rejected" ? "text-muted" : "text-accent"}>
              {status === "auto" ? "auto-fixed" : status}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              className="input !py-1 text-xs"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
              }}
              placeholder={isDeletion ? "leave empty to delete, or type what to keep" : "replacement"}
            />
            <button className="btn-primary !px-2 !py-1" onClick={commit} title={isDeletion ? "Remove these words" : "Accept with this text"}>
              <Check className="h-3 w-3" />
            </button>
            {status !== "rejected" && (
              <button className="btn-ghost !px-2 !py-1" onClick={() => onDecide({ status: "rejected" })} title="Keep what was heard">
                <X className="h-3 w-3" />
              </button>
            )}
            {decision && (
              <button className="btn-ghost !px-2 !py-1 text-muted" onClick={() => onDecide(null)} title="Undo">
                undo
              </button>
            )}
          </div>
          {decision && <p className="mt-2 text-muted">Pending. Use "Apply & re-render" in the header to save.</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
