import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSubscription } from "@trpc/tanstack-react-query";
import { useNavigate, useParams } from "react-router";
import { RefreshCw, Trash2, AlertTriangle, Sparkles, Check, Loader2, Film, Wand2, MoreHorizontal, PackageOpen } from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useTRPC } from "../lib/trpc";
import { StatusBadge, ProgressBar } from "../components/ui";
import { ScrollArea } from "../components/scroll-area";
import { ClipEditor } from "../components/ClipEditor";
import { ClipCard } from "../components/ClipCard";
import { TranscriptPanel } from "../components/TranscriptPanel";
import { formatTime, PIPELINE_STAGES, type ProjectEvent } from "@reelsaw/shared";

const STAGE_LABEL: Record<string, string> = { ingest: "Download", transcribe: "Transcribe", refine: "Refine", analyze: "Find moments", render: "Render" };
const STAGE_INDEX: Record<string, number> = { queued: -1, ingesting: 0, transcribing: 1, refining: 2, analyzing: 3, rendering: 4, done: 5, failed: 99 };
const REFINE_LABEL: Record<string, string> = { entities: "names", disfluency: "disfluencies", scenes: "scenes" };
const ACTIVE = new Set(["queued", "ingesting", "transcribing", "refining", "analyzing", "rendering"]);

export function ProjectPage() {
  const { id = "" } = useParams();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery(trpc.projects.get.queryOptions({ id }));
  const retry = useMutation(trpc.projects.retry.mutationOptions());
  const reanalyze = useMutation(trpc.projects.reanalyze.mutationOptions());
  const refine = useMutation(trpc.projects.refine.mutationOptions());
  const del = useMutation(trpc.projects.delete.mutationOptions());
  const rerender = useMutation(trpc.clips.rerender.mutationOptions());

  const [log, setLog] = useState<ProjectEvent[]>([]);
  const [progress, setProgress] = useState<{ stage: string; value: number; message?: string } | null>(null);
  const [clipProgress, setClipProgress] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [activeClip, setActiveClip] = useState<string | null>(null);
  const [srcTime, setSrcTime] = useState(0);
  const sourceRef = useRef<HTMLVideoElement>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id }) });

  useSubscription(
    trpc.projects.events.subscriptionOptions(
      { id },
      {
        onData: (envelope) => {
          const evt = envelope.data;
          setLog((l) => (l.some((e) => e.id === evt.id) ? l : [...l.slice(-199), evt]));
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

  function seekSource(t: number, clipId?: string) {
    const v = sourceRef.current;
    if (!v) return;
    v.currentTime = t;
    v.play().catch(() => {});
    if (clipId) setActiveClip(clipId);
  }

  const readyCount = sortedClips.filter((c) => c.status === "done").length;

  if (q.isLoading) return <p className="text-muted">Loading…</p>;
  if (q.error || !p) return <p className="text-danger">{q.error?.message ?? "Not found"}</p>;

  return (
    <div className="space-y-3">
      {/* header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold leading-tight">{p.title}</h1>
          <p className="truncate text-xs text-muted">
            {p.sourceType === "url" ? (
              <a href={p.sourceUrl ?? "#"} target="_blank" rel="noreferrer" className="hover:underline">
                {p.sourceUrl}
              </a>
            ) : (
              "Uploaded file"
            )}
            {p.durationSec ? ` · ${formatTime(p.durationSec)}` : ""}
            {p.width && p.height ? ` · ${p.width}×${p.height}` : ""}
            {` · ${p.settings.maxClips ? `up to ${p.settings.maxClips}` : "auto"} clips, ${p.settings.minClipSeconds}–${p.settings.maxClipSeconds}s, ${p.settings.captions} captions`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge status={p.status} />
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="btn-ghost px-2" title="Project actions" aria-label="Project actions">
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className="z-50 min-w-48 rounded-md border border-border bg-panel p-1 text-sm shadow-xl outline-none">
                {(p.status === "failed" || p.status === "done") && (
                  <DropdownMenu.Item className="menu-item" disabled={retry.isPending} onSelect={() => retry.mutateAsync({ id }).then(invalidate)}>
                    <RefreshCw className="h-4 w-4" /> Retry
                    <span className="menu-hint">resume from last stage</span>
                  </DropdownMenu.Item>
                )}
                {p.transcript && !active && (
                  <DropdownMenu.Item className="menu-item" disabled={refine.isPending} onSelect={() => refine.mutateAsync({ id }).then(invalidate)}>
                    <Wand2 className="h-4 w-4" /> Re-run refine
                    <span className="menu-hint">names, disfluencies, scenes</span>
                  </DropdownMenu.Item>
                )}
                {p.transcript && !active && (
                  <DropdownMenu.Item
                    className="menu-item"
                    disabled={reanalyze.isPending}
                    onSelect={() => {
                      if (window.confirm("Discard the current clips and pick new moments?")) reanalyze.mutateAsync({ id }).then(invalidate);
                    }}
                  >
                    <Sparkles className="h-4 w-4" /> Re-analyze
                    <span className="menu-hint">pick new moments</span>
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item
                  className="menu-item text-danger data-[highlighted]:bg-danger/10"
                  disabled={del.isPending}
                  onSelect={() => {
                    if (window.confirm("Delete this project and all its clips?")) del.mutateAsync({ id }).then(() => nav("/"));
                  }}
                >
                  <Trash2 className="h-4 w-4" /> Delete project
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>

      {/* pipeline */}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 text-xs">
        {PIPELINE_STAGES.map((stage, i) => {
          const state = p.status === "failed" && p.stage === stage ? "failed" : i < stageIdx || p.status === "done" ? "done" : i === stageIdx ? "active" : "todo";
          const cls =
            state === "active" ? "border-accent/60 bg-accent/5 text-text" : state === "failed" ? "border-danger/60 text-danger" : state === "done" ? "border-border text-text" : "border-border/60 text-muted";
          return (
            <div key={stage} className="flex items-center gap-1">
              {i > 0 && <span className="mx-0.5 text-muted/50">›</span>}
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${cls}`}>
                {state === "done" && <Check className="h-3 w-3 text-ok" />}
                {state === "active" && <Loader2 className="h-3 w-3 animate-spin text-accent" />}
                {state === "failed" && <AlertTriangle className="h-3 w-3 text-danger" />}
                {STAGE_LABEL[stage]}
                {stage === "refine" &&
                  (state === "active" || state === "done") &&
                  (["entities", "disfluency", "scenes"] as const).map((step) => {
                    const st = refineState[step];
                    const sub = st === "done" ? "bg-ok/15 text-ok" : st === "failed" ? "bg-danger/15 text-danger" : st === "running" ? "bg-accent/15 text-accent" : "bg-panel-2 text-muted";
                    return (
                      <span key={step} className={`rounded px-1 py-px text-[10px] leading-none ${sub}`} title={`${step}: ${st ?? "waiting"}`}>
                        {st === "running" && <Loader2 className="mr-0.5 inline h-2.5 w-2.5 animate-spin" />}
                        {REFINE_LABEL[step]}
                      </span>
                    );
                  })}
                {state === "active" && stage !== "refine" && (
                  <span className="ml-1 inline-flex items-center gap-1.5">
                    <span className="w-16">
                      <ProgressBar value={progress?.stage === stage ? progress.value : (p.stageProgress ?? 0)} />
                    </span>
                    {progress?.stage === stage && progress.message && <span className="max-w-48 truncate text-muted">{progress.message}</span>}
                  </span>
                )}
              </span>
            </div>
          );
        })}
        {sortedClips.length > 0 && (
          <span className="ml-auto flex items-center gap-2 text-muted">
            {readyCount}/{sortedClips.length} clips ready
            {readyCount > 0 && (
              <a className="btn-ghost px-2 py-1 text-xs" href={`/api/projects/${p.id}/export.zip`} download title="Zip of every rendered clip with YouTube / TikTok metadata, paste-ready text and a manifest">
                <PackageOpen className="h-3.5 w-3.5" /> Export all
              </a>
            )}
          </span>
        )}
      </div>
      {p.error && (
        <p className="flex items-start gap-2 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {p.error}
        </p>
      )}

      {/* workspace */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* left: source + transcript */}
        <div className="space-y-3 lg:sticky lg:top-0 lg:self-start">
          <div className="card overflow-hidden">
            {p.sourceVideoUrl ? (
              <video
                ref={sourceRef}
                src={p.sourceVideoUrl}
                poster={(p.sourceMeta?.thumbnail as string | undefined) ?? undefined}
                controls
                preload="metadata"
                playsInline
                className="aspect-video w-full bg-black"
                onTimeUpdate={(e) => setSrcTime(e.currentTarget.currentTime)}
              />
            ) : (
              <div className="flex aspect-video items-center justify-center text-muted">
                <Film className="h-8 w-8" />
              </div>
            )}
          </div>
          <TranscriptPanel
            projectId={p.id}
            language={p.transcript?.language ?? null}
            segments={p.transcript?.segments ?? []}
            words={p.transcript?.rawWords ?? p.transcript?.words ?? []}
            flags={p.transcript?.flags ?? []}
            currentTime={srcTime}
            clips={sortedClips}
            onSeek={(t) => seekSource(t)}
          />
        </div>

        {/* right: clips */}
        <div className="space-y-3">
          {sortedClips.length === 0 && (
            <div className="card flex items-center gap-3 p-6 text-sm text-muted">
              {active ? <Loader2 className="h-4 w-4 animate-spin text-accent" /> : <Film className="h-4 w-4" />}
              {active ? "Clips appear here as soon as the AI picks moments." : "No clips yet."}
            </div>
          )}
          {sortedClips.map((c) => (
            <ClipCard
              key={c.id}
              clip={c}
              progress={clipProgress[c.id]}
              active={activeClip === c.id}
              busy={rerender.isPending}
              onEdit={() => setEditing(c.id)}
              onRerender={() => rerender.mutateAsync({ id: c.id }).then(invalidate)}
              onSeek={() => seekSource(c.startSec, c.id)}
            />
          ))}

          <details className="card p-3" open={active}>
            <summary className="cursor-pointer text-sm font-semibold">Activity</summary>
            <ScrollArea className="mt-2 h-56">
              <ul className="space-y-1 pr-3 font-mono text-xs text-muted">
                {log.length === 0 && <li>Waiting for events…</li>}
                {log
                  .slice()
                  .reverse()
                  .map((e) => (
                    <li key={e.id}>
                      <span className="text-muted/60">{new Date(e.createdAt).toLocaleTimeString()}</span> <span className="text-text">{e.type}</span> {describe(e)}
                    </li>
                  ))}
              </ul>
            </ScrollArea>
          </details>
        </div>
      </div>

      {(() => {
        const clip = editing ? sortedClips.find((c) => c.id === editing) : undefined;
        if (!clip || !p.transcript || !p.sourceVideoUrl) return null;
        return (
          <ClipEditor
            key={clip.id}
            projectId={p.id}
            sourceVideoUrl={p.sourceVideoUrl}
            durationSec={p.durationSec ?? 0}
            srcW={p.width ?? 1920}
            srcH={p.height ?? 1080}
            settings={p.settings}
            words={p.transcript.words}
            sceneCuts={p.transcript.sceneCuts ?? []}
            clip={clip}
            onClose={() => setEditing(null)}
          />
        );
      })()}
    </div>
  );
}

function describe(e: ProjectEvent): string {
  const p = e.payload as Record<string, unknown>;
  if (e.type === "stage.progress") return `${p.stage} ${Math.round(Number(p.progress) * 100)}% ${p.message ?? ""}`;
  if (e.type === "stage.failed") return `${p.stage}: ${p.error} (attempt ${p.attempt}/${p.max})`;
  if (e.type === "project.failed") return String(p.error ?? "");
  if (e.type === "clip.created") return String(p.title ?? "");
  if (e.type === "clip.failed") return String(p.error ?? "");
  return Object.entries(p)
    .filter(([k]) => !["clipId"].includes(k))
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" ");
}
