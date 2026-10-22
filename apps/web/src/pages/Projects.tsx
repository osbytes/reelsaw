import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { Link, useNavigate } from "react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Film, Images, Link2, Plus, Upload } from "lucide-react";
import { useCommandPalette } from "../components/CommandPalette";
import { setPendingBumperFiles, useUploads } from "../lib/uploads";
import { useTRPC } from "../lib/trpc";
import { PosterBumperCards } from "../components/PosterBumperCards";
import { Skeleton, SkeletonRegion, StatusText } from "../components/ui";
import { ScrollArea } from "../components/scroll-area";
import { formatTime } from "@reelsaw/shared";
import { ago } from "../lib/time";
import { useMe } from "../lib/account";
import { summarizeError } from "../lib/errors";
import { useLoadMoreSentinel } from "../lib/useLoadMore";

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

const PAGE = 24;
const num = new Intl.NumberFormat();

/** A placeholder card with the real card's boxes, so a page arriving is a content swap, not a layout change. */
function CardSkeleton({ i }: { i: number }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-[16px] border border-line bg-panel">
      <Skeleton className="aspect-video rounded-none" />
      <div className="flex flex-col gap-1.5 p-3.5">
        <div className="flex min-h-[2.75em] flex-col gap-1 text-[15px] leading-snug">
          <Skeleton className={`h-[1.1rem] ${["w-4/5", "w-2/3", "w-full"][i % 3]}`} />
          {i % 3 === 2 && <Skeleton className="h-[1.1rem] w-1/2" />}
        </div>
        <Skeleton className="h-4 w-20" />
        <Skeleton className={`h-3.5 ${["w-3/5", "w-1/2", "w-2/3"][i % 3]}`} />
      </div>
    </div>
  );
}

export function ProjectsPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const isAdmin = useMe().data?.role === "admin";
  const q = useInfiniteQuery(
    trpc.projects.list.infiniteQueryOptions(
      { limit: PAGE },
      { getNextPageParam: (last) => last.nextCursor ?? undefined, placeholderData: keepPreviousData },
    ),
  );
  // header numbers cover all projects, not the loaded pages; fetched once, refreshed when something finishes
  const stats = useQuery({ ...trpc.projects.stats.queryOptions(), placeholderData: keepPreviousData });
  const loaded = useMemo(() => q.data?.pages.flatMap((pg) => pg.items) ?? [], [q.data]);
  const total = q.data?.pages[0]?.total ?? 0;

  // Running projects stay live without polling the list: the list is fetched once per page (and again when
  // uploads / creation invalidate it), and `projects.active` (id, status, stage, progress of projects that are
  // processing, nothing else) is polled every 3 s only while something runs. Its values are merged over the
  // cards below; when a project drops out of it (finished or failed) the list and stats are refetched once.
  const anyRunning = (stats.data?.running ?? 0) > 0 || loaded.some((p) => ACTIVE.has(p.status));
  const active = useQuery({ ...trpc.projects.active.queryOptions(), enabled: anyRunning, refetchInterval: 3000 });
  const activeById = useMemo(() => new Map((active.data ?? []).map((a) => [a.id, a])), [active.data]);
  const prevActive = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!active.data) return;
    const now = new Set(active.data.map((a) => a.id));
    const settled = [...prevActive.current].some((id) => !now.has(id));
    prevActive.current = now;
    if (settled) {
      void qc.invalidateQueries({ queryKey: trpc.projects.list.infiniteQueryKey() });
      void qc.invalidateQueries({ queryKey: trpc.projects.stats.queryKey() });
    }
  }, [active.data, qc, trpc]);

  const projects = useMemo(
    () => loaded.map((p) => {
      const a = activeById.get(p.id);
      return a ? { ...p, status: a.status, stage: a.stage, stageProgress: a.stageProgress } : p;
    }),
    [loaded, activeById],
  );
  const running = active.data ? active.data.length : (stats.data?.running ?? 0);
  const remaining = Math.max(0, total - loaded.length);
  const more = useLoadMoreSentinel(() => void q.fetchNextPage(), !!q.hasNextPage && !q.isFetching);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex max-w-[1180px] flex-col gap-6 px-4 py-7 sm:px-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[28px] font-bold tracking-tight">Projects</h1>
            {/* height reserved so the grid doesn't jump when the list arrives */}
            {stats.isPending ? (
              <div className="mt-1 flex h-5 items-center">
                <Skeleton className="h-3.5 w-52" />
              </div>
            ) : stats.data && stats.data.total > 0 ? (
              <p className="mt-1 min-h-5 text-sm text-ink2">
                {num.format(stats.data.total)} project{stats.data.total === 1 ? "" : "s"}
                {running ? ` · ${running} processing` : ""} · {num.format(stats.data.clipsDone)} clip{stats.data.clipsDone === 1 ? "" : "s"} ready
              </p>
            ) : (
              <p className="mt-1 min-h-5" />
            )}
          </div>
          <NewProjectMenu />
        </div>

        {q.error && <p className="text-err">{q.error.message}</p>}

        {!q.isPending && !q.isPlaceholderData && !projects.length && !q.error && (
          <div className="mx-auto mt-6 flex max-w-md flex-col items-center gap-3 rounded-[18px] border border-dashed border-line2 bg-panel px-8 py-12 text-center">
            <span className="film h-[72px] w-[42px] rounded-[8px]" />
            <h2 className="text-xl font-bold">Turn your first long video into clips</h2>
            <p className="text-sm leading-relaxed text-ink2">Paste a YouTube link or upload a file. We’ll transcribe it, find the strongest moments and frame them for 9:16.</p>
            <Link to="/new" className="btn-primary mt-2 py-2.5 text-sm no-underline">
              <Plus className="h-4 w-4" /> New project
            </Link>
          </div>
        )}

        {q.isPending && !q.error && (
          <SkeletonRegion label="Loading projects…" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">
            {Array.from({ length: 6 }, (_, i) => (
              <CardSkeleton key={i} i={i} />
            ))}
          </SkeletonRegion>
        )}

        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">
          {projects.map((p) => {
            const active = ACTIVE.has(p.status);
            const detail =
              p.status === "failed"
                ? summarizeError(p.error ?? "Something went wrong", { admin: isAdmin }).summary
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
                  {/* intro (left) and outro (right) assets, fanned like the clips */}
                  <PosterBumperCards bumpers={p.bumpers} />
                  {p.durationSec ? <span className="absolute bottom-2 right-2 rounded-[6px] bg-black/65 px-1.5 py-0.5 font-mono text-[11px] text-white">{formatTime(p.durationSec)}</span> : null}
                  {active && (
                    <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/30">
                      <div className="h-full bg-acc transition-all" style={{ width: `${Math.round((p.stageProgress ?? 0) * 100)}%` }} />
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1.5 p-3.5">
                  {/* always two lines tall so every card in the row ends at the same height, whatever the title length */}
                  <h3 className="line-clamp-2 min-h-[2.75em] text-[15px] font-semibold leading-snug">{p.title}</h3>
                  <StatusText status={p.status} />
                  <div className="truncate text-xs text-ink3">{detail}</div>
                </div>
              </Link>
              </div>
            );
          })}
          {q.isFetchingNextPage &&
            Array.from({ length: Math.min(remaining, PAGE) }, (_, i) => <CardSkeleton key={`next-${i}`} i={i} />)}
        </div>

        {/* fixed-height footer: the button, or the count once everything is loaded, never moves the page */}
        {projects.length > 0 && (
          <div ref={more} className="flex h-[5.5rem] flex-col items-center justify-center gap-1 text-xs text-ink3">
            {q.hasNextPage ? (
              <button type="button" className="btn-ghost h-9 min-w-[8rem]" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                {q.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            ) : null}
            <span className="tabular-nums">Showing {num.format(projects.length)} of {num.format(total)}</span>
          </div>
        )}
      </main>
    </ScrollArea>
  );
}
