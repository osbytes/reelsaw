import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Plus } from "lucide-react";
import { useTRPC } from "../lib/trpc";
import { StatusText } from "../components/ui";
import { ScrollArea } from "../components/scroll-area";
import { formatTime } from "@reelsaw/shared";

const ACTIVE = new Set(["queued", "ingesting", "transcribing", "refining", "analyzing", "rendering"]);

function ago(d: string | Date) {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(d).toLocaleDateString();
}

export function ProjectsPage() {
  const trpc = useTRPC();
  const q = useQuery({
    ...trpc.projects.list.queryOptions(),
    refetchInterval: (query) => (query.state.data?.some((p) => ACTIVE.has(p.status)) ? 3000 : false),
  });
  const projects = q.data ?? [];
  const running = projects.filter((p) => ACTIVE.has(p.status)).length;
  const clips = projects.reduce((a, p) => a + p.clipsDone, 0);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex max-w-[1180px] flex-col gap-6 px-4 py-7 sm:px-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[28px] font-bold tracking-tight">Projects</h1>
            {/* height reserved so the grid doesn't jump when the list arrives */}
            {projects.length > 0 ? (
              <p className="mt-1 min-h-5 text-sm text-ink2">
                {projects.length} project{projects.length === 1 ? "" : "s"}
                {running ? ` · ${running} processing` : ""} · {clips} clip{clips === 1 ? "" : "s"} ready
              </p>
            ) : (
              <p className="mt-1 min-h-5" />
            )}
          </div>
          <Link to="/new" className="btn-primary py-2.5 text-sm no-underline">
            <Plus className="h-4 w-4" /> New project
          </Link>
        </div>

        {q.isLoading && <p className="text-ink3">Loading projects…</p>}
        {q.error && <p className="text-err">{q.error.message}</p>}

        {!q.isLoading && !projects.length && (
          <div className="mx-auto mt-6 flex max-w-md flex-col items-center gap-3 rounded-[18px] border border-dashed border-line2 bg-panel px-8 py-12 text-center">
            <span className="film h-[72px] w-[42px] rounded-[8px]" />
            <h2 className="text-xl font-bold">Turn your first long video into clips</h2>
            <p className="text-sm leading-relaxed text-ink2">Paste a YouTube link or upload a file. We’ll transcribe it, find the strongest moments and frame them for 9:16.</p>
            <Link to="/new" className="btn-primary mt-2 py-2.5 text-sm no-underline">
              <Plus className="h-4 w-4" /> New project
            </Link>
          </div>
        )}

        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">
          {projects.map((p) => {
            const active = ACTIVE.has(p.status);
            const detail =
              p.status === "failed"
                ? (p.error ?? "Something went wrong").split("\n")[0]
                : p.clipCount
                  ? `${p.clipCount} clip${p.clipCount === 1 ? "" : "s"} · ${p.clipsDone} ready · ${ago(p.createdAt)}`
                  : `Added ${ago(p.createdAt)}`;
            return (
              <Link key={p.id} to={`/p/${p.id}`} className="group flex flex-col overflow-hidden rounded-[16px] border border-line bg-panel text-ink no-underline transition hover:border-line2 hover:shadow-pop">
                <div className="film relative aspect-video">
                  {(p.sourceThumbnailUrl ?? (p.clipThumbs.length ? null : p.thumbnailUrl)) && (
                    <img src={(p.sourceThumbnailUrl ?? p.thumbnailUrl)!} alt="" referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full object-cover" />
                  )}
                  {p.clipThumbs.length > 0 && (
                    // the first few clips as a little fanned stack of 9:16 cards over the source thumbnail
                    <div className="absolute bottom-2 left-2 flex h-[62%] items-end">
                      {p.clipThumbs.map((src, i) => (
                        <img
                          key={src}
                          src={src}
                          alt=""
                          loading="lazy"
                          className="h-full rounded-[6px] object-cover shadow-[0_4px_12px_rgba(0,0,0,.45)] ring-2 ring-white/90 transition-transform duration-200 group-hover:translate-y-[-2px]"
                          style={{ aspectRatio: "9 / 16", marginLeft: i ? "-14%" : 0, zIndex: 10 - i, transform: `rotate(${(i - (p.clipThumbs.length - 1) / 2) * 4}deg)` }}
                        />
                      ))}
                      {p.clipsDone > p.clipThumbs.length && (
                        <span className="z-10 mb-1 ml-1.5 rounded-full bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">+{p.clipsDone - p.clipThumbs.length}</span>
                      )}
                    </div>
                  )}
                  {p.durationSec ? <span className="absolute bottom-2 right-2 rounded-[6px] bg-black/65 px-1.5 py-0.5 font-mono text-[11px] text-white">{formatTime(p.durationSec)}</span> : null}
                  {active && (
                    <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/30">
                      <div className="h-full bg-acc transition-all" style={{ width: `${Math.round((p.stageProgress ?? 0) * 100)}%` }} />
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1.5 p-3.5">
                  <h3 className="line-clamp-2 text-[15px] font-semibold leading-snug">{p.title}</h3>
                  <StatusText status={p.status} />
                  <div className="truncate text-xs text-ink3">{detail}</div>
                </div>
              </Link>
            );
          })}
        </div>
      </main>
    </ScrollArea>
  );
}
