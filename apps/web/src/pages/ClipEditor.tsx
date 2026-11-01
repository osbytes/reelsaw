import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useProjectEvents } from "../lib/projectEvents";
import { Link, useNavigate, useParams } from "react-router";
import { useTRPC } from "../lib/trpc";
import { ClipEditor, type EditorClip } from "../components/ClipEditor";
import { NotFound } from "../components/NotFound";
import { ClipEditorSkeleton } from "../components/PageSkeletons";
import { LiveStatusPill } from "../components/LiveStatusPill";
import { masksSourceText } from "@reelsaw/shared";

/** Full-screen editor route: /p/:id/clips/:clipId. Live render progress comes from the project's event stream. */
export function ClipEditorPage() {
  const { id = "", clipId = "" } = useParams();
  const trpc = useTRPC();
  const nav = useNavigate();
  const q = useQuery(trpc.projects.get.queryOptions({ id }));
  const tq = useQuery(trpc.transcripts.get.queryOptions({ projectId: id }));
  const t = tq.data;
  const [progress, setProgress] = useState<number | undefined>(undefined);

  // render progress of this clip; the stream also keeps the project and transcript queries current
  const { status: stream } = useProjectEvents(id, {
    onProgress: (evt) => {
      const p = evt.payload as { clipId?: string; progress?: number };
      if (p.clipId === clipId && typeof p.progress === "number") setProgress(p.progress);
    },
  });

  const p = q.data;
  const clip = p?.clips.find((c) => c.id === clipId);
  if (q.isLoading || (tq.isLoading && !!q.data?.transcript)) return <ClipEditorSkeleton />;
  if (!p) return <NotFound what="project" error={q.error} onRetry={() => q.refetch()} />;
  if (!clip)
    return (
      <div className="flex min-h-0 flex-1 items-start justify-center px-5 py-16">
        <div className="flex w-full max-w-[460px] flex-col items-center gap-3 text-center">
          <span className="font-mono text-2xl leading-8 text-ink3" aria-hidden>
            ∅
          </span>
          <b className="text-lg">This clip doesn’t exist</b>
          <p className="text-[13px] leading-relaxed text-ink2">It may have been deleted or replaced when moments were re-picked.</p>
          <Link to={`/p/${p.id}`} className="btn-primary mt-1 py-2 no-underline">
            Back to the project
          </Link>
        </div>
      </div>
    );
  if (!t || !p.sourceVideoUrl)
    return (
      <div className="p-6 text-ink2">
        The source video or transcript isn’t ready yet. <Link to={`/p/${p.id}`}>Back to the project</Link>
      </div>
    );

  return (
    <>
      <LiveStatusPill status={stream} />
      <ClipEditor
        key={clip.id}
        projectId={p.id}
        projectTitle={p.title}
        clipCount={p.clips.length}
        sourceVideoUrl={p.sourceVideoUrl}
        durationSec={p.durationSec ?? 0}
        srcW={p.width ?? 1920}
        srcH={p.height ?? 1080}
        settings={p.settings}
        words={t.words}
        rawWords={t.rawWords ?? t.words}
        segments={t.segments}
        flags={t.flags ?? []}
        sceneCuts={t.sceneCuts ?? []}
        overlays={masksSourceText(p.settings.sourceText, t.textProfile) ? (t.overlays ?? []) : []}
        clip={clip as EditorClip}
        renderProgress={progress}
        onExit={() => nav(`/p/${p.id}#card=${clip.id}`)}
      />
    </>
  );
}
