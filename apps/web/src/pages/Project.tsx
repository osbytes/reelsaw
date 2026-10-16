import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSubscription } from "@trpc/tanstack-react-query";
import { Link, useNavigate, useParams } from "react-router";
import { ChevronDown, ChevronUp, Link2, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { useTRPC } from "../lib/trpc";
import { useToast } from "../lib/toast";
import { describeEvent, type Tone } from "../lib/activity";
import { writeHash, linkWith, fmtSec, useHashParams } from "../lib/hash";
import { ConfirmDialog, ProgressBar } from "../components/ui";
import { ScrollArea } from "../components/scroll-area";
import { ClipCard, type ClipView } from "../components/ClipCard";
import { TranscriptPanel } from "../components/TranscriptPanel";
import { formatTime, masksSourceText, PIPELINE_STAGES, type ProjectEvent } from "@reelsaw/shared";

const STAGE_LABEL: Record<string, string> = { ingest: "Download", transcribe: "Transcribe", refine: "Refine", analyze: "Find moments", render: "Render" };
const STAGE_INDEX: Record<string, number> = { queued: -1, ingesting: 0, transcribing: 1, refining: 2, analyzing: 3, rendering: 4, done: 5, failed: 99 };
const REFINE_LABEL: Record<string, string> = { entities: "names", disfluency: "disfluencies", scenes: "scenes" };
const ACTIVE = new Set(["queued", "ingesting", "transcribing", "refining", "analyzing", "rendering"]);
const TONE_GLYPH: Record<Tone, string> = { ok: "●", run: "◔", warn: "◷", err: "▲" };
const TONE_FG: Record<Tone, string> = { ok: "text-ok", run: "text-acc-text", warn: "text-warn", err: "text-err" };

function useWidth() {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

export function ProjectPage() {
  const { id = "" } = useParams();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const q = useQuery(trpc.projects.get.queryOptions({ id }));
  const retry = useMutation(trpc.projects.retry.mutationOptions());
  const reanalyze = useMutation(trpc.projects.reanalyze.mutationOptions());
  const refine = useMutation(trpc.projects.refine.mutationOptions());
  const del = useMutation(trpc.projects.delete.mutationOptions());
  const rerender = useMutation(trpc.clips.rerender.mutationOptions());
  const setSourceText = useMutation(trpc.projects.setSourceText.mutationOptions());

  const [log, setLog] = useState<ProjectEvent[]>([]);
  const [progress, setProgress] = useState<{ stage: string; value: number; message?: string } | null>(null);
  const [clipProgress, setClipProgress] = useState<Record<string, number>>({});
  const [activeClip, setActiveClip] = useState<string | null>(null);
  const [srcTime, setSrcTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [confirm, setConfirm] = useState<null | "repick" | "refine" | "delete">(null);
  const [actOpen, setActOpen] = useState(false);
  const [drawer, setDrawer] = useState(true);
  const [preview, setPreview] = useState<ClipView | null>(null);
  const [stallDismissed, setStallDismissed] = useState<number | null>(null);
  const width = useWidth();
  const compact = width < 900;
  const [mtab, setMtab] = useState<"transcript" | "clips" | "activity">("transcript");
  const sourceRef = useRef<HTMLVideoElement>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id }) });

  useSubscription(
    trpc.projects.events.subscriptionOptions(
      { id },
      {
        onData: (envelope) => {
          const evt = envelope.data;
          if (evt.type !== "stage.progress") setLog((l) => (l.some((e) => e.id === evt.id) ? l : [...l.slice(-499), evt]));
          if (evt.type === "stage.progress") {
            const p = evt.payload as { stage: string; progress: number; message?: string; clipId?: string };
            setProgress({ stage: p.stage, value: p.progress, message: p.message });
            if (p.clipId) setClipProgress((c) => ({ ...c, [p.clipId!]: p.progress }));
          } else {
            void invalidate();
            qc.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
          }
        },
      },
    ),
  );

  useEffect(() => {
    setLog([]);
    setProgress(null);
    setClipProgress({});
    setActiveClip(null);
  }, [id]);

  const p = q.data;
  const stageIdx = p ? (STAGE_INDEX[p.status] ?? -1) : -1;
  const active = !!p && ACTIVE.has(p.status);
  const refineState = p?.transcript?.refine ?? {};
  const sortedClips = useMemo(() => (p?.clips ?? []).slice().sort((a, b) => a.index - b.index), [p]);
  const readyCount = sortedClips.filter((c) => c.status === "done").length;
  const failedClips = sortedClips.filter((c) => c.status === "failed");

  const activity = useMemo(
    () =>
      log
        .filter((e) => e.type !== "stage.progress")
        .map((e) => ({ e, d: describeEvent(e) }))
        .filter((x): x is { e: ProjectEvent; d: NonNullable<ReturnType<typeof describeEvent>> } => !!x.d)
        .reverse(),
    [log],
  );
  const stalled = useMemo(() => {
    const last = [...log].reverse().find((e) => e.type !== "stage.progress");
    return active && last?.type === "job.stalled" && last.id !== stallDismissed ? last : null;
  }, [log, active, stallDismissed]);

  function seekSource(t: number, clipId?: string) {
    const v = sourceRef.current;
    if (clipId) setActiveClip(clipId);
    if (!v) return;
    v.currentTime = t;
    v.play().catch(() => {});
  }
  // loop a span of the source (transcript fix context); rAF keeps the wrap tight, timeupdate is ~4 Hz
  const [loop, setLoop] = useState<{ start: number; end: number } | null>(null);
  useEffect(() => {
    const v = sourceRef.current;
    if (!v) return;
    if (!loop) return;
    v.currentTime = loop.start;
    v.play().catch(() => {});
    let raf = 0;
    const tick = () => {
      if (v.currentTime >= loop.end || v.currentTime < loop.start - 0.5) v.currentTime = loop.start;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      v.pause();
    };
  }, [loop]);
  const togglePlay = () => {
    const v = sourceRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  // ----- deep links: #clip=<id> opens the preview, #card=<id> highlights a card, #t=<sec> seeks the source -----
  const hash = useHashParams();
  const hashClip = hash.get("clip");
  const hashCard = hash.get("card");
  const hashT = hash.get("t");
  const clipsLoaded = !!q.data;
  const focusCard = (id: string, toTab = false) => {
    setActiveClip(id);
    setDrawer(true);
    if (toTab) setMtab("clips");
    requestAnimationFrame(() => document.querySelector(`[data-clip="${id}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  };
  useEffect(() => {
    if (!clipsLoaded) return;
    const c = hashClip ? q.data!.clips.find((x) => x.id === hashClip) : undefined;
    if (c) setPreview(c as ClipView);
    const card = hashCard ?? hashClip;
    if (card) focusCard(card, !!hashCard && !hashClip);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipsLoaded, hashClip, hashCard]);
  useEffect(() => {
    const v = sourceRef.current;
    const t = Number(hashT);
    if (!v || !hashT || !Number.isFinite(t)) return;
    const go = () => {
      v.currentTime = t;
      setSrcTime(t);
    };
    if (v.readyState >= 1) go();
    else v.addEventListener("loadedmetadata", go, { once: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hashT, clipsLoaded]);
  useEffect(() => {
    if (clipsLoaded) writeHash({ clip: preview?.id ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview?.id]);
  const copyLink = (params: Record<string, string>) =>
    navigator.clipboard
      .writeText(linkWith(params))
      .then(() => toast("Link copied"))
      .catch(() => toast("Couldn’t copy the link"));
  
  // Space plays / pauses the source video anywhere on the page except while typing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]")) return;
      const v = sourceRef.current;
      if (!v) return;
      e.preventDefault(); // also stops Space from re-clicking the focused button
      if (v.paused) v.play().catch(() => {});
      else v.pause();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (q.isLoading) return <p className="p-6 text-ink3">Loading…</p>;
  if (q.error || !p) return <p className="p-6 text-err">{q.error?.message ?? "Not found"}</p>;

  const pipeState = (stage: string, i: number) =>
    p.status === "failed" && p.stage === stage ? "failed" : i < stageIdx || p.status === "done" ? "done" : i === stageIdx ? (stalled ? "stalled" : "running") : "waiting";
  const PIPE_STYLE: Record<string, [string, string]> = {
    done: ["✓", "bg-ok-soft text-ok"],
    running: ["◔", "bg-acc-soft text-acc-text"],
    waiting: ["○", "bg-sunk text-ink3"],
    stalled: ["◷", "bg-warn-soft text-warn"],
    failed: ["▲", "bg-err-soft text-err"],
  };
  const overlays = p.transcript?.overlays ?? [];
  const presentation = !!p.transcript?.textProfile?.presentation;
  const masking = overlays.length > 0 && masksSourceText(p.settings.sourceText, p.transcript?.textProfile);
  const hasCaptions = overlays.some((o) => o.kind === "caption");
  const host = (() => {
    try {
      return p.sourceUrl ? new URL(p.sourceUrl).host.replace(/^www\./, "") : null;
    } catch {
      return null;
    }
  })();
  const live = activity[0]?.d ?? (active ? { text: "Waiting for the worker…", tone: "run" as Tone } : { text: "No activity yet", tone: "ok" as Tone });
  const dur = p.durationSec ?? 0;

  const header = (
    <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-3 border-b border-line px-4 py-3.5 sm:px-5">
      <div className="min-w-0 flex-[1_1_320px]">
        <div className="flex gap-1.5 text-xs text-ink3">
          <Link to="/" className="text-ink3 no-underline hover:text-ink">
            Projects
          </Link>
          <span>/</span>
          <span className="truncate">{p.title}</span>
        </div>
        <h1 className="mt-0.5 text-xl font-bold leading-tight tracking-tight [text-wrap:pretty]">{p.title}</h1>
        <div className="mt-1 flex flex-wrap gap-x-3.5 gap-y-1 text-[13px] text-ink2">
          {dur ? <span className="font-mono text-xs leading-5">{formatTime(dur)}</span> : null}
          {p.width && p.height ? <span>{p.height}p</span> : null}
          {p.sourceType === "url" && p.sourceUrl ? (
            <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="max-w-[260px] truncate text-ink2 no-underline hover:text-acc-text">
              {host ?? p.sourceUrl}
            </a>
          ) : (
            <span>Uploaded file</span>
          )}
          {sortedClips.length > 0 && (
            <span className={readyCount === sortedClips.length ? "font-semibold text-ok" : ""}>
              {readyCount} of {sortedClips.length} clips ready
            </span>
          )}
        </div>
        {(active || p.status === "failed") && (
          <ol aria-label="Pipeline" className="mt-2.5 flex flex-wrap gap-1.5">
            {PIPELINE_STAGES.map((stage, i) => {
              const st = pipeState(stage, i);
              const [g, cls] = PIPE_STYLE[st]!;
              const pr = progress?.stage === stage ? progress.value : (p.stageProgress ?? 0);
              const note =
                st === "running"
                  ? stage === "refine"
                    ? (["entities", "disfluency", "scenes"] as const)
                        .map((s) => `${REFINE_LABEL[s]} ${refineState[s] === "done" ? "✓" : refineState[s] === "running" ? "…" : refineState[s] === "failed" ? "▲" : "○"}`)
                        .join(" · ")
                    : `${Math.round(pr * 100)}%`
                  : st === "stalled"
                    ? "no progress"
                    : null;
              return (
                <li key={stage} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${cls}`}>
                  <span className="font-mono">{g}</span>
                  <span className="text-ink">{STAGE_LABEL[stage]}</span>
                  {note && <span className="font-mono text-[11px] opacity-80">{note}</span>}
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <div className="flex items-center gap-2">
        {readyCount > 0 ? (
          <a className="btn-primary py-2 no-underline" href={`/api/projects/${p.id}/export.zip`} download title="Zip of every rendered clip with YouTube / TikTok metadata, paste-ready text and a manifest">
            Export {readyCount} clip{readyCount === 1 ? "" : "s"}
          </a>
        ) : (
          <button className="btn-primary py-2" disabled>
            Export
          </button>
        )}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="btn-ghost px-3 py-2 font-bold" aria-label="Project actions">
              ⋯
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className="menu w-[270px]">
              {failedClips.length > 0 && (
                <DropdownMenu.Item className="menu-item block" onSelect={() => Promise.all(failedClips.map((c) => rerender.mutateAsync({ id: c.id }))).then(() => (invalidate(), toast(`Retrying ${failedClips.length} failed clip${failedClips.length === 1 ? "" : "s"}`)))}>
                  Retry failed clips <span className="text-ink3">({failedClips.length})</span>
                </DropdownMenu.Item>
              )}
              {(p.status === "failed" || p.status === "done") && (
                <DropdownMenu.Item className="menu-item block" disabled={retry.isPending} onSelect={() => retry.mutateAsync({ id }).then(invalidate)}>
                  Resume pipeline
                  <div className="text-xs text-ink3">From the last stage that didn’t finish</div>
                </DropdownMenu.Item>
              )}
              {p.transcript && !active && (
                <DropdownMenu.Item className="menu-item block" onSelect={() => setConfirm("refine")}>
                  Re-run refine
                  <div className="text-xs text-ink3">Names, disfluencies, scene changes</div>
                </DropdownMenu.Item>
              )}
              {p.transcript && !active && (
                <DropdownMenu.Item className="menu-item block" onSelect={() => setConfirm("repick")}>
                  Re-pick moments…
                  <div className="text-xs text-ink3">Replaces current clips</div>
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Separator className="mx-1.5 my-1 h-px bg-line" />
              <DropdownMenu.Item className="menu-item text-err data-[highlighted]:bg-err-soft" onSelect={() => setConfirm("delete")}>
                Delete project…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
  );

  const alert =
    p.status === "failed" && p.error ? (
      <div role="alert" className="mx-4 mt-3 flex shrink-0 flex-wrap items-start gap-3 rounded-[14px] border border-err bg-err-soft px-4 py-3 sm:mx-5">
        <span className="font-mono text-lg leading-6 text-err">▲</span>
        <div className="min-w-0 flex-[1_1_320px]">
          <b>{STAGE_LABEL[p.stage ?? ""] ?? "Processing"} failed.</b>
          <div className="mt-0.5 line-clamp-3 font-mono text-xs text-ink2">{p.error}</div>
          <div className="mt-1 text-[13px]">Earlier results are kept. Retry picks up from this step.</div>
        </div>
        <button className="btn-ink" disabled={retry.isPending} onClick={() => retry.mutateAsync({ id }).then(invalidate)}>
          ↻ Retry from {STAGE_LABEL[p.stage ?? ""] ?? "last step"}
        </button>
      </div>
    ) : stalled ? (
      <div role="alert" className="mx-4 mt-3 flex shrink-0 flex-wrap items-start gap-3 rounded-[14px] border border-warn bg-warn-soft px-4 py-3 sm:mx-5">
        <span className="font-mono text-lg leading-6 text-warn">◷</span>
        <div className="min-w-0 flex-[1_1_320px] text-[13px]">
          <b>No progress for {String((stalled.payload as { idleMinutes?: number }).idleMinutes ?? "a while")} min.</b> {String((stalled.payload as { hint?: string }).hint ?? "Slow local models can do this on long videos, or the worker may have stopped.")}
        </div>
        <button className="btn-ghost" onClick={() => setStallDismissed(stalled.id)}>
          Keep waiting
        </button>
        <button className="btn-ink" onClick={() => retry.mutateAsync({ id }).then(invalidate)}>
          ↻ Restart this step
        </button>
      </div>
    ) : null;

  const pct = (t: number) => `${dur ? (t / dur) * 100 : 0}%`;
  const source = (
    <div className={`flex shrink-0 gap-4 px-4 py-3.5 sm:px-5 ${compact ? "flex-col" : "flex-wrap items-center"}`}>
      <div className={`film relative shrink-0 overflow-hidden rounded-[12px] ${compact ? "aspect-video max-h-[30vh] w-full" : "aspect-video h-[clamp(110px,24vh,214px)]"}`}>
        {p.sourceVideoUrl && (
          <video
            ref={sourceRef}
            src={p.sourceVideoUrl}
            poster={(p.sourceMeta?.thumbnail as string | undefined) ?? undefined}
            preload="metadata"
            playsInline
            className="absolute inset-0 h-full w-full bg-black object-contain"
            onTimeUpdate={(e) => setSrcTime(e.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onClick={togglePlay}
          />
        )}
        {p.sourceVideoUrl ? (
          !playing && (
            <button onClick={togglePlay} aria-label="Play" className="absolute left-1/2 top-1/2 grid h-12 w-12 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white/90 text-[#1c1c1e] shadow-pop">
              ▶
            </button>
          )
        ) : (
          <span className="absolute inset-0 grid place-items-center font-mono text-[11px] text-[#b9b9c0]">{active ? "downloading…" : "no source video"}</span>
        )}
      </div>
      <div className="flex min-w-0 flex-[1_1_240px] flex-col justify-center gap-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <button className="btn-ghost px-2.5 py-1 text-xs" onClick={() => seekSource(Math.max(0, srcTime - 5))}>
            −5s
          </button>
          <button className="btn-ghost px-2.5 py-1 text-xs" onClick={togglePlay}>
            {playing ? "❚❚ Pause" : "▶ Play"}
          </button>
          <button className="btn-ghost px-2.5 py-1 text-xs" onClick={() => seekSource(srcTime + 5)}>
            +5s
          </button>
          <span className="ml-auto whitespace-nowrap font-mono text-xs text-ink2">
            {formatTime(srcTime)} / {formatTime(dur)}
          </span>
          <button className="btn-quiet px-1.5 py-1 text-ink3" onClick={() => copyLink({ t: fmtSec(srcTime) })} title="Copy link to this moment" aria-label="Copy link to this moment">
            <Link2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <div
          className="relative h-[26px] cursor-pointer"
          title="Seek"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            seekSource(((e.clientX - r.left) / r.width) * dur);
          }}
        >
          <div className="absolute inset-x-0 top-[11px] h-1 rounded-full bg-line" />
          {sortedClips.map((c) => (
            <div key={c.id} title={`Clip ${c.index + 1}`} className={`absolute top-2 h-2.5 rounded-[2px] ${activeClip === c.id ? "bg-ink" : "bg-acc opacity-85"}`} style={{ left: pct(c.startSec), width: `max(3px, ${pct(c.endSec - c.startSec)})` }} />
          ))}
          <div className="absolute top-0.5 h-[22px] w-0.5 rounded-[1px] bg-ink" style={{ left: pct(srcTime) }} />
        </div>
        {(overlays.length > 0 || presentation) && (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-[10px] bg-acc-soft px-2.5 py-1.5 text-xs text-ink2">
            <span className="rounded-[4px] bg-panel px-1.5 py-px font-mono text-[10px] text-ink">{presentation ? "SLIDES" : hasCaptions ? "CC" : "TXT"}</span>
            <span className="min-w-0 flex-[1_1_160px] text-ink">
              {presentation && p.settings.sourceText !== "always"
                ? "Looks like a slide presentation, so on-screen text is kept and slides are shown whole."
                : presentation && p.settings.sourceText === "always"
                  ? "Burned-in text is hidden, even though this looks like a slide presentation."
                  : `Burned-in ${hasCaptions ? "captions" : "text"}${overlays.length > 1 ? " and logos" : ""} ${masking ? "are hidden in clips." : "are shown in clips."}`}
            </span>
            {(presentation ? overlays.length > 0 || p.settings.sourceText === "always" : true) && (
              <button
                className="text-xs font-semibold text-acc-text disabled:opacity-50"
                disabled={setSourceText.isPending}
                onClick={() => setSourceText.mutateAsync({ id, sourceText: masking ? "keep" : presentation ? "always" : "hide" }).then(invalidate)}
              >
                {masking ? "Show it" : presentation ? "Hide it anyway" : "Hide it"} (re-renders)
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const transcriptStage = stageIdx >= 2 || p.status === "done" || !!p.transcript;
  const waiting = (
    <div className="flex min-h-0 flex-1 items-start justify-center border-t border-line px-5 py-10">
      <div className="flex w-full max-w-[560px] flex-col gap-3">
        <b className="text-base">{stageIdx <= 0 ? "Downloading…" : `Transcribing… ${Math.round((progress?.stage === "transcribe" ? progress.value : (p.stageProgress ?? 0)) * 100)}%`}</b>
        <span className="text-[13px] leading-relaxed text-ink2">The transcript appears here when transcription finishes. Fixes, then clips, follow. You can leave; this keeps running on the server.</span>
        <ProgressBar value={progress?.value ?? p.stageProgress ?? 0} />
        {[92, 78, 85, 60, 88, 70].map((w, i) => (
          <div key={i} className="flex gap-2.5">
            <div className="h-3.5 w-10 rounded-full bg-sunk" />
            <div className="h-3.5 rounded-full bg-sunk" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    </div>
  );

  const activityList = (
    <ol className="flex flex-col gap-1.5 text-[13px]">
      {activity.length === 0 && <li className="text-ink3">Nothing yet.</li>}
      {activity.map(({ e, d }) => {
        // entries about a clip jump to its card
        const cid = (e.payload as { clipId?: string }).clipId;
        const target = cid && sortedClips.some((c) => c.id === cid) ? cid : null;
        return (
          <li key={e.id} className="grid grid-cols-[52px_14px_1fr] gap-1.5">
            <span className="font-mono text-[11px] leading-5 text-ink3">{new Date(e.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span className={`font-mono text-xs leading-5 ${TONE_FG[d.tone]}`}>{TONE_GLYPH[d.tone]}</span>
            {target ? (
              <button
                className="min-w-0 break-words text-left leading-5 hover:text-acc-text"
                onClick={() => {
                  focusCard(target, true);
                  setActOpen(false);
                }}
              >
                {d.text}
              </button>
            ) : (
              <span className="min-w-0 break-words leading-5">{d.text}</span>
            )}
          </li>
        );
      })}
    </ol>
  );

  const activityDock = (
    <div className="relative shrink-0 border-t border-line bg-panel px-4 py-2.5 sm:px-5">
      {actOpen && (
        <div className="absolute inset-x-4 bottom-[calc(100%+8px)] z-30 flex max-h-[50vh] flex-col rounded-[14px] border border-line bg-panel shadow-pop sm:inset-x-5">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <b>Activity</b>
            <span className="text-xs text-ink3">{active ? "updates live" : "history"}</span>
            <button className="ml-auto text-ink2 hover:text-ink" onClick={() => setActOpen(false)} aria-label="Close activity">
              <X className="h-4 w-4" />
            </button>
          </div>
          <ScrollArea className="max-h-[calc(50vh-48px)]">
            <div className="px-4 py-3">{activityList}</div>
          </ScrollArea>
        </div>
      )}
      <button
        onClick={() => setActOpen(!actOpen)}
        aria-expanded={actOpen}
        className={`flex w-full items-center gap-2.5 rounded-full border px-3.5 py-1.5 text-left text-[13px] text-ink ${live.tone === "err" ? "border-err bg-err-soft" : live.tone === "warn" ? "border-warn bg-warn-soft" : "border-line bg-panel hover:bg-sunk"}`}
      >
        <span className={`font-mono font-bold ${TONE_FG[live.tone]}`}>{TONE_GLYPH[live.tone]}</span>
        <span className="min-w-0 flex-1 truncate">{live.text}</span>
        {actOpen ? <ChevronDown className="h-4 w-4 text-ink3" /> : <ChevronUp className="h-4 w-4 text-ink3" />}
      </button>
    </div>
  );

  const clipsList = (
    <>
      {sortedClips.length === 0 && (
        <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <div className="flex gap-1.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="film h-[56px] w-[32px] rounded-[6px] opacity-40" />
            ))}
          </div>
          <b className="mt-1">{active ? "Clips appear here as soon as moments are found" : "No clips found"}</b>
          <span className="text-[13px] text-ink2">
            {active ? "They stream in one by one while the rest render." : "Nothing in this video stood on its own. Try a different focus, or select text in the transcript and make a clip yourself."}
          </span>
          {!active && p.transcript && (
            <button className="btn-ghost mt-1" onClick={() => setConfirm("repick")}>
              Re-pick moments
            </button>
          )}
        </div>
      )}
      <div className="flex flex-col gap-3 p-3">
        {sortedClips.map((c) => (
          <ClipCard
            key={c.id}
            clip={c as ClipView}
            projectId={p.id}
            progress={clipProgress[c.id]}
            active={activeClip === c.id}
            busy={rerender.isPending}
            onRerender={() => rerender.mutateAsync({ id: c.id }).then(invalidate)}
            onSeek={() => {
              seekSource(c.startSec, c.id);
              if (compact) setMtab("transcript");
            }}
            onPlay={() => setPreview(c as ClipView)}
            onCopyLink={() => copyLink({ clip: c.id })}
          />
        ))}
      </div>
    </>
  );

  const drawerHeader = (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
      <b>Clips</b>
      <span className="rounded-full bg-panel px-2 py-px font-mono text-xs">{sortedClips.length}</span>
      {active && sortedClips.length > 0 && <span className="text-xs text-ink3">· streaming in</span>}
      <div className="flex-1" />
      <button className="btn-quiet px-2 py-1" onClick={() => setDrawer(false)} aria-label="Collapse clips" title="Collapse">
        <PanelRightClose className="h-4 w-4" />
      </button>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {alert}
      {compact ? (
        <>
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 py-2">
            {(
              [
                ["transcript", "Transcript"],
                ["clips", `Clips ${sortedClips.length}`],
                ["activity", "Activity"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} onClick={() => setMtab(k)} className={`rounded-full px-3 py-1.5 text-[13px] font-semibold whitespace-nowrap ${mtab === k ? "bg-ink text-bg" : "text-ink2"}`}>
                {l}
              </button>
            ))}
          </div>
          {mtab === "transcript" && (
            <div className="flex min-h-0 flex-1 flex-col">
              {source}
              {transcriptStage ? (
                <TranscriptPanel className="flex-1" projectId={p.id} language={p.transcript?.language ?? null} segments={p.transcript?.segments ?? []} words={p.transcript?.rawWords ?? p.transcript?.words ?? []} flags={p.transcript?.flags ?? []} currentTime={srcTime} clips={sortedClips} onSeek={(t) => seekSource(t)} onLoop={setLoop} deletedFlags={p.transcript?.deletedFlags ?? []} />
              ) : (
                waiting
              )}
            </div>
          )}
          {mtab === "clips" && <ScrollArea className="min-h-0 flex-1 bg-sunk">{clipsList}</ScrollArea>}
          {mtab === "activity" && (
            <ScrollArea className="min-h-0 flex-1">
              <div className="p-4">{activityList}</div>
            </ScrollArea>
          )}
        </>
      ) : (
        <main className="grid min-h-0 flex-1" style={{ gridTemplateColumns: `minmax(0,1fr) ${drawer ? (width < 1100 ? 320 : width < 1280 ? 360 : 400) : 56}px` }}>
          <section className="flex min-h-0 min-w-0 flex-col">
            {source}
            {transcriptStage ? (
              <TranscriptPanel className="flex-1" projectId={p.id} language={p.transcript?.language ?? null} segments={p.transcript?.segments ?? []} words={p.transcript?.rawWords ?? p.transcript?.words ?? []} flags={p.transcript?.flags ?? []} currentTime={srcTime} clips={sortedClips} onSeek={(t) => seekSource(t)} onLoop={setLoop} deletedFlags={p.transcript?.deletedFlags ?? []} />
            ) : (
              waiting
            )}
            {activityDock}
          </section>
          <aside className="flex min-h-0 flex-col border-l border-line bg-sunk">
            {drawer ? (
              <>
                {drawerHeader}
                <ScrollArea className="min-h-0 flex-1">{clipsList}</ScrollArea>
              </>
            ) : (
              <button className="flex flex-col items-center gap-2 py-4 text-xs font-semibold text-ink2 hover:text-ink" onClick={() => setDrawer(true)} title="Show clips">
                <PanelRightOpen className="h-4 w-4" />
                <span className="[writing-mode:vertical-rl]">Clips {sortedClips.length}</span>
              </button>
            )}
          </aside>
        </main>
      )}

      <Dialog.Root open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/60" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[71] flex w-[min(380px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-[18px] border border-line bg-panel p-4 shadow-pop outline-none">
            <div className="flex items-center gap-2">
              <Dialog.Title className="min-w-0 flex-1 truncate font-bold">{preview?.title}</Dialog.Title>
              <Dialog.Close className="text-ink2 hover:text-ink" aria-label="Close">
                <X className="h-4 w-4" />
              </Dialog.Close>
            </div>
            {preview?.videoUrl && <video src={preview.videoUrl} poster={preview.thumbnailUrl ?? undefined} controls autoPlay playsInline className="aspect-[9/16] max-h-[70vh] w-full rounded-[12px] bg-black object-contain" />}
            <div className="flex items-center justify-between text-xs text-ink2">
              <span className="font-mono">
                {preview && `${formatTime(preview.startSec)}–${formatTime(preview.endSec)}`}
              </span>
              {preview && (
                <Link to={`/p/${p.id}/clips/${preview.id}`} className="font-semibold text-acc-text no-underline">
                  Edit clip
                </Link>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={confirm === "repick"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Re-pick moments?"
        body="The clips found so far will be replaced. The transcript and refine results are kept."
        confirm="Replace clips"
        onConfirm={() => reanalyze.mutateAsync({ id }).then(invalidate)}
      />
      <ConfirmDialog
        open={confirm === "refine"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Re-run refine?"
        body="Names, disfluencies and scene changes are detected again. Your accepted and rejected fixes may be replaced."
        confirm="Re-run refine"
        onConfirm={() => refine.mutateAsync({ id }).then(invalidate)}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete this project?"
        body="The source video, transcript and every clip are removed. This can’t be undone."
        confirm="Delete project"
        danger
        onConfirm={() => del.mutateAsync({ id }).then(() => nav("/"))}
      />
    </div>
  );
}
