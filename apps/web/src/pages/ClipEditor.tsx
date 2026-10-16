import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSubscription } from "@trpc/tanstack-react-query";
import { Link, useNavigate, useParams } from "react-router";
import { useTRPC } from "../lib/trpc";
import { ClipEditor, type EditorClip } from "../components/ClipEditor";

/** Full-screen editor route: /p/:id/clips/:clipId. Live render progress comes from the project's event stream. */
export function ClipEditorPage() {
  const { id = "", clipId = "" } = useParams();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery(trpc.projects.get.queryOptions({ id }));
  const [progress, setProgress] = useState<number | undefined>(undefined);

  useSubscription(
    trpc.projects.events.subscriptionOptions(
      { id },
      {
        onData: ({ data: evt }) => {
          const p = evt.payload as { clipId?: string; progress?: number };
          if (evt.type === "stage.progress") {
            if (p.clipId === clipId && typeof p.progress === "number") setProgress(p.progress);
            return;
          }
          if (p.clipId === clipId || evt.type.startsWith("project.")) void qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id }) });
        },
      },
    ),
  );

  const p = q.data;
  const clip = p?.clips.find((c) => c.id === clipId);
  if (q.isLoading) return <p className="p-6 text-ink3">Loading…</p>;
  if (!p || !clip)
    return (
      <div className="p-6">
        <p className="text-err">{q.error?.message ?? "Clip not found"}</p>
        <Link to={p ? `/p/${p.id}` : "/"}>Back</Link>
      </div>
    );
  if (!p.transcript || !p.sourceVideoUrl)
    return (
      <div className="p-6 text-ink2">
        The source video or transcript isn’t ready yet. <Link to={`/p/${p.id}`}>Back to the project</Link>
      </div>
    );

  return (
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
      words={p.transcript.words}
      rawWords={p.transcript.rawWords ?? p.transcript.words}
      segments={p.transcript.segments}
      flags={p.transcript.flags ?? []}
      sceneCuts={p.transcript.sceneCuts ?? []}
      overlays={p.settings.sourceText === "keep" ? [] : (p.transcript.overlays ?? [])}
      clip={clip as EditorClip}
      renderProgress={progress}
      onExit={() => nav(`/p/${p.id}`)}
    />
  );
}
