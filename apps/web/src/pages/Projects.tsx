import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Film, Clock } from "lucide-react";
import { useTRPC } from "../lib/trpc";
import { StatusBadge, ProgressBar } from "../components/ui";
import { formatTime } from "@reelsaw/shared";

const ACTIVE = new Set(["queued", "ingesting", "transcribing", "analyzing", "rendering"]);

export function ProjectsPage() {
  const trpc = useTRPC();
  const q = useQuery({
    ...trpc.projects.list.queryOptions(),
    refetchInterval: (query) => (query.state.data?.some((p) => ACTIVE.has(p.status)) ? 3000 : false),
  });

  if (q.isLoading) return <p className="text-muted">Loading projects…</p>;
  if (q.error) return <p className="text-danger">{q.error.message}</p>;
  const projects = q.data ?? [];

  if (!projects.length)
    return (
      <div className="card p-10 text-center">
        <Film className="mx-auto mb-3 h-8 w-8 text-muted" />
        <h2 className="text-lg font-semibold">No projects yet</h2>
        <p className="mb-4 text-sm text-muted">Paste a YouTube link or upload a video to get your first clips.</p>
        <Link to="/new" className="btn-primary">
          New project
        </Link>
      </div>
    );

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">Projects</h1>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((p) => (
          <Link key={p.id} to={`/p/${p.id}`} className="card overflow-hidden transition hover:border-accent-2/60">
            <div className="aspect-video bg-panel-2">
              {p.thumbnailUrl ? (
                <img src={p.thumbnailUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center text-muted">
                  <Film className="h-8 w-8" />
                </div>
              )}
            </div>
            <div className="space-y-2 p-3">
              <div className="flex items-start justify-between gap-2">
                <h3 className="line-clamp-2 text-sm font-medium">{p.title}</h3>
                <StatusBadge status={p.status} />
              </div>
              {ACTIVE.has(p.status) && <ProgressBar value={p.stageProgress ?? 0} />}
              <div className="flex items-center gap-3 text-xs text-muted">
                {p.durationSec ? (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" /> {formatTime(p.durationSec)}
                  </span>
                ) : null}
                {p.clipCount > 0 && (
                  <span>
                    {p.clipsDone}/{p.clipCount} clips
                  </span>
                )}
                <span className="ml-auto">{new Date(p.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
