import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Film, Images, Link2, Plus, Upload } from "lucide-react";
import { useCommandPalette } from "../components/CommandPalette";
import { setPendingBumperFiles, useUploads } from "../lib/uploads";
import { useTRPC } from "../lib/trpc";
import { PosterBumperCards } from "../components/PosterBumperCards";
import { ProjectBumpersModal } from "../components/BumperField";
import { StatusText } from "../components/ui";
import { ScrollArea } from "../components/scroll-area";
import { formatTime } from "@reelsaw/shared";
import { ago } from "../lib/time";

const ACTIVE = new Set(["queued", "ingesting", "transcribing", "refining", "analyzing", "rendering"]);


/** New project plus a chevron menu for the other ways to add things. Both parts have fixed widths. */
function NewProjectMenu() {
  const nav = useNavigate();
  const openPalette = useCommandPalette();
  const { startProjects, openWithFile } = useUploads();
  const videos = useRef<HTMLInputElement>(null);
  const bumper = useRef<HTMLInputElement>(null);
  return (
    <div className="flex shrink-0">
      <Link to="/new" className="btn-primary w-[9.5rem] justify-center rounded-r-none py-2.5 text-sm no-underline">
        <Plus className="h-4 w-4" /> New project
      </Link>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="btn-primary w-10 justify-center rounded-l-none border-l border-white/30 px-0 py-2.5" aria-label="More ways to add" title="More ways to add">
            <ChevronDown className="h-4 w-4" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className="menu w-[240px]">
            <DropdownMenu.Item className="menu-item" onSelect={() => videos.current?.click()}>
              <Film className="h-4 w-4" /> Upload videos…
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => openPalette()}>
              <Link2 className="h-4 w-4" /> Paste links…
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="mx-1.5 my-1 h-px bg-line" />
            <DropdownMenu.Item className="menu-item" onSelect={() => bumper.current?.click()}>
              <Upload className="h-4 w-4" /> Upload intro / outro…
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => nav("/library")}>
              <Images className="h-4 w-4" /> Open library
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <input
        ref={videos}
        type="file"
        multiple
        accept="video/*,.mkv,.mov,.mp4,.webm"
        className="hidden"
        aria-label="Choose videos"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length === 1) openWithFile(files[0]!);
          else if (files.length > 1) startProjects(files);
        }}
      />
      <input
        ref={bumper}
        type="file"
        multiple
        accept=".mp4,.mov,.webm,.png,.jpg,.jpeg,video/mp4,video/quicktime,video/webm,image/png,image/jpeg"
        className="hidden"
        aria-label="Choose intro or outro files"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (!files.length) return;
          setPendingBumperFiles(files);
          nav("/library");
        }}
      />
    </div>
  );
}

export function ProjectsPage() {
  const trpc = useTRPC();
  const q = useQuery({
    ...trpc.projects.list.queryOptions(),
    refetchInterval: (query) => (query.state.data?.some((p) => ACTIVE.has(p.status)) ? 3000 : false),
  });
  const projects = q.data ?? [];
  const [bumperFor, setBumperFor] = useState<string | null>(null);
  const bumperProject = projects.find((p) => p.id === bumperFor);
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
          <NewProjectMenu />
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
              <div key={p.id} className="group relative">
              <Link to={`/p/${p.id}`} className="flex flex-col overflow-hidden rounded-[16px] border border-line bg-panel text-ink no-underline transition hover:border-line2 hover:shadow-pop">
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
              {/* a sibling over the link, so a click on a card opens the dialog instead of navigating */}
              <PosterBumperCards bumpers={p.bumpers} onOpen={() => setBumperFor(p.id)} />
              </div>
            );
          })}
        </div>
      </main>
      {bumperProject && (
        <ProjectBumpersModal
          open
          onOpenChange={(o) => !o && setBumperFor(null)}
          projectId={bumperProject.id}
          clipCount={bumperProject.clipsDone}
          introId={bumperProject.settings.introAssetId}
          outroId={bumperProject.settings.outroAssetId}
          introSec={bumperProject.settings.introSec}
          outroSec={bumperProject.settings.outroSec}
        />
      )}
    </ScrollArea>
  );
}
