import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { Check, ChevronDown, ChevronRight, Link2, PanelRightClose, PanelRightOpen, X } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import { useTRPC } from "../lib/trpc";
import { toast } from "sonner";
import { useProjectEvents } from "../lib/projectEvents";
import { describeEvent, groupByRun, reasonLabel, type Tone } from "../lib/activity";
import { summarizeError } from "../lib/errors";
import { writeHash, readHash, linkWith, fmtSec, useHashParams } from "../lib/hash";
import { ProjectPageSkeleton } from "../components/PageSkeletons";
import { ConfirmDialog, MoreButton, ProgressBar, Skeleton, SkeletonRegion } from "../components/ui";
import { NotFound } from "../components/NotFound";
import { ScrollArea } from "../components/scroll-area";
import { ShortcutSheet } from "../components/ShortcutSheet";
import { useShortcut, useShortcuts, useSheetKey } from "../lib/shortcuts";
import { ClipCard, type ClipView } from "../components/ClipCard";
import { ProjectBumpersModal } from "../components/BumperField";
import { TranscriptFileModal } from "../components/TranscriptFileModal";
import { BatchBar } from "../components/BatchBar";
import { TranscriptPanel } from "../components/TranscriptPanel";
import { usePlayback } from "../lib/playback";
import { openReport } from "../lib/report";
import { useMe } from "../lib/account";
import { stageTimes, useNow } from "../lib/timing";
import { formatTime, masksSourceText, type ProjectEvent } from "@reelsaw/shared";

const STAGE_LABEL: Record<string, string> = { ingest: "Preparing source", transcribe: "Transcribe", refine: "Refine", analyze: "Find moments", render: "Render" };
/** How far a live status has got. On failure, prefer `p.stage` via STAGE_REACHED so we don't treat every failure as "past transcription". */
const STAGE_INDEX: Record<string, number> = { queued: -1, ingesting: 0, transcribing: 1, refining: 2, analyzing: 3, rendering: 4, done: 5, failed: 99 };
const STAGE_REACHED: Record<string, number> = { ingest: 0, transcribe: 1, refine: 2, analyze: 3, render: 4 };
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
  const me = useMe();
  const isAdmin = me.data?.role === "admin";
  const q = useQuery(trpc.projects.get.queryOptions({ id }));
  // the words, segments and flags are megabytes on a long source: their own query, refreshed only by transcript changes
  const tq = useQuery(trpc.transcripts.get.queryOptions({ projectId: id }));
  const transcript = tq.data ?? null;
  const retry = useMutation(trpc.projects.retry.mutationOptions());
  const reanalyze = useMutation(trpc.projects.reanalyze.mutationOptions());
  const refine = useMutation(trpc.projects.refine.mutationOptions());
  const del = useMutation(trpc.projects.delete.mutationOptions());
  const restore = useMutation(trpc.projects.restore.mutationOptions());
  const rerender = useMutation(trpc.clips.rerender.mutationOptions());
  const rerenderMany = useMutation(trpc.clips.rerenderMany.mutationOptions());
  const setSourceText = useMutation(trpc.projects.setSourceText.mutationOptions());

  const [log, setLog] = useState<ProjectEvent[]>([]);
  const [progress, setProgress] = useState<{ stage: string; value: number; message?: string } | null>(null);
  const [clipProgress, setClipProgress] = useState<Record<string, number>>({});
  const [activeClip, setActiveClip] = useState<string | null>(null);
  const [srcTime, setSrcTime] = useState(0);
  const [confirm, setConfirm] = useState<null | "repick" | "refine" | "delete">(null);
  const [actOpen, setActOpen] = useState(false);
  const [bumpersOpen, setBumpersOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [drawer, setDrawer] = useState(true);
  const [preview, setPreview] = useState<ClipView | null>(null);
  const [stallDismissed, setStallDismissed] = useState<number | null>(null);
  const width = useWidth();
  const compact = width < 900;
  const [mtab, setMtab] = useState<"transcript" | "clips" | "activity">("transcript");
  const sourceRef = useRef<HTMLVideoElement>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  // one owner for what's audible: Space, the Play button and the transcript's play-in-context share it
  const playback = usePlayback(sourceRef);
  const playing = playback.playing;

  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id }) });

  // The stream replays the newest events, then says how many there are (`events.replayed`); older ones load on request.
  const [replayed, setReplayed] = useState(false);
  const [total, setTotal] = useState(0);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  useProjectEvents(id, {
    list: true,
    onEvent: (evt, live) => {
      setLog((l) => (l.some((e) => e.id === evt.id) ? l : [...l, evt].sort((a, b) => a.id - b.id)));
      if (live) setTotal((n) => n + 1);
    },
    onProgress: (evt) => {
      const p = evt.payload as { stage: string; progress: number; message?: string; clipId?: string };
      setProgress({ stage: p.stage, value: p.progress, message: p.message });
      if (p.clipId) setClipProgress((c) => ({ ...c, [p.clipId!]: p.progress }));
    },
    onReplayed: (m, reconnect) => {
      setReplayed(true);
      setTotal(m.total);
      if (!reconnect) setHasOlder(m.hasMore);
    },
  });
  async function loadOlder() {
    const oldest = log[0]?.id;
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const page = await qc.fetchQuery({ ...trpc.projects.eventsPage.queryOptions({ id, before: oldest, limit: 200 }), staleTime: 0 });
      setLog((l) => {
        const have = new Set(l.map((e) => e.id));
        return [...page.events.filter((e) => !have.has(e.id)), ...l];
      });
      setHasOlder(page.hasMore);
    } catch (err) {
      toast.error(`Couldn’t load older activity: ${(err as Error).message.slice(0, 100)}`);
    } finally {
      setLoadingOlder(false);
    }
  }

  useEffect(() => {
    setLog([]);
    setReplayed(false);
    setTotal(0);
    setHasOlder(false);
    setProgress(null);
    setClipProgress({});
    setActiveClip(null);
  }, [id]);

  const p = q.data;
  const stageIdx = p
    ? p.status === "failed" && p.stage
      ? (STAGE_REACHED[p.stage] ?? -1)
      : (STAGE_INDEX[p.status] ?? -1)
    : -1;
  const active = !!p && ACTIVE.has(p.status);
  const sortedClips = useMemo(() => (p?.clips ?? []).slice().sort((a, b) => a.index - b.index), [p]);
  const readyCount = sortedClips.filter((c) => c.status === "done").length;
  const failedClips = sortedClips.filter((c) => c.status === "failed");

  // wall clock per stage from the events, and what this instance expects from its past projects
  const times = useMemo(() => stageTimes(log), [log]);
  const estimates = p?.estimates ?? null;
  const expectedFor = (stage: string) => estimates?.find((e) => e.stage === stage) ?? null;
  const now = useNow(active);
  // the log grouped by run (newest first); each finished event carries its own duration from the server
  const runGroups = useMemo(
    () =>
      groupByRun(
        log,
        (e) => describeEvent(e, { expectedSec: (stage) => expectedFor(stage)?.expectedSec ?? null, admin: isAdmin }),
        hasOlder,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [log, estimates, hasOlder, isAdmin],
  );
  const activity = useMemo(() => runGroups.flatMap((g) => g.entries), [runGroups]);
  // the latest run is open, older ones collapsed; a click or #run=<seq> overrides
  const [openRuns, setOpenRuns] = useState<Record<number, boolean>>({});
  // the running stage: elapsed so far and what to expect, for the header and the waiting panel
  const eta = (() => {
    if (!p || !active || !p.stage) return null;
    const t = times[p.stage];
    const est = expectedFor(p.stage);
    if (!t && !est) return null;
    const elapsedSec = t ? Math.max(0, (now - t.startedAt) / 1000) : null;
    return { stage: p.stage, elapsedSec, expectedSec: est?.expectedSec ?? null, source: est?.source ?? null, samples: est?.samples ?? 0 };
  })();
  const stalled = useMemo(() => {
    const last = [...log].reverse().find((e) => e.type !== "stage.progress");
    return active && last?.type === "job.stalled" && last.id !== stallDismissed ? last : null;
  }, [log, active, stallDismissed]);

  function seekSource(t: number, clipId?: string) {
    const v = sourceRef.current;
    if (clipId) setActiveClip(clipId);
    if (!v) return;
    playback.stopLoop(); // seeking elsewhere ends play-in-context
    v.currentTime = t;
    v.play().catch(() => {});
  }
  const togglePlay = playback.toggle;

  // ----- deep links: #clip=<id> opens the preview, #card=<id> highlights a card, #t=<sec> seeks the source -----
  const hash = useHashParams();
  const hashClip = hash.get("clip");
  const hashCard = hash.get("card");
  const hashT = hash.get("t");
  const hashRun = Number(hash.get("run")) || null;
  useEffect(() => {
    if (!hashRun) return;
    setOpenRuns((o) => ({ ...o, [hashRun]: true }));
    setActOpen(true);
  }, [hashRun]);
  const clipsLoaded = !!q.data;
  // multi-select for bulk actions; kept in the hash (#sel=id1,id2) so it survives reloads and can be shared
  const [sel, setSel] = useState<string[]>(() => (readHash().get("sel") ?? "").split(",").filter(Boolean));
  useEffect(() => {
    if (!clipsLoaded) return;
    const live = new Set(q.data!.clips.map((x) => x.id));
    setSel((cur) => (cur.every((x) => live.has(x)) ? cur : cur.filter((x) => live.has(x))));
  }, [clipsLoaded, q.data]);
  useEffect(() => {
    if (clipsLoaded) writeHash({ sel: sel.join(",") || null });
  }, [sel, clipsLoaded]);
  const toggleSel = (cid: string) => setSel((cur) => (cur.includes(cid) ? cur.filter((x) => x !== cid) : [...cur, cid]));
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
  // clicking a clip's marker in the transcript: highlight its card, show it, and park the source at its start
  const focusClipFromTranscript = (cid: string) => {
    const c = q.data?.clips.find((x) => x.id === cid);
    if (!c) return;
    focusCard(cid, compact);
    const v = sourceRef.current;
    playback.stopLoop();
    if (v) {
      v.pause();
      v.currentTime = c.startSec;
      setSrcTime(c.startSec);
    }
  };
  const copyLink = (params: Record<string, string>) =>
    navigator.clipboard
      .writeText(linkWith(params))
      .then(() => toast("Link copied"))
      .catch(() => toast.error("Couldn’t copy the link"));
  
  // Space plays / pauses the source video anywhere on the page except while typing
  useShortcut(
    "space",
    (e) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, select")) return; // a focused checkbox keeps Space for itself
      // the clip preview dialog owns Space: it controls the preview video, never the source
      const pv = previewRef.current;
      if (pv) {
        e.preventDefault();
        if (pv.paused) void pv.play().catch(() => {});
        else pv.pause();
        return;
      }
      // any other dialog (confirm, report, ...) keeps Space for itself
      if (el.closest('[role="dialog"]')) return;
      if (!sourceRef.current) return;
      e.preventDefault(); // also stops Space from re-clicking the focused button
      togglePlay(); // pauses / resumes play-in-context too, keeping it armed
    },
    { preventDefault: false },
  );

  useShortcuts("Project page", [["Play / pause the source video", "Space"]]);
  const [keysOpen, setKeysOpen] = useState(false);
  useSheetKey(() => setKeysOpen((o) => !o));

  if (q.isLoading) return <ProjectPageSkeleton compact={compact} width={width} />;
  if (q.error || !p) return <NotFound what="project" error={q.error} onRetry={() => q.refetch()} />;

  const overlays = transcript?.overlays ?? [];
  const presentation = !!transcript?.textProfile?.presentation;
  const masking = overlays.length > 0 && masksSourceText(p.settings.sourceText, transcript?.textProfile);
  const hasCaptions = overlays.some((o) => o.kind === "caption");
  const host = (() => {
    try {
      return p.sourceUrl ? new URL(p.sourceUrl).host.replace(/^www\./, "") : null;
    } catch {
      return null;
    }
  })();
  const activityLoading = !replayed && activity.length === 0;
  const live = activity[0]?.d ?? (active ? { text: "Waiting for the worker…", tone: "run" as Tone } : { text: "No activity yet", tone: "ok" as Tone });
  const dur = p.durationSec ?? 0;

  const fmtRun = (sec: number) => (sec < 60 ? `${Math.round(sec)} s` : formatTime(sec));
  const activityList = (
    <div className="flex flex-col gap-1 text-[13px]">
      {activityLoading && (
        <SkeletonRegion label="Loading activity…" className="flex flex-col gap-1.5">
          <div className="flex h-6 items-center gap-2">
            <Skeleton className="h-3.5 w-3.5" />
            <Skeleton className="h-3.5 w-14 rounded-full" />
            <Skeleton className="h-3.5 w-2/3" />
          </div>
          {["w-4/5", "w-3/5", "w-2/3", "w-1/2", "w-3/4"].map((w, i) => (
            <div key={i} className="grid h-5 grid-cols-[64px_14px_minmax(0,1fr)] items-center gap-2">
              <Skeleton className="ml-auto h-3 w-11" />
              <Skeleton className="h-3 w-3 rounded-full" />
              <Skeleton className={`h-3.5 ${w}`} />
            </div>
          ))}
        </SkeletonRegion>
      )}
      {!activityLoading && runGroups.length === 0 && <p className="text-ink3">Nothing yet.</p>}
      {runGroups.map((g, i) => {
        const open = openRuns[g.seq] ?? i === 0;
        const dur = g.outcome === "running" ? `running ${formatTime(Math.max(0, (now - g.startedAt) / 1000))}` : g.runSec !== null ? `${g.outcome === "failed" ? "failed after" : "done in"} ${fmtRun(g.runSec)}` : g.outcome;
        const why = reasonLabel(g.reason);
        const label = [g.continued ? `… Run ${g.seq || ""}`.trim() : `Run ${g.seq}`, why ? why[0]!.toUpperCase() + why.slice(1) : null, dur, new Date(g.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })].filter(Boolean).join(" · ");
        const tone: Tone = g.outcome === "running" ? "run" : g.outcome === "failed" ? "err" : "ok";
        return (
          <section key={g.seq} id={`run-${g.seq}`}>
            <button
              className="flex h-6 w-full items-center gap-2 rounded-[6px] text-left hover:text-acc-text"
              aria-expanded={open}
              onClick={() => {
                setOpenRuns((o) => ({ ...o, [g.seq]: !open }));
                writeHash({ run: open ? null : g.seq });
              }}
            >
              <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-ink3 ${open ? "rotate-90" : ""}`} />
              <ToneGlyph tone={tone} />
              <b className="min-w-0 flex-1 truncate font-semibold leading-5" title={label}>
                {label}
              </b>
              <span className="shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-ink3">
                {g.entries.length} event{g.entries.length === 1 ? "" : "s"}
              </span>
            </button>
            {open && (
              <ol className="mt-1.5 flex flex-col gap-1.5 pb-2">
                {g.entries.map(({ e, d }) => {
                  // entries about a clip jump to its card
                  const cid = (e.payload as { clipId?: string }).clipId;
                  const target = cid && sortedClips.some((c) => c.id === cid) ? cid : null;
                  return (
                    <li key={e.id} className="grid h-5 grid-cols-[64px_14px_minmax(0,1fr)] items-center gap-2" title={d.text}>
                      <span className="whitespace-nowrap text-right font-mono text-[11px] tabular-nums leading-5 text-ink3">{new Date(e.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                      <ToneGlyph tone={d.tone} />
                      {target ? (
                        <button
                          className="min-w-0 truncate text-left leading-5 hover:text-acc-text"
                          onClick={() => {
                            focusCard(target, true);
                            setActOpen(false);
                          }}
                        >
                          {d.text}
                        </button>
                      ) : (
                        <span className="min-w-0 truncate leading-5">{d.text}</span>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        );
      })}
      {replayed && (hasOlder || total > log.length) && (
        <div className="flex h-8 items-center justify-between gap-2 pt-1 text-xs text-ink3">
          <span className="tabular-nums">
            Showing the last {log.length.toLocaleString()} of {Math.max(total, log.length).toLocaleString()} events
          </span>
          {hasOlder && (
            <button className="btn-quiet px-2 py-1 text-xs" disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? "Loading…" : "Load older"}
            </button>
          )}
        </div>
      )}
    </div>
  );

  // latest status line in the header; the full feed opens in a popover below it
  const activityTrigger = (
    <Popover.Root open={actOpen} onOpenChange={setActOpen}>
      <Popover.Trigger asChild>
        <button
          className={`inline-flex min-w-0 max-w-[420px] items-center gap-2 rounded-[6px] text-left hover:text-ink ${live.tone === "err" ? "text-err" : live.tone === "warn" ? "text-warn" : live.tone === "ok" && !active ? "font-semibold text-ok" : "text-ink2"}`}
          title="Activity"
        >
          {activityLoading ? (
            <span className="flex h-5 items-center gap-2" role="status">
              <span className="sr-only">Loading activity…</span>
              <Skeleton className="h-3 w-3 rounded-full" />
              <Skeleton className="h-3.5 w-40" />
            </span>
          ) : (
            <>
              <ToneGlyph tone={live.tone} />
              <span className="min-w-0 truncate leading-5">{live.text}</span>
            </>
          )}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          // line the feed's glyph column up under the status line's glyph: padding 16 + time 64 + gap 8
          alignOffset={-88}
          sideOffset={8}
          onOpenAutoFocus={(e) => e.preventDefault()} // don't ring the first entry on open
          collisionPadding={12}
          className="z-50 flex max-h-[min(60dvh,var(--radix-popover-content-available-height))] w-[min(460px,calc(100vw-24px))] flex-col rounded-[14px] border border-line bg-panel shadow-pop"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
            <b>Activity</b>
            <span className="text-xs text-ink3">{active ? "updates live" : "history"}</span>
            {sortedClips.length > 0 && (
              <span className={`ml-auto text-xs ${readyCount === sortedClips.length ? "font-semibold text-ok" : "text-ink2"}`}>
                {readyCount} of {sortedClips.length} clips ready
              </span>
            )}
          </div>
          <ScrollArea className="max-h-[min(calc(60dvh-46px),calc(var(--radix-popover-content-available-height)-46px))]">
            <div className="px-4 py-3">{activityList}</div>
          </ScrollArea>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );

  const header = (
    <div className={`flex shrink-0 items-center border-b border-line px-4 sm:px-5 ${compact ? "flex-nowrap gap-3 py-2.5" : "flex-wrap gap-x-5 gap-y-3 py-3.5"}`}>
      <div className="min-w-0 flex-[1_1_320px]">
        <div className={`gap-1.5 text-xs text-ink3 ${compact ? "hidden" : "flex"}`}>
          <Link to="/" className="text-ink3 no-underline hover:text-ink">
            Projects
          </Link>
          <span>/</span>
          <span className="truncate">{p.title}</span>
        </div>
        <h1 className={`mt-0.5 font-bold leading-tight tracking-tight [text-wrap:pretty] ${compact ? "line-clamp-2 text-base" : "text-xl"}`}>{p.title}</h1>
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
          {activityTrigger}
          {eta && (
            <span
              className="inline-block min-w-[104px] font-mono text-xs tabular-nums leading-5 text-ink3"
              title={`${STAGE_LABEL[eta.stage] ?? eta.stage}: elapsed${eta.expectedSec !== null ? ` / expected, ${eta.source === "history" ? `from ${eta.samples} finished project${eta.samples === 1 ? "" : "s"} with these models` : "default until a project finishes with these models"}` : ""}`}
            >
              {eta.elapsedSec !== null ? formatTime(eta.elapsedSec) : "–:––"}
              {eta.expectedSec !== null ? ` / ~${formatTime(eta.expectedSec)}` : ""}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {readyCount > 0 ? (
          <a className="btn-primary py-2 no-underline" href={`/api/projects/${p.id}/export.zip`} download title="Zip of every rendered clip with YouTube / TikTok metadata, paste-ready text and a manifest">
            Export{compact ? "" : ` ${readyCount} clip${readyCount === 1 ? "" : "s"}`}
          </a>
        ) : (
          <button className="btn-primary py-2" disabled>
            Export
          </button>
        )}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <MoreButton size="md" aria-label="Project actions" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className="menu w-[270px]">
              {failedClips.length > 0 && (
                <DropdownMenu.Item className="menu-item block" onSelect={() => rerenderMany.mutateAsync({ projectId: id, clipIds: failedClips.map((c) => c.id) }).then((r) => (invalidate(), toast(`Retrying ${r.rerendered} failed clip${r.rerendered === 1 ? "" : "s"}`)))}>
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
              <DropdownMenu.Item className="menu-item block" onSelect={() => setBumpersOpen(true)}>
                Intro and outro
                <div className="text-xs text-ink3">Default, none or a library item</div>
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item block" onSelect={() => setFilesOpen(true)}>
                Transcript files…
                <div className="text-xs text-ink3">Download or import SRT / VTT</div>
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item block" onSelect={() => openReport({ projectId: p.id, projectTitle: p.title, clipId: activeClip ?? undefined })}>
                Report an issue…
                <div className="text-xs text-ink3">Send the project's data and logs</div>
              </DropdownMenu.Item>
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

  const fail = p.status === "failed" && p.error ? summarizeError(p.error, { admin: isAdmin }) : null;
  const failStage = STAGE_LABEL[p.stage ?? ""] ?? "Processing";
  const alert =
    fail ? (
      <div role="alert" className="mx-4 mt-3 flex shrink-0 flex-wrap items-start gap-3 rounded-[14px] border border-err/50 bg-err-soft px-4 py-3 sm:mx-5">
        <span className="mt-0.5 font-mono text-sm leading-none text-err" aria-hidden>
          ▲
        </span>
        <div className="min-w-0 flex-[1_1_280px]">
          <b className="text-[15px]">{failStage} failed</b>
          <p className="mt-0.5 text-[13px] leading-snug text-ink2">{fail.summary}</p>
          {fail.detail && (
            <details className="mt-1.5">
              <summary className="cursor-pointer select-none text-xs font-semibold text-ink3 hover:text-ink">Technical details</summary>
              <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-sunk/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink3">{fail.detail}</pre>
            </details>
          )}
          <p className="mt-1.5 text-xs text-ink3">Earlier results are kept. Retry picks up from this step.</p>
        </div>
        <button className="btn-ink shrink-0" disabled={retry.isPending} onClick={() => retry.mutateAsync({ id }).then(invalidate)}>
          ↻ Retry
        </button>
      </div>
    ) : stalled ? (
      <div role="alert" className="mx-4 mt-3 flex shrink-0 flex-wrap items-start gap-3 rounded-[14px] border border-warn/50 bg-warn-soft px-4 py-3 sm:mx-5">
        <span className="mt-0.5 font-mono text-sm leading-none text-warn" aria-hidden>
          ◷
        </span>
        <div className="min-w-0 flex-[1_1_280px] text-[13px]">
          <b>No progress for {String((stalled.payload as { idleMinutes?: number }).idleMinutes ?? "a while")} min.</b> {String((stalled.payload as { hint?: string }).hint ?? "Slow local models can do this on long videos, or the worker may have stopped.")}
        </div>
        <button className="btn-ghost" onClick={() => setStallDismissed(stalled.id)}>
          Keep waiting
        </button>
        <button className="btn-ink shrink-0" onClick={() => retry.mutateAsync({ id }).then(invalidate)}>
          ↻ Restart this step
        </button>
      </div>
    ) : null;

  // burned-in / slide text notice: beside the source on desktop, in the Activity tab on phones
  const textNotice = (overlays.length > 0 || presentation) && (
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-[10px] bg-acc-soft px-2.5 py-1.5 text-xs text-ink2">
            <span className="rounded-[4px] bg-panel px-1.5 py-px font-mono text-[10px] text-ink">{presentation ? "SLIDES" : hasCaptions ? "CC" : "TXT"}</span>
            <span className={`min-w-0 flex-[1_1_160px] text-ink ${compact ? "truncate" : ""}`}>
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
  );
  const pct = (t: number) => `${dur ? (t / dur) * 100 : 0}%`;
  const source = (
    <div className={`flex shrink-0 px-4 sm:px-5 ${compact ? "items-center gap-3 py-2.5" : "flex-wrap items-center gap-4 py-3.5"}`}>
      <div className={`film relative shrink-0 overflow-hidden rounded-[12px] ${compact ? "aspect-video w-[44%]" : "aspect-video h-[clamp(110px,24dvh,214px)]"}`}>
        {p.sourceVideoUrl && (
          <video
            ref={sourceRef}
            src={p.sourceVideoUrl}
            poster={(p.sourceMeta?.thumbnail as string | undefined) ?? undefined}
            preload="metadata"
            playsInline
            className="absolute inset-0 h-full w-full bg-black object-contain"
            onTimeUpdate={(e) => setSrcTime(e.currentTarget.currentTime)}
            {...playback.videoProps}
            onClick={togglePlay}
          />
        )}
        {p.sourceVideoUrl ? (
          !playing && (
            <button onClick={togglePlay} aria-label="Play" className="absolute left-1/2 top-1/2 grid h-12 w-12 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white/90 text-film-ink shadow-pop">
              ▶
            </button>
          )
        ) : (
          <span className="absolute inset-0 grid place-items-center px-3 text-center font-mono text-[11px] text-film-text">
            {active ? (
              progress?.message ?? (p.sourceType === "upload" ? "preparing upload…" : "downloading…")
            ) : p.sourceExpiredAt ? (
              <button type="button" className="btn-ghost text-xs" disabled={retry.isPending} onClick={() => retry.mutateAsync({ id }).then(invalidate)} title={`Removed on ${new Date(p.sourceExpiredAt).toLocaleDateString()} to free space`}>
                Source removed · fetch again
              </button>
            ) : p.status === "failed" ? (
              "Source unavailable"
            ) : (
              "No source video"
            )}
          </span>
        )}
      </div>
      <div className={`flex min-w-0 flex-col justify-center ${compact ? "flex-1 gap-1.5" : "flex-[1_1_240px] gap-2.5"}`}>
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
        {!compact && textNotice}
      </div>
    </div>
  );

  const transcriptSkeleton = (
    <SkeletonRegion label="Loading transcript…" className="flex min-h-0 flex-1 flex-col gap-2.5 border-t border-line px-5 py-6">
      {[92, 78, 85, 60, 88, 70, 80, 66].map((w, i) => (
        <div key={i} className="flex gap-2.5">
          <Skeleton className="h-3.5 w-10" />
          <Skeleton className="h-3.5" />
        </div>
      ))}
    </SkeletonRegion>
  );
  const transcriptStage = stageIdx >= 2 || p.status === "done" || !!p.transcript;
  const transcribePct = Math.round((progress?.stage === "transcribe" ? progress.value : (p.stageProgress ?? 0)) * 100);
  const waitingHeading =
    p.status === "failed"
      ? "Stopped before the transcript"
      : stageIdx <= 0
        ? (progress?.message ?? (p.sourceType === "upload" ? "Preparing your upload…" : "Downloading…"))
        : `Transcribing… ${transcribePct}%`;
  const waiting = (
    <div className="flex min-h-0 flex-1 items-start justify-center border-t border-line px-5 py-10">
      <div className="flex w-full max-w-[560px] flex-col gap-3">
        <b className="text-base">{waitingHeading}</b>
        <span className="text-[13px] leading-relaxed text-ink2">
          {p.status === "failed"
            ? "Retry from the notice above when you’re ready. The transcript will show up here after transcription finishes."
            : "The transcript appears here when transcription finishes. Fixes, then clips, follow. You can leave; this keeps running on the server."}
        </span>
        {p.status !== "failed" && (
          <>
            <ProgressBar value={progress?.value ?? p.stageProgress ?? 0} />
            <div className="flex h-5 justify-between font-mono text-xs tabular-nums leading-5 text-ink3">
              <span>{eta?.elapsedSec !== null && eta?.elapsedSec !== undefined ? `${formatTime(eta.elapsedSec)} elapsed` : ""}</span>
              <span>{eta?.expectedSec !== null && eta?.expectedSec !== undefined ? `~${formatTime(eta.expectedSec)} expected${eta.source === "history" ? ` · from ${eta.samples} project${eta.samples === 1 ? "" : "s"}` : " · estimate"}` : stageIdx <= 0 ? "" : "expected time known after the source is ready"}</span>
            </div>
            {[92, 78, 85, 60, 88, 70].map((w, i) => (
              <div key={i} className="flex gap-2.5">
                <div className="h-3.5 w-10 rounded-full bg-sunk" />
                <div className="h-3.5 rounded-full bg-sunk" style={{ width: `${w}%` }} />
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
  // built once: the phone and desktop layouts share one element
  const transcriptBody = transcriptStage ? tq.isLoading ? transcriptSkeleton : (
    <TranscriptPanel className="flex-1" projectId={p.id} language={transcript?.language ?? p.transcript?.language ?? null} segments={transcript?.segments ?? []} words={transcript?.rawWords ?? transcript?.words ?? []} flags={transcript?.flags ?? []} currentTime={srcTime} clips={sortedClips} onSeek={(t) => seekSource(t)} playback={playback} deletedFlags={transcript?.deletedFlags ?? []} activeClipId={activeClip} onFocusClip={focusClipFromTranscript} onPlayClip={(cid) => { const c = sortedClips.find((x) => x.id === cid); if (c) setPreview(c as ClipView); }} />
  ) : (
    waiting
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
          <b className="mt-1">
            {active ? "Clips appear here as soon as moments are found" : p.status === "failed" && !p.transcript ? "No clips yet" : "No clips found"}
          </b>
          <span className="text-[13px] text-ink2">
            {active
              ? "They stream in one by one while the rest render."
              : p.status === "failed" && !p.transcript
                ? "Clips appear after the source is prepared and moments are found."
                : "Nothing in this video stood on its own. Try a different focus, or select text in the transcript and make a clip yourself."}
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
            projectIntroId={p.settings.introAssetId}
            projectOutroId={p.settings.outroAssetId}
            selected={sel.includes(c.id)}
            selecting={sel.length > 0}
            onToggleSelect={() => toggleSel(c.id)}
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
      {sel.length > 0 && (
        <BatchBar
          projectId={p.id}
          selected={sortedClips.filter((c) => sel.includes(c.id))}
          introId={p.settings.introAssetId}
          outroId={p.settings.outroAssetId}
          onClear={() => setSel([])}
          onChanged={invalidate}
        />
      )}
    </>
  );

  /** Sticky above the list: the count, the selection controls (fixed widths, so nothing moves as the count changes) and, in the drawer, the collapse toggle. */
  const clipsHeader = (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
      {!compact && <b>Clips</b>}
      <span className="rounded-full bg-panel px-2 py-px font-mono text-xs" title={active && sortedClips.length > 0 ? "More clips are streaming in" : undefined}>
        {sortedClips.length}
      </span>
      <div className="flex-1" />
      {sortedClips.length > 1 && (
        <div className="flex items-center gap-2.5 text-xs">
          <button className="font-semibold text-acc-text disabled:opacity-50" disabled={sel.length === sortedClips.length} onClick={() => setSel(sortedClips.map((c) => c.id))}>
            Select all
          </button>
          <button className="font-semibold text-acc-text disabled:opacity-50" disabled={!sel.length} onClick={() => setSel([])}>
            Clear
          </button>
          <span className={`inline-flex h-6 w-[3.25rem] items-center justify-center gap-1 rounded-full bg-acc-soft font-mono tabular-nums text-acc-text ${sel.length ? "" : "invisible"}`} title={`${sel.length} selected`} aria-label={`${sel.length} selected`}>
            <Check className="h-3 w-3" aria-hidden />
            {sel.length}
          </span>
        </div>
      )}
      {!compact && (
        <button className="btn-quiet px-2 py-1" onClick={() => setDrawer(false)} aria-label="Collapse clips" title="Collapse">
          <PanelRightClose className="h-4 w-4" />
        </button>
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {/* overlaid under the header: a banner arriving mid-session must not push the source and transcript down */}
      <div className="relative z-20 h-0 shrink-0">
        <div className="absolute inset-x-0 top-0">{alert}</div>
      </div>
      {compact ? (
        <>
          <ScrollArea className="shrink-0 border-b border-line">
          <div className="flex w-max gap-1 px-3 py-2">
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
          </ScrollArea>
          {mtab === "transcript" && (
            <div className="flex min-h-0 flex-1 flex-col">
              {source}
              {transcriptBody}
            </div>
          )}
          {mtab === "clips" && (
            <div className="flex min-h-0 flex-1 flex-col bg-sunk">
              {clipsHeader}
              <ScrollArea className="min-h-0 flex-1">{clipsList}</ScrollArea>
            </div>
          )}
          {mtab === "activity" && textNotice && <div className="shrink-0 px-4 pt-3">{textNotice}</div>}
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
            {transcriptBody}
          </section>
          <aside className="flex min-h-0 flex-col border-l border-line bg-sunk">
            {drawer ? (
              <>
                {clipsHeader}
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
            {preview?.videoUrl && <video ref={previewRef} src={preview.videoUrl} poster={preview.thumbnailUrl ?? undefined} controls autoPlay playsInline className="aspect-[9/16] max-h-[70dvh] w-full rounded-[12px] bg-black object-contain" />}
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

      <ShortcutSheet open={keysOpen} onOpenChange={setKeysOpen} />
      <ConfirmDialog
        open={confirm === "repick"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Re-pick moments?"
        body="The AI picks you haven’t touched are replaced. Clips you made or edited stay, and the transcript and refine results are kept."
        confirm="Replace clips"
        onConfirm={() =>
          reanalyze.mutateAsync({ id }).then((r) => {
            invalidate();
            if (r.kept) toast(`Kept ${r.kept} clip${r.kept === 1 ? "" : "s"} you made or edited`);
          })
        }
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
        body="The project, its transcript and every clip are removed. Work in progress stops. You can undo this for a few days."
        confirm="Delete project"
        danger
        onConfirm={() =>
          del.mutateAsync({ id }).then((r) => {
            nav("/"); // leave first, so this page never refetches the project it just deleted
            void qc.invalidateQueries({ queryKey: trpc.projects.pathKey() });
            const title = q.data?.title ?? "Project";
            toast(`Deleted ${title}`, {
              description: `Restorable ${r.restorable}`,
              duration: 8000,
              action: { label: "Undo", onClick: () => void restore.mutateAsync({ id }).then(() => (void qc.invalidateQueries({ queryKey: trpc.projects.pathKey() }), nav(`/p/${id}`)), (err: Error) => toast.error(err.message.slice(0, 120))) },
            });
          })
        }
      />
      <TranscriptFileModal
        open={filesOpen}
        onOpenChange={setFilesOpen}
        projectId={p.id}
        hasTranscript={!!p.transcript}
        canImport={["done", "failed", "queued", "ingesting"].includes(p.status)}
        whyNot={`The project is ${p.status} right now. Import a transcript when it is done or failed, or right after you create it.`}
      />
      <ProjectBumpersModal open={bumpersOpen} onOpenChange={setBumpersOpen} projectId={p.id} clipCount={readyCount} introId={p.settings.introAssetId} outroId={p.settings.outroAssetId} introSec={p.settings.introSec} outroSec={p.settings.outroSec} />
    </div>
  );
}

/** status glyph centred in a fixed box, so it lines up with the text beside it whatever the glyph */
function ToneGlyph({ tone }: { tone: Tone }) {
  return <span className={`inline-grid h-5 w-3.5 shrink-0 place-items-center font-mono text-[11px] leading-none ${TONE_FG[tone]}`}>{TONE_GLYPH[tone]}</span>;
}
