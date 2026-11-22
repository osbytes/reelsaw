import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, Film, Images, Link2, Plus, Upload } from "lucide-react";
import { useCommandPalette } from "../components/CommandPalette";
import { setPendingBumperFiles, useUploads } from "../lib/uploads";
import { useTRPC } from "../lib/trpc";
import { PosterBumperCards } from "../components/PosterBumperCards";
import { Skeleton, SkeletonRegion, StatusText } from "../components/ui";
import { ScrollArea } from "../components/scroll-area";
import { formatTime, plural } from "@reelsaw/shared";
import { ago } from "../lib/time";
import { useMe } from "../lib/account";
import { summarizeError } from "../lib/errors";
import { useLoadMoreSentinel } from "../lib/useLoadMore";
import { readHash, writeHash } from "../lib/hash";
import { useShortcut, useShortcuts } from "../lib/shortcuts";
import { ProjectsBar } from "../components/ProjectsBar";
import { pageTitle, useDocumentTitle } from "../lib/title";
import { showingCount } from "../components/ListPage";

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
      <Link to="/new" className="btn-primary w-[9.5rem] justify-center rounded-e-none py-2.5 text-sm no-underline">
        <Plus className="h-4 w-4" /> New project
      </Link>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="btn-primary w-10 justify-center rounded-s-none border-s border-white/30 px-0 py-2.5"
            aria-label="More ways to add"
            title="More ways to add"
          >
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

/** The account's project count from the last visit (this browser only): sizes the loading skeleton. */
const lastProjectCount = {
  read(): number | null {
    try {
      const v = Number(localStorage.getItem("reelsaw.projectCount"));
      return Number.isFinite(v) && localStorage.getItem("reelsaw.projectCount") !== null ? v : null;
    } catch {
      return null;
    }
  },
  write(n: number) {
    try {
      localStorage.setItem("reelsaw.projectCount", String(n));
    } catch {
      // private window or blocked storage: the skeleton falls back to a full row
    }
  },
};

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
  useDocumentTitle(pageTitle("Projects"));
  const trpc = useTRPC();
  const qc = useQueryClient();
  const isAdmin = useMe().data?.role === "admin";
  const q = useInfiniteQuery(
    trpc.projects.list.infiniteQueryOptions({ limit: PAGE }, { getNextPageParam: (last) => last.nextCursor ?? undefined, placeholderData: keepPreviousData }),
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
    () =>
      loaded.map((p) => {
        const a = activeById.get(p.id);
        return a ? { ...p, status: a.status, stage: a.stage, stageProgress: a.stageProgress } : p;
      }),
    [loaded, activeById],
  );
  const running = active.data ? active.data.length : (stats.data?.running ?? 0);
  const isEmpty = !q.isPending && !q.isPlaceholderData && !projects.length && !q.error;
  // as many skeleton cards as the account had last time (up to a row's worth), so the grid does not collapse on load
  const skeletonCards = Math.min(6, Math.max(1, stats.data?.total ?? lastProjectCount.read() ?? 6));
  useEffect(() => {
    if (stats.data) lastProjectCount.write(stats.data.total);
  }, [stats.data]);
  const remaining = Math.max(0, total - loaded.length);
  const more = useLoadMoreSentinel(() => void q.fetchNextPage(), !!q.hasNextPage && !q.isFetching);

  // multi-select for the selection bar, like the clips list: kept in the hash (#sel=id1,id2) so it survives a reload and
  // can be shared. Ids not loaded (yet) stay selected but are not acted on; ones gone from a fully loaded list drop out.
  const [sel, setSel] = useState<string[]>(() => (readHash().get("sel") ?? "").split(",").filter(Boolean));
  const listLoaded = !!q.data;
  useEffect(() => {
    if (!listLoaded || q.hasNextPage || q.isPlaceholderData) return;
    const live = new Set(loaded.map((p) => p.id));
    setSel((cur) => (cur.every((x) => live.has(x)) ? cur : cur.filter((x) => live.has(x))));
  }, [listLoaded, loaded, q.hasNextPage, q.isPlaceholderData]);
  useEffect(() => {
    if (listLoaded) writeHash({ sel: sel.join(",") || null });
  }, [sel, listLoaded]);
  const selecting = sel.length > 0;
  const selected = useMemo(() => projects.filter((p) => sel.includes(p.id)), [projects, sel]);
  const toggle = (id: string) => setSel((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  useShortcuts("Projects", [["Clear the selection", "Esc"]]);
  useShortcut("escape", () => setSel([]), { enabled: selecting, preventDefault: false });
  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: trpc.projects.pathKey() });
  };

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
                {plural(stats.data.total, "project")}
                {running ? ` · ${running} processing` : ""} · {plural(stats.data.clipsDone, "clip")} ready
              </p>
            ) : (
              <p className="mt-1 min-h-5" />
            )}
          </div>
          {/* an empty list's one call to action is the card below (docs/UI.md) */}
          {!isEmpty && <NewProjectMenu />}
        </div>

        {q.error && <p className="text-err">{q.error.message}</p>}

        {isEmpty && (
          <div className="mx-auto mt-6 flex max-w-md flex-col items-center gap-3 rounded-[18px] border border-dashed border-line2 bg-panel px-8 py-12 text-center">
            <span className="film h-[72px] w-[42px] rounded-[8px]" />
            <h2 className="text-xl font-bold">Turn your first long video into clips</h2>
            <p className="text-sm leading-relaxed text-ink2">
              Paste a YouTube link or upload a file. We’ll transcribe it, find the strongest moments and frame them for 9:16.
            </p>
            <Link to="/new" className="btn-primary mt-2 py-2.5 text-sm no-underline">
              <Plus className="h-4 w-4" /> New project
            </Link>
          </div>
        )}

        {q.isPending && !q.error && (
          <SkeletonRegion label="Loading projects…" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-4">
            {Array.from({ length: skeletonCards }, (_, i) => (
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
                  ? `${plural(p.clipCount, "clip")} · ${p.clipsDone} ready · ${ago(p.createdAt)}`
                  : `Added ${ago(p.createdAt)}`;
            const checked = sel.includes(p.id);
            return (
              <div key={p.id} className="group relative">
                {/* over the thumbnail's corner, not in the flow: the card looks the same with or without selection */}
                <label
                  className={`absolute start-2.5 top-2.5 z-20 grid h-7 w-7 cursor-pointer place-items-center rounded-[8px] bg-black/45 backdrop-blur-sm focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100 ${selecting ? "opacity-100" : "opacity-0"}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(p.id)}
                    aria-label={`Select ${p.title}`}
                    className="h-4 w-4 cursor-pointer accent-[var(--acc)]"
                  />
                </label>
                <Link
                  to={`/p/${p.id}`}
                  // while something is selected a plain click adds or removes the card (a modified click still opens it)
                  onClick={(e) => {
                    if (!selecting || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    toggle(p.id);
                  }}
                  className={`flex flex-col overflow-hidden rounded-[16px] border bg-panel text-ink no-underline transition hover:shadow-pop ${checked ? "border-acc ring-1 ring-acc" : "border-line hover:border-line2"}`}
                >
                  <div className="film relative aspect-video">
                    {(p.sourceThumbnailUrl ?? (p.clipThumbs.length ? null : p.thumbnailUrl)) && (
                      <img
                        src={(p.sourceThumbnailUrl ?? p.thumbnailUrl)!}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    )}
                    {p.clipThumbs.length > 0 && (
                      // the first few clips as a little fanned stack of 9:16 cards over the source thumbnail
                      <div className="absolute bottom-2 start-2 flex h-[62%] items-end">
                        {p.clipThumbs.map((src, i) => (
                          <img
                            key={src}
                            src={src}
                            alt=""
                            loading="lazy"
                            className="h-full rounded-[6px] object-cover shadow-[0_4px_12px_rgba(0,0,0,.45)] ring-2 ring-white/90 transition-transform duration-200 group-hover:translate-y-[-2px]"
                            style={{
                              aspectRatio: "9 / 16",
                              marginLeft: i ? "-14%" : 0,
                              zIndex: 10 - i,
                              transform: `rotate(${(i - (p.clipThumbs.length - 1) / 2) * 4}deg)`,
                            }}
                          />
                        ))}
                        {p.clipsDone > p.clipThumbs.length && (
                          <span className="z-10 mb-1 ms-1.5 rounded-full bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white">
                            +{p.clipsDone - p.clipThumbs.length}
                          </span>
                        )}
                      </div>
                    )}
                    {/* intro (left) and outro (right) assets, fanned like the clips */}
                    <PosterBumperCards bumpers={p.bumpers} />
                    {p.durationSec ? (
                      <span className="absolute bottom-2 end-2 rounded-[6px] bg-black/65 px-1.5 py-0.5 font-mono text-[11px] text-white">
                        {formatTime(p.durationSec)}
                      </span>
                    ) : null}
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
          {q.isFetchingNextPage && Array.from({ length: Math.min(remaining, PAGE) }, (_, i) => <CardSkeleton key={`next-${i}`} i={i} />)}
        </div>

        {selected.length > 0 && (
          <ProjectsBar
            selected={selected}
            total={projects.length}
            onSelectAll={() => setSel((cur) => [...new Set([...cur, ...projects.map((p) => p.id)])])}
            onClear={() => setSel([])}
            onChanged={refreshAll}
          />
        )}

        {/* fixed-height footer: the button, or the count once everything is loaded, never moves the page */}
        {projects.length > 0 && (
          <div ref={more} className="flex h-[5.5rem] flex-col items-center justify-center gap-1 text-xs text-ink3">
            {q.hasNextPage ? (
              <button type="button" className="btn-ghost h-9 min-w-[8rem]" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                {q.isFetchingNextPage ? "Loading…" : "Load more"}
              </button>
            ) : null}
            <span className="tabular-nums">{showingCount(projects.length, total, "project")}</span>
          </div>
        )}
      </main>
    </ScrollArea>
  );
}
