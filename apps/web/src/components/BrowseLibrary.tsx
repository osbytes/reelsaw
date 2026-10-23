/**
 * Browse: search the Reelsaw catalog (sounds, icons, emoji) and the remote providers an admin switched on
 * (Pexels, Pixabay, Freesound, Iconify, Giphy …), and add a result to the library. Mount `<BrowseLibrary>` in a page
 * or `<BrowseLibraryDialog>` over the editor. Server: `catalog.providers / search / import` (same service as the
 * `search_library` and `import_asset` tools). The provider's credit line is shown in the footer (Pexels, Pixabay and
 * Giphy require it); results keep their licence badge; a duplicate resolves to the existing item.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { Check, Loader2, Pause, Play, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import type { AppRouter } from "@reelsaw/server";
import { useTRPC } from "../lib/trpc";
import { Modal, Notice, Segmented, Skeleton, SkeletonRegion } from "./ui";

type Out = inferRouterOutputs<AppRouter>;
export type BrowseItem = Out["catalog"]["search"]["items"][number];
export type ImportedAsset = Out["catalog"]["import"];

const KIND_LABEL = { video: "Video", image: "Image", audio: "Sound" } as const;
type Kind = keyof typeof KIND_LABEL;
const PAGE = 24;

/** The value after `ms` of no change (keeps the search from firing on every keystroke). */
function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const lengthText = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${s.toFixed(s % 1 ? 1 : 0)} s`);

/** One result. A tile of fixed shape (no layout shift while images arrive); audio and video play in place. */
function ResultCard({ item, state, onAdd, onPlay, playing }: { item: BrowseItem; state: "idle" | "pending" | "added" | "duplicate"; onAdd: () => void; onPlay: () => void; playing: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) void v.play().catch(() => {});
    else v.pause();
  }, [playing]);
  const thumb = item.thumbUrl ?? (item.kind === "image" ? item.previewUrl : undefined);
  const done = state === "added" || state === "duplicate";
  return (
    <li className="flex min-w-0 flex-col gap-1.5 rounded-[12px] border border-line bg-panel p-2">
      <div className="relative aspect-square w-full overflow-hidden rounded-[8px] bg-film">
        {item.kind === "video" && playing ? (
          <video ref={videoRef} src={item.previewUrl} poster={thumb} muted loop playsInline className="absolute inset-0 h-full w-full object-cover" />
        ) : thumb ? (
          <img src={thumb} alt="" loading="lazy" className={`absolute inset-0 h-full w-full ${item.kind === "image" && item.mime === "image/svg+xml" ? "object-contain p-3" : "object-cover"}`} />
        ) : (
          <span className="absolute inset-0 grid place-items-center text-film-text text-xs">{KIND_LABEL[item.kind]}</span>
        )}
        {item.kind !== "image" && (
          <button type="button" onClick={onPlay} aria-label={playing ? `Pause ${item.name}` : `Play ${item.name}`} className="absolute left-1/2 top-1/2 grid h-10 w-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white/90 text-film-ink shadow-pop">
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
        )}
        {item.durationSec ? <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white">{lengthText(item.durationSec)}</span> : null}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold" title={item.name}>
          {item.name}
        </div>
        <a href={item.license.url} target="_blank" rel="noreferrer" className="mt-0.5 inline-block max-w-full truncate rounded-full bg-sunk px-2 py-0.5 text-[11px] text-ink2 hover:text-ink" title={item.attribution ?? item.license.name}>
          {item.license.name}
        </a>
      </div>
      <button type="button" className={done ? "btn-ghost justify-center" : "btn-ink justify-center"} disabled={state === "pending" || done} onClick={onAdd} aria-live="polite">
        {state === "pending" ? <Loader2 size={14} className="animate-spin" /> : done ? <Check size={14} /> : <Plus size={14} />}
        {state === "pending" ? "Adding…" : state === "added" ? "Added" : state === "duplicate" ? "Already in library" : "Add to library"}
      </button>
    </li>
  );
}

const SKELETONS = Array.from({ length: 8 }, (_, i) => i);

export function BrowseLibrary({ onImported, kind: onlyKind, className = "" }: { onImported?: (asset: ImportedAsset) => void; /** limit results to one kind (the editor's picker knows what it wants) */ kind?: Kind; className?: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const providers = useQuery(trpc.catalog.providers.queryOptions());
  const [provider, setProvider] = useState("reelsaw");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<Kind | "all">(onlyKind ?? "all");
  const [license, setLicense] = useState<"cc0" | "by">("cc0");
  const [color, setColor] = useState("#ffffff");
  const [status, setStatus] = useState<Record<string, "pending" | "added" | "duplicate">>({});
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const q = useDebounced(text.trim());

  const list = providers.data ?? [];
  const current = list.find((p) => p.id === provider) ?? list[0];
  // a provider an admin switched off while the panel was open falls back to the catalog
  useEffect(() => {
    if (providers.data && !providers.data.some((p) => p.id === provider)) setProvider("reelsaw");
  }, [providers.data, provider]);
  const kinds = useMemo(() => (current?.kinds ?? []).filter((k): k is Kind => !onlyKind || k === onlyKind), [current, onlyKind]);
  useEffect(() => {
    if (kind !== "all" && current && !kinds.includes(kind)) setKind("all");
  }, [kind, kinds, current]);

  // the catalog lists everything for an empty search; the others need words
  const enabled = !!current && (current.id === "reelsaw" || q.length > 0);
  const search = useInfiniteQuery(
    trpc.catalog.search.infiniteQueryOptions(
      { provider: current?.id, q, kind: kind === "all" ? onlyKind : kind, limit: PAGE, ...(current?.id === "freesound" ? { license } : {}) },
      { enabled, getNextPageParam: (last) => last.nextCursor ?? undefined, placeholderData: keepPreviousData, staleTime: 60_000 },
    ),
  );
  const items = useMemo(() => search.data?.pages.flatMap((p) => p.items) ?? [], [search.data]);
  const unavailable = search.data?.pages.find((p) => p.unavailable)?.unavailable;

  const importM = useMutation(trpc.catalog.import.mutationOptions());
  const keyOf = (i: BrowseItem) => `${i.provider}:${i.externalId}`;
  const add = async (i: BrowseItem) => {
    const k = keyOf(i);
    setStatus((s) => ({ ...s, [k]: "pending" }));
    try {
      const asset = await importM.mutateAsync({ provider: i.provider, externalId: i.externalId, ...(i.provider === "iconify" ? { color } : {}) });
      setStatus((s) => ({ ...s, [k]: asset.duplicate ? "duplicate" : "added" }));
      toast(asset.duplicate ? `${asset.name} is already in your library${asset.restored ? " (restored)" : ""}.` : `Added ${asset.name} to your library.`);
      void qc.invalidateQueries({ queryKey: trpc.bumpers.list.queryKey() });
      onImported?.(asset);
    } catch (err) {
      setStatus((s) => {
        const { [k]: _gone, ...rest } = s;
        return rest;
      });
      toast.error(err instanceof Error ? err.message : "Could not add that item.");
    }
  };

  // one sound at a time; leaving the panel stops it
  const toggle = (i: BrowseItem) => {
    const k = keyOf(i);
    audioRef.current?.pause();
    audioRef.current = null;
    if (playing === k) return setPlaying(null);
    setPlaying(k);
    if (i.kind === "audio") {
      const a = new Audio(i.previewUrl);
      a.onended = () => setPlaying((p) => (p === k ? null : p));
      audioRef.current = a;
      void a.play().catch(() => setPlaying(null));
    }
  };
  useEffect(
    () => () => {
      audioRef.current?.pause();
    },
    [],
  );
  useEffect(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(null);
  }, [provider, q, kind]);

  const pending = enabled && search.isPending;
  const settled = enabled && !search.isPending && !search.isError;

  return (
    <div className={`flex min-h-0 flex-col gap-3 ${className}`}>
      {providers.isPending ? (
        <SkeletonRegion label="Loading sources…">
          <Skeleton className="h-9 w-full rounded-[10px]" />
        </SkeletonRegion>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1 pb-0.5">
          <Segmented
            className="min-w-max"
            ariaLabel="Source"
            value={current?.id ?? "reelsaw"}
            onChange={setProvider}
            options={list.map((p) => ({ value: p.id, label: p.experimental ? `${p.label} (beta)` : p.label, title: p.available ? p.attributionLine : "Rate limited; try again in a minute" }))}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-48">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink3" />
          <input className="input w-full pl-8" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={current?.id === "reelsaw" ? "Search sounds, icons, emoji" : `Search ${current?.label ?? ""}`} aria-label="Search" />
        </label>
        {!onlyKind && kinds.length > 1 && <Segmented size="sm" ariaLabel="Kind" value={kind} onChange={setKind} options={[{ value: "all", label: "All" }, ...kinds.map((k) => ({ value: k, label: KIND_LABEL[k] }))]} />}
        {current?.id === "freesound" && <Segmented size="sm" ariaLabel="License" value={license} onChange={setLicense} options={[{ value: "cc0", label: "CC0", title: "Public domain, no credit needed" }, { value: "by", label: "CC0 + BY", title: "Also CC BY: the credit is saved with the sound" }]} />}
        {current?.id === "iconify" && (
          <label className="flex items-center gap-1.5 text-xs text-ink2">
            Color
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-8 w-8 cursor-pointer rounded border border-line bg-panel p-0.5" aria-label="Icon color" />
          </label>
        )}
      </div>

      {unavailable && <Notice tone="warn">{unavailable}</Notice>}
      {search.isError && <Notice tone="err">{search.error.message}</Notice>}

      <div className="min-h-[240px] min-w-0 flex-1 overflow-y-auto" aria-busy={pending || search.isPlaceholderData}>
        {!enabled && current ? (
          <p className="py-10 text-center text-sm text-ink3">Type to search {current.label}.</p>
        ) : pending ? (
          <SkeletonRegion label="Searching…">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {SKELETONS.map((i) => (
                <Skeleton key={i} className="h-[190px] rounded-[12px]" />
              ))}
            </div>
          </SkeletonRegion>
        ) : settled && items.length === 0 && !unavailable ? (
          <p className="py-10 text-center text-sm text-ink3">{q ? `Nothing found for “${q}”.` : "Nothing here yet."}</p>
        ) : (
          <>
            <ul className={`grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 ${search.isPlaceholderData ? "opacity-60" : ""}`}>
              {items.map((i) => (
                <ResultCard key={keyOf(i)} item={i} state={status[keyOf(i)] ?? "idle"} onAdd={() => void add(i)} onPlay={() => toggle(i)} playing={playing === keyOf(i)} />
              ))}
            </ul>
            {search.hasNextPage && (
              <div className="flex justify-center py-3">
                <button type="button" className="btn-ghost" disabled={search.isFetchingNextPage} onClick={() => void search.fetchNextPage()}>
                  {search.isFetchingNextPage ? <Loader2 size={14} className="animate-spin" /> : null}
                  {search.isFetchingNextPage ? "Loading…" : "Show more"}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {current && <p className="shrink-0 text-xs text-ink3">{current.attributionLine}</p>}
    </div>
  );
}

/** Browse over the editor or a page, in the repo's modal (menus portaled out of it are not dismissals). */
export function BrowseLibraryDialog({ open, onOpenChange, onImported, kind }: { open: boolean; onOpenChange: (o: boolean) => void; onImported?: (asset: ImportedAsset) => void; kind?: Kind }) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Browse sounds, icons and media" width={820}>
      {open && <BrowseLibrary onImported={onImported} kind={kind} className="h-[min(640px,70dvh)]" />}
    </Modal>
  );
}
