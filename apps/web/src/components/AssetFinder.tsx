/**
 * The one finder: your uploads, the Reelsaw catalog and every enabled provider behind one search box and ONE grid of
 * identical tiles: uploads first, then catalog results, then provider results. One "Show more", one attribution footer.
 * `mode="library"` is the Library page body (filters live in the URL: ?kind=&q=, #asset=<id>);
 * `mode="picker"` is the editor's dialog (filters are local, each tile has one "Add to clip" button that imports a
 * catalog / provider result first).
 * Server: `library.list / search / get / providers / add / remove / restore` (same services as the MCP tools).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { Loader2, Search, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Link, useLocation, useNavigate } from "react-router";
import { DELETED_PATH } from "@reelsaw/shared";
import type { AppRouter } from "@reelsaw/server";
import { useTRPC } from "../lib/trpc";
import { useMe } from "../lib/account";
import { useHashParams } from "../lib/hash";
import { createFuzzy } from "../lib/fuzzy";
import { KIND_FILTERS, SEARCH_KEYS, searchable, type LibraryKind } from "../lib/library";
import { AssetLightbox, RemoveDialog, UploadJobs, useBumperActions, useBumperLibrary, type LibraryAsset } from "./BumperField";
import { AssetTile, AssetTileSkeleton, type TileModel } from "./AssetTile";
import { Modal, Notice } from "./ui";

type Out = inferRouterOutputs<AppRouter>;
type RemoteItem = Out["library"]["search"]["items"][number];
type Provider = Out["library"]["providers"][number];

/** What a pick hands back: enough for the editor to name, size and preview the layer before `library.get` returns. */
export interface PickedAsset {
  id: string;
  name: string;
  kind: LibraryKind;
  durationSec: number;
  mime?: string | null;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  thumbnailUrl?: string;
}

const PAGE = 24;

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** true once the element has been on screen (stays true), so a source's query runs lazily */
function useSeen(ref: React.RefObject<Element | null>) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen]);
  return seen;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition ${on ? "border-acc bg-acc-soft text-acc-text" : "border-line bg-panel text-ink2 hover:text-ink"}`}>
      {children}
    </button>
  );
}

interface Filters {
  kind: LibraryKind | "";
  q: string;
}

/** Filters in the URL (library page, shareable) or in state (the dialog). Both hooks always run; one is used. */
function useFilters(mode: "library" | "picker"): [Filters, (patch: Partial<Filters>) => void] {
  const nav = useNavigate();
  const loc = useLocation();
  const [local, setLocal] = useState<Filters>({ kind: "", q: "" });
  if (mode === "picker") return [local, (p) => setLocal((f) => ({ ...f, ...p }))];
  const params = new URLSearchParams(loc.search);
  const k = params.get("kind");
  const f: Filters = { kind: k === "video" || k === "image" || k === "audio" ? k : "", q: params.get("q") ?? "" };
  return [
    f,
    (patch) => {
      const next = new URLSearchParams(loc.search);
      next.delete("source");
      for (const [key, v] of Object.entries(patch)) (v ? next.set(key, v) : next.delete(key));
      const search = next.toString();
      nav({ pathname: loc.pathname, search: search ? `?${search}` : "", hash: loc.hash }, { replace: true });
    },
  ];
}

const gridClass = (mode: "library" | "picker") => (mode === "picker" ? "grid grid-cols-2 content-start gap-3 sm:grid-cols-3 md:grid-cols-4" : "grid grid-cols-2 content-start gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5");

const rowKey = (provider: string, externalId: string) => `${provider}:${externalId}`;

export interface AssetFinderProps {
  /** limit to these kinds (the editor's pickers know what they want) */
  kinds?: LibraryKind[];
  /** shorthand for `kinds={[kind]}` */
  kind?: LibraryKind;
  mode?: "library" | "picker";
  /** picker: called with the asset once it is ready (a catalog / provider result is imported first) */
  onPick?: (asset: PickedAsset) => void | Promise<void>;
  /** library mode: the page's actions (uploads share them) */
  actions?: ReturnType<typeof useBumperActions>;
  /** library mode: shows the Upload button next to the search box */
  onUpload?: () => void;
  className?: string;
  pickLabel?: string;
}

/** What a source (catalog or one provider) tells the finder about itself. */
interface SourceState {
  pending: boolean;
  count: number;
  hasNext: boolean;
  fetching: boolean;
  notice: boolean;
}
const sameState = (a: SourceState | undefined, b: SourceState) => !!a && a.pending === b.pending && a.count === b.count && a.hasNext === b.hasNext && a.fetching === b.fetching && a.notice === b.notice;

export function AssetFinder({ kinds: kindsProp, kind: kindProp, mode = "library", onPick, actions: actionsProp, onUpload, className = "", pickLabel }: AssetFinderProps) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const allowed = useMemo(() => kindsProp ?? (kindProp ? [kindProp] : undefined), [kindsProp, kindProp]);
  const [filters, setFilters] = useFilters(mode);
  const own = useBumperActions();
  const actions = actionsProp ?? own;
  const list = useBumperLibrary();
  const providers = useQuery(trpc.library.providers.queryOptions());
  const defaults = useMe().data?.projectDefaults;
  const selected = useHashParams().get("asset");
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<LibraryAsset | null>(null);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [states, setStates] = useState<Record<string, SourceState>>({});
  const fetchers = useRef<Record<string, () => void>>({});
  const register = useCallback((id: string, st: SourceState, fetchNext: () => void) => {
    fetchers.current[id] = fetchNext;
    setStates((p) => (sameState(p[id], st) ? p : { ...p, [id]: st }));
  }, []);
  const unregister = useCallback((id: string) => {
    delete fetchers.current[id];
    setStates((p) => {
      if (!(id in p)) return p;
      const rest = { ...p };
      delete rest[id];
      return rest;
    });
  }, []);

  const { kind, q } = filters;
  const dq = useDebounced(q.trim());
  const all = useMemo(() => (list.data?.assets ?? []).filter((a) => !allowed || allowed.includes(a.kind)), [list.data, allowed]);

  const fuse = useMemo(() => createFuzzy(all.map(searchable), SEARCH_KEYS), [all]);
  const rows = useMemo(() => {
    const ranked = q.trim() ? fuse.filter(q).map((a) => all.find((x) => x.id === a.id)!) : all;
    return ranked.filter((a) => !kind || a.kind === kind);
  }, [all, fuse, q, kind]);
  const kindChips = allowed?.length === 1 ? [] : KIND_FILTERS.filter((k) => !allowed || allowed.includes(k.id));
  // a single allowed kind is the filter; otherwise the chip decides
  const searchKind = kind || (allowed?.length === 1 ? allowed[0] : undefined);
  // a kind-limited finder only lists providers that can serve one of the allowed kinds (and the chosen kind chip)
  const providerFits = (p: Provider) => {
    const has = (k: string) => (p.kinds as readonly string[]).includes(k);
    return (!allowed || allowed.some(has)) && (!searchKind || has(searchKind));
  };
  const providerServes = (p: Provider) => !allowed || allowed.some((k) => (p.kinds as readonly string[]).includes(k));
  const remoteProviders = (providers.data ?? []).filter((p) => p.id !== "reelsaw" && providerServes(p));
  const kindOk = (k: string) => !allowed || (allowed as readonly string[]).includes(k);
  const providerLabel = (id: string) => (id === "reelsaw" ? "Catalog" : (providers.data?.find((p) => p.id === id)?.label ?? id.charAt(0).toUpperCase() + id.slice(1)));

  // #asset=<id> scrolls its tile into view once the list is there
  useEffect(() => {
    if (mode !== "library" || !selected || !rows.some((a) => a.id === selected)) return;
    document.getElementById(`asset-${selected}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, rows.length]);

  const importM = useMutation(trpc.library.add.mutationOptions());
  const refreshList = () => void qc.invalidateQueries({ queryKey: trpc.library.pathKey() });

  /** Runs `fn` with the tile marked pending; a failure is a toast and the tile goes back to idle. */
  const run = async (key: string, fn: () => Promise<void>) => {
    setPending((s) => new Set(s).add(key));
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setPending((s) => (s.delete(key), new Set(s)));
    }
  };
  const asPicked = (a: { id: string; name: string; kind: string; durationSec: number; mime?: string | null; width?: number; height?: number; hasAudio?: boolean; thumbnailUrl?: string }): PickedAsset => ({
    id: a.id,
    name: a.name,
    kind: a.kind as LibraryKind,
    durationSec: a.durationSec,
    mime: a.mime,
    width: a.width,
    height: a.height,
    hasAudio: a.hasAudio,
    thumbnailUrl: a.thumbnailUrl ?? (a.kind === "audio" ? "" : `/media/assets/${a.id}/thumb.jpg`),
  });
  const importItem = async (i: RemoteItem): Promise<PickedAsset> => {
    const a = await importM.mutateAsync({ provider: i.provider, externalId: i.externalId });
    refreshList();
    return asPicked(a);
  };
  const pickedFromRow = (r: LibraryAsset): PickedAsset => asPicked(r);

  const fadeOut = (a: LibraryAsset) => {
    setLeaving((s) => new Set(s).add(a.id));
    window.setTimeout(() => void actions.remove(a).then(() => setLeaving((s) => (s.delete(a.id), new Set(s)))), 160);
  };
  const remove = (a: LibraryAsset) => (a.usedBy || a.usedByTemplates ? setRemoving(a) : fadeOut(a));
  const select = (a: LibraryAsset) => nav({ pathname: loc.pathname, search: loc.search, hash: selected === a.id ? "" : `#asset=${a.id}` }, { replace: true });
  const viewing = list.data?.assets.find((a) => a.id === viewingId) ?? null;

  const usageText = (r: LibraryAsset) => (r.usedByClips > 0 ? `${r.usedByClips} clip${r.usedByClips === 1 ? "" : "s"}` : r.usedBy > 0 ? `${r.usedBy} project${r.usedBy === 1 ? "" : "s"}` : r.usedByTemplates > 0 ? `${r.usedByTemplates} template${r.usedByTemplates === 1 ? "" : "s"}` : undefined);
  const libTile = (r: LibraryAsset): TileModel => ({
    key: `lib:${r.id}`,
    kind: r.kind,
    name: r.name,
    mime: r.mime,
    durationSec: r.durationSec,
    width: r.width,
    height: r.height,
    source: "Yours",
    license: r.provenance?.license?.name,
    hasAudio: r.hasAudio,
    thumbUrl: r.kind === "audio" ? undefined : r.mime === "image/gif" || r.mime === "image/webp" ? `/media/assets/${r.id}` : r.thumbnailUrl,
    previewUrl: r.kind === "image" ? (r.mime === "image/gif" || r.mime === "image/webp" ? `/media/assets/${r.id}` : undefined) : `/media/assets/${r.id}`,
    row: r,
    usage: usageText(r),
  });
  const remoteTile = (i: RemoteItem): TileModel => ({
    key: `remote:${rowKey(i.provider, i.externalId)}`,
    kind: i.kind,
    name: i.name,
    mime: i.mime,
    durationSec: i.durationSec,
    width: i.width,
    height: i.height,
    source: providerLabel(i.provider),
    license: i.license.name,
    hasAudio: i.kind === "audio" ? true : i.kind === "video" ? undefined : false,
    thumbUrl: i.thumbUrl ?? (i.kind === "image" ? i.previewUrl : undefined),
    previewUrl: i.previewUrl,
  });

  const pick = (key: string, make: () => Promise<PickedAsset>) =>
    void run(key, async () => {
      const a = await make();
      await onPick?.(a);
    });

  const libraryTile = (a: LibraryAsset) => (
    <AssetTile
      key={`lib:${a.id}`}
      tile={libTile(a)}
      mode={mode}
      pending={pending.has(`lib:${a.id}`)}
      highlighted={mode === "library" && selected === a.id}
      leaving={leaving.has(a.id)}
      onOpen={mode === "library" ? () => setViewingId(a.id) : undefined}
      onSelect={mode === "library" ? () => select(a) : undefined}
      onPick={() => pick(`lib:${a.id}`, () => Promise.resolve(pickedFromRow(a)))}
      pickLabel={pickLabel}
    />
  );
  const remoteNode = (i: RemoteItem) => {
    const t = remoteTile(i);
    return <AssetTile key={t.key} tile={t} mode={mode} pending={pending.has(t.key)} onPick={() => pick(t.key, () => importItem(i))} pickLabel={pickLabel} />;
  };

  // gate on the debounced query: mounting SourceTiles on the first keystroke would fire with dq still ""
  const activeProviders = !dq ? [] : remoteProviders.filter(providerFits);
  const activeIds = ["catalog", ...activeProviders.map((p) => p.id)];
  const libraryResolved = !list.isPending && rows.length === 0;
  const allResolved = activeIds.every((id) => states[id] && !states[id].pending && states[id].count === 0 && !states[id].notice);
  const nothing = libraryResolved && allResolved;
  const nextId = activeIds.find((id) => states[id]?.hasNext);
  const fetchingMore = activeIds.some((id) => states[id]?.fetching);
  // one muted line: every provider that has tiles in the grid
  const attribution = (() => {
    const ids = new Set<string>();
    for (const id of activeIds) if (states[id]?.count) ids.add(id === "catalog" ? "reelsaw" : id);
    const lines = (providers.data ?? []).filter((p) => ids.has(p.id) && p.attributionLine).map((p) => p.attributionLine as string);
    return [...new Set(lines)].join(" · ");
  })();

  return (
    <div className={`flex min-h-0 flex-col gap-4 ${className}`}>
      <div className="flex shrink-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <div className="relative min-w-0 flex-1 basis-full sm:basis-auto">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink3" aria-hidden />
            <input className="input h-[38px] w-full pl-9 pr-9" type="search" value={q} placeholder="Search uploads, the catalog and providers…" aria-label="Search uploads, the catalog and providers" onChange={(e) => setFilters({ q: e.target.value })} />
            {q && (
              <button type="button" className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-ink3 hover:bg-sunk hover:text-ink" aria-label="Clear search" onClick={() => setFilters({ q: "" })}>
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {mode === "library" && onUpload && (
            <button
              type="button"
              className="btn-ghost h-[38px] shrink-0 max-sm:w-full max-sm:justify-center"
              title="Videos: MP4, MOV or WebM up to 10 s and 50 MB. Images: PNG, JPG, WebP, GIF or SVG up to 20 MB. Audio: MP3, M4A, WAV, OGG or FLAC up to 15 min and 30 MB. You can also drop files anywhere on the page."
              onClick={onUpload}
            >
              {actions.uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              Upload
            </button>
          )}
        </div>
        {kindChips.length > 0 && (
          <div className="flex min-h-7 flex-wrap items-center gap-1.5" role="group" aria-label="Filter by kind">
            <Chip on={kind === ""} onClick={() => setFilters({ kind: "" })}>
              All
            </Chip>
            {kindChips.map((k) => (
              <Chip key={k.id} on={kind === k.id} onClick={() => setFilters({ kind: kind === k.id ? "" : k.id })}>
                {k.label}
              </Chip>
            ))}
          </div>
        )}
        {mode === "library" && actions.jobs.length > 0 && <UploadJobs jobs={actions.jobs} onDismiss={actions.dismiss} />}
      </div>

      <div className={`flex min-w-0 flex-col gap-3 ${mode === "picker" ? "min-h-0 flex-1 overflow-y-auto pr-1" : ""}`}>
        <ul className={gridClass(mode)} aria-label="Library, catalog and provider results">
          {list.isPending && Array.from({ length: 4 }, (_, i) => <AssetTileSkeleton key={`s${i}`} i={i} />)}
          {rows.map(libraryTile)}
          <SourceTiles key="catalog" sid="catalog" q={dq} kind={searchKind} kindOk={kindOk} node={remoteNode} register={register} unregister={unregister} />
          {activeProviders.map((p) => (
            <SourceTiles key={p.id} sid={p.id} provider={p.id} q={dq} kind={searchKind} license={p.id === "freesound" ? "cc0" : undefined} kindOk={kindOk} node={remoteNode} register={register} unregister={unregister} />
          ))}
        </ul>
        {nothing && <p className="rounded-[14px] border border-line bg-panel px-4 py-8 text-center text-sm text-ink3">{q.trim() ? `Nothing matches “${q.trim()}”.` : kind ? "Nothing matches this kind." : "Nothing here yet. Upload a file."}</p>}
        {nextId && (
          <div className="flex justify-center py-1">
            <button type="button" className="btn-ghost" disabled={fetchingMore} onClick={() => fetchers.current[nextId]?.()}>
              {fetchingMore ? <Loader2 size={14} className="animate-spin" /> : null}
              {fetchingMore ? "Loading…" : "Show more"}
            </button>
          </div>
        )}
        {attribution && <p className="text-xs text-ink3">{attribution}</p>}
        {mode === "library" && (list.data?.deleted.length ?? 0) > 0 && (
          <p className="text-xs text-ink3">
            {list.data!.deleted.length} removed {list.data!.deleted.length === 1 ? "item" : "items"} restorable from{" "}
            <Link to={DELETED_PATH} className="text-acc-text no-underline hover:underline">
              Deleted
            </Link>{" "}
            for 30 days.
          </p>
        )}
      </div>

      {mode === "library" && (
        <>
          <AssetLightbox
            asset={viewing}
            introId={defaults?.introAssetId}
            outroId={defaults?.outroAssetId}
            busy={actions.busy}
            onClose={() => setViewingId(null)}
            onUse={(slot) => viewing && actions.setDefault(slot, viewing, slot === "intro" ? defaults?.introAssetId : defaults?.outroAssetId)}
            onRemove={() => {
              if (!viewing) return;
              setViewingId(null);
              remove(viewing);
            }}
            onRename={(name) => viewing && void actions.rename(viewing, name)}
            onTags={(tags) => viewing && void actions.setTags(viewing, tags)}
          />
          <RemoveDialog asset={removing} onClose={() => setRemoving(null)} onConfirm={fadeOut} />
        </>
      )}
    </div>
  );
}

/**
 * The catalog (no provider) or one provider, drawn straight into the finder's grid (its tiles are this fragment).
 * Its query starts when its first slot (one skeleton tile) scrolls into view.
 */
function SourceTiles({
  sid,
  provider,
  q,
  kind,
  license,
  kindOk,
  node,
  register,
  unregister,
}: {
  sid: string;
  provider?: string;
  q: string;
  kind?: LibraryKind;
  license?: "cc0" | "by";
  kindOk: (k: string) => boolean;
  node: (i: RemoteItem) => React.ReactNode;
  register: (id: string, st: SourceState, fetchNext: () => void) => void;
  unregister: (id: string) => void;
}) {
  const trpc = useTRPC();
  const slot = useRef<HTMLLIElement>(null);
  const seen = useSeen(slot);
  const enabled = seen;
  const search = useInfiniteQuery(
    trpc.library.search.infiniteQueryOptions(
      { ...(provider ? { source: provider } : {}), q, kind, limit: PAGE, ...(license ? { license } : {}) },
      {
        // a remote provider with an empty q 400s (Iconify) or burns quota; the catalog lists everything
        enabled: enabled && (!provider || !!q),
        getNextPageParam: (last) => last.nextCursor ?? undefined,
        placeholderData: keepPreviousData,
        staleTime: 60_000,
      },
    ),
  );
  const items = (search.data?.pages.flatMap((p) => p.items) ?? []).filter((i) => kindOk(i.kind));
  const unavailable = search.data?.pages.find((p) => p.unavailable)?.unavailable;
  const nodes = items.map((i) => node(i)).filter(Boolean);
  const waiting = !enabled || (search.isPending && !search.isError);
  const notice = !!unavailable || search.isError;
  const { fetchNextPage } = search;
  useEffect(() => {
    register(sid, { pending: waiting, count: nodes.length, hasNext: !!search.hasNextPage, fetching: search.isFetchingNextPage, notice }, () => void fetchNextPage());
  }, [register, sid, waiting, nodes.length, search.hasNextPage, search.isFetchingNextPage, notice, fetchNextPage]);
  useEffect(() => () => unregister(sid), [unregister, sid]);
  return (
    <>
      {unavailable && (
        <li className="col-span-full">
          <Notice tone="warn">{unavailable}</Notice>
        </li>
      )}
      {search.isError && (
        <li className="col-span-full">
          <Notice tone="err">{search.error.message}</Notice>
        </li>
      )}
      {nodes}
      {!enabled ? <AssetTileSkeleton liRef={slot} /> : waiting ? Array.from({ length: 4 }, (_, i) => <AssetTileSkeleton key={`s${i}`} i={i} />) : null}
    </>
  );
}

/** The finder over the editor (or any page), in the repo's modal: menus portaled out of it are not dismissals (docs/UI.md). */
export function AssetFinderDialog({ open, onOpenChange, kinds, kind, onPick, title = "Add to clip" }: { open: boolean; onOpenChange: (o: boolean) => void; kinds?: LibraryKind[]; kind?: LibraryKind; onPick: (asset: PickedAsset) => void | Promise<void>; title?: string }) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} width={960}>
      {open && (
        <AssetFinder
          mode="picker"
          kinds={kinds}
          kind={kind}
          className="h-[min(640px,80dvh)]"
          onPick={async (a) => {
            await onPick(a);
            onOpenChange(false);
          }}
        />
      )}
    </Modal>
  );
}
