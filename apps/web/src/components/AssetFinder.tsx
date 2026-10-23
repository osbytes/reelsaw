/**
 * The one finder: your library, the Reelsaw catalog and every enabled provider behind one search box.
 * `mode="library"` is the Library page body (filters live in the URL: ?kind=&source=&q=, #asset=<id>);
 * `mode="picker"` is the editor's dialog (filters are local, each tile has a "use" button).
 * Server: `bumpers.list`, `catalog.providers / search / import`, `library.save` (same services as the MCP tools).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { Loader2, Search, X } from "lucide-react";
import { toast } from "sonner";
import { useLocation, useNavigate } from "react-router";
import type { AppRouter } from "@reelsaw/server";
import { useTRPC } from "../lib/trpc";
import { useMe } from "../lib/account";
import { useHashParams } from "../lib/hash";
import { createFuzzy } from "../lib/fuzzy";
import { KIND_FILTERS, SEARCH_KEYS, searchable, type LibraryKind } from "../lib/library";
import { AssetLightbox, RemoveDialog, useBumperActions, useBumperLibrary, type LibraryAsset } from "./BumperField";
import { AssetTile, AssetTileSkeleton, type TileModel } from "./AssetTile";
import { Modal, Notice, Skeleton } from "./ui";

type Out = inferRouterOutputs<AppRouter>;
type RemoteItem = Out["catalog"]["search"]["items"][number];
type Provider = Out["catalog"]["providers"][number];

/** What a pick hands back: the fields the editor's layer helpers need. */
export interface PickedAsset {
  id: string;
  name: string;
  kind: LibraryKind;
  durationSec: number;
}

const PAGE = 24;
/** in the All view a remote section shows this many tiles, then "See all" */
const PEEK = 8;

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** true once the element has been on screen (stays true), so a section's query runs lazily */
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

function Chip({ on, count, onClick, children }: { on: boolean; count?: number; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition ${on ? "border-acc bg-acc-soft text-acc-text" : "border-line bg-panel text-ink2 hover:text-ink"}`}>
      {children}
      {count !== undefined && <span className="min-w-[1.25ch] text-right font-mono text-[11px] font-normal tabular-nums opacity-75">{count}</span>}
    </button>
  );
}

interface Filters {
  kind: LibraryKind | "";
  q: string;
  /** "" = all sources, "library", "catalog" or a provider id */
  source: string;
}

/** Filters in the URL (library page, shareable) or in state (the dialog). Both hooks always run; one is used. */
function useFilters(mode: "library" | "picker"): [Filters, (patch: Partial<Filters>) => void] {
  const nav = useNavigate();
  const loc = useLocation();
  const [local, setLocal] = useState<Filters>({ kind: "", q: "", source: "" });
  if (mode === "picker") return [local, (p) => setLocal((f) => ({ ...f, ...p }))];
  const params = new URLSearchParams(loc.search);
  const k = params.get("kind");
  const f: Filters = { kind: k === "video" || k === "image" || k === "audio" ? k : "", q: params.get("q") ?? "", source: params.get("source") ?? "" };
  return [
    f,
    (patch) => {
      const next = new URLSearchParams(loc.search);
      for (const [key, v] of Object.entries(patch)) (v ? next.set(key, v) : next.delete(key));
      const search = next.toString();
      nav({ pathname: loc.pathname, search: search ? `?${search}` : "", hash: loc.hash }, { replace: true });
    },
  ];
}

const Count = ({ children }: { children: React.ReactNode }) => <span className="inline-block min-w-[2.5ch] font-mono text-xs font-normal tabular-nums text-ink3">{children}</span>;

function SectionHead({ title, count, children }: { title: string; count: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
      <h2 className="text-sm font-bold">
        {title} <Count>{count}</Count>
      </h2>
      {children}
    </div>
  );
}

const gridClass = (mode: "library" | "picker") => (mode === "picker" ? "grid grid-cols-1 content-start gap-3 min-[480px]:grid-cols-2 sm:grid-cols-3 md:grid-cols-4" : "grid grid-cols-1 content-start gap-4 min-[480px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5");

function SkeletonGrid({ mode, n = 4, label }: { mode: "library" | "picker"; n?: number; label: string }) {
  return (
    <ul role="status" aria-busy="true" className={gridClass(mode)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: n }, (_, i) => (
        <AssetTileSkeleton key={i} i={i} />
      ))}
    </ul>
  );
}

const rowKey = (provider: string, externalId: string) => `${provider}:${externalId}`;

export interface AssetFinderProps {
  /** limit to these kinds (the editor's pickers know what they want) */
  kinds?: LibraryKind[];
  /** shorthand for `kinds={[kind]}` */
  kind?: LibraryKind;
  mode?: "library" | "picker";
  /** picker: called with the library asset once it is in the library (imported / saved first when it was not) */
  onPick?: (asset: PickedAsset) => void | Promise<void>;
  /** library mode: the page's actions (uploads share them) */
  actions?: ReturnType<typeof useBumperActions>;
  className?: string;
  pickLabel?: string;
}

export function AssetFinder({ kinds: kindsProp, kind: kindProp, mode = "library", onPick, actions: actionsProp, className = "", pickLabel }: AssetFinderProps) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const allowed = useMemo(() => kindsProp ?? (kindProp ? [kindProp] : undefined), [kindsProp, kindProp]);
  const [filters, setFilters] = useFilters(mode);
  const own = useBumperActions();
  const actions = actionsProp ?? own;
  const list = useBumperLibrary();
  const providers = useQuery(trpc.catalog.providers.queryOptions());
  const defaults = useMe().data?.projectDefaults;
  const selected = useHashParams().get("asset");
  const [color, setColor] = useState("#ffffff");
  const [license, setLicense] = useState<"cc0" | "by">("cc0");
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<LibraryAsset | null>(null);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());

  const { kind, q, source } = filters;
  const dq = useDebounced(q.trim());
  const all = useMemo(() => (list.data?.assets ?? []).filter((a) => !allowed || allowed.includes(a.kind)), [list.data, allowed]);
  const byRemote = useMemo(() => {
    const m = new Map<string, LibraryAsset>();
    for (const a of list.data?.assets ?? []) if (a.provenance?.externalId) m.set(rowKey(a.provenance.provider, a.provenance.externalId), a);
    return m;
  }, [list.data]);

  // search first; the kind chips count what the search leaves (so a count is what the click would show)
  const fuse = useMemo(() => createFuzzy(all.map(searchable), SEARCH_KEYS), [all]);
  const searched = useMemo(() => (q.trim() ? new Set(fuse.filter(q).map((a) => a.id)) : null), [fuse, q]);
  const kindCount = (k: LibraryKind | "") => all.filter((a) => (!searched || searched.has(a.id)) && (!k || a.kind === k)).length;
  const rows = useMemo(() => {
    const ranked = q.trim() ? fuse.filter(q).map((a) => all.find((x) => x.id === a.id)!) : all;
    return ranked.filter((a) => !kind || a.kind === kind);
  }, [all, fuse, q, kind]);
  const kindChips = KIND_FILTERS.filter((k) => !allowed || allowed.includes(k.id));
  // a single allowed kind is the filter; otherwise the chip decides
  const searchKind = kind || (allowed?.length === 1 ? allowed[0] : undefined);
  const remoteProviders = (providers.data ?? []).filter((p) => p.id !== "reelsaw");
  const providerFits = (p: Provider) => !searchKind || (p.kinds as readonly string[]).includes(searchKind);
  const kindOk = (k: string) => !allowed || (allowed as readonly string[]).includes(k);

  // an unknown / switched-off source falls back to All
  useEffect(() => {
    if (!source || source === "library" || source === "catalog" || !providers.data) return;
    if (!remoteProviders.some((p) => p.id === source)) setFilters({ source: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.data, source]);

  // #asset=<id> scrolls its tile into view once the list is there
  useEffect(() => {
    if (mode !== "library" || !selected || !rows.some((a) => a.id === selected)) return;
    document.getElementById(`asset-${selected}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, rows.length]);

  const importM = useMutation(trpc.catalog.import.mutationOptions());
  const saveM = useMutation(trpc.library.save.mutationOptions());
  const refreshList = () => void qc.invalidateQueries({ queryKey: trpc.bumpers.pathKey() });

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
  const importItem = async (i: RemoteItem): Promise<PickedAsset> => {
    const a = await importM.mutateAsync({ provider: i.provider, externalId: i.externalId, ...(i.provider === "iconify" ? { color } : {}) });
    toast(a.duplicate ? `${a.name} is already in your library${a.restored ? " (restored)" : ""}.` : `Added ${a.name} to your library.`);
    refreshList();
    return { id: a.id, name: a.name, kind: a.kind as LibraryKind, durationSec: a.durationSec };
  };
  const pickedFromRow = (r: LibraryAsset): PickedAsset => ({ id: r.id, name: r.name, kind: r.kind, durationSec: r.durationSec });
  const saveRow = async (r: LibraryAsset): Promise<PickedAsset> => {
    await saveM.mutateAsync({ id: r.id });
    toast(`Added ${r.name} to your library.`);
    refreshList();
    return pickedFromRow(r);
  };

  const fadeOut = (a: LibraryAsset) => {
    setLeaving((s) => new Set(s).add(a.id));
    window.setTimeout(() => void actions.remove(a).then(() => setLeaving((s) => (s.delete(a.id), new Set(s)))), 160);
  };
  const remove = (a: LibraryAsset) => (a.usedBy ? setRemoving(a) : fadeOut(a));
  const select = (a: LibraryAsset) => nav({ pathname: loc.pathname, search: loc.search, hash: selected === a.id ? "" : `#asset=${a.id}` }, { replace: true });
  const viewing = list.data?.assets.find((a) => a.id === viewingId) ?? null;

  const libTile = (r: LibraryAsset): TileModel => ({
    key: `lib:${r.id}`,
    kind: r.kind,
    name: r.name,
    mime: r.mime,
    durationSec: r.durationSec,
    width: r.width,
    height: r.height,
    thumbUrl: r.kind === "audio" ? undefined : r.thumbnailUrl,
    previewUrl: r.kind === "image" ? undefined : `/media/bumpers/${r.id}`,
    row: r,
  });
  const remoteTile = (i: RemoteItem): TileModel => ({
    key: `remote:${rowKey(i.provider, i.externalId)}`,
    kind: i.kind,
    name: i.name,
    mime: i.mime,
    durationSec: i.durationSec,
    width: i.width,
    height: i.height,
    thumbUrl: i.thumbUrl ?? (i.kind === "image" ? i.previewUrl : undefined),
    previewUrl: i.previewUrl,
    license: { name: i.license.name, url: i.license.url, attribution: i.attribution },
    row: byRemote.get(rowKey(i.provider, i.externalId)),
  });

  const pick = (key: string, make: () => Promise<PickedAsset>) =>
    void run(key, async () => {
      const a = await make();
      await onPick?.(a);
    });

  const showLibrary = !source || source === "library";
  const showCatalog = !source || source === "catalog";
  const empty = !q.trim();

  const section = (props: { id?: string; title: string; attribution?: string; extra?: React.ReactNode }) => (
    <RemoteSection
      key={props.id ?? "catalog"}
      provider={props.id}
      title={props.title}
      attribution={props.attribution}
      extra={props.extra}
      q={dq}
      rawQ={q}
      kind={searchKind}
      license={props.id === "freesound" ? license : undefined}
      forced={source === (props.id ?? "catalog")}
      peek={!source}
      mode={mode}
      kindOk={kindOk}
      tile={remoteTile}
      pending={pending}
      onSeeAll={() => setFilters({ source: props.id ?? "catalog" })}
      onAdd={(i, t) => void run(t.key, async () => void (t.row && t.unsavedShared ? await saveRow(t.row) : await importItem(i)))}
      onPick={(i, t) => pick(t.key, () => (t.row ? (t.unsavedShared ? saveRow(t.row) : Promise.resolve(pickedFromRow(t.row))) : importItem(i)))}
      pickLabel={pickLabel}
    />
  );

  return (
    <div className={`flex min-h-0 flex-col gap-4 ${className}`}>
      <div className="flex shrink-0 flex-col gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink3" aria-hidden />
          <input className="input h-[38px] w-full pl-9 pr-9" type="search" value={q} placeholder="Search your library, the catalog and providers…" aria-label="Search your library, the catalog and providers" onChange={(e) => setFilters({ q: e.target.value })} />
          {q && (
            <button type="button" className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-ink3 hover:bg-sunk hover:text-ink" aria-label="Clear search" onClick={() => setFilters({ q: "" })}>
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex min-h-7 flex-wrap items-center gap-1.5" role="group" aria-label="Filter by kind">
          {list.isPending ? (
            <Skeleton className="h-7 w-64 rounded-full" />
          ) : (
            <>
              <Chip on={kind === ""} count={kindCount("")} onClick={() => setFilters({ kind: "" })}>
                All
              </Chip>
              {kindChips.map((k) => (
                <Chip key={k.id} on={kind === k.id} count={kindCount(k.id)} onClick={() => setFilters({ kind: kind === k.id ? "" : k.id })}>
                  {k.label}
                </Chip>
              ))}
            </>
          )}
        </div>
        <div className="flex min-h-7 flex-wrap items-center gap-1.5" role="group" aria-label="Filter by source">
          {providers.isPending ? (
            <Skeleton className="h-7 w-72 rounded-full" />
          ) : (
            <>
              <Chip on={source === ""} onClick={() => setFilters({ source: "" })}>
                All
              </Chip>
              <Chip on={source === "library"} onClick={() => setFilters({ source: "library" })}>
                Your library
              </Chip>
              <Chip on={source === "catalog"} onClick={() => setFilters({ source: "catalog" })}>
                Catalog
              </Chip>
              {remoteProviders.map((p) => (
                <button key={p.id} type="button" aria-pressed={source === p.id} title={p.available ? p.attributionLine : "Rate limited; try again in a minute"} onClick={() => setFilters({ source: p.id })} className={`inline-flex h-7 shrink-0 items-center rounded-full border px-3 text-xs font-semibold transition ${source === p.id ? "border-acc bg-acc-soft text-acc-text" : "border-line bg-panel text-ink2 hover:text-ink"}`}>
                  {p.label}
                </button>
              ))}
            </>
          )}
        </div>
      </div>

      <div className={`flex min-w-0 flex-col gap-6 ${mode === "picker" ? "min-h-0 flex-1 overflow-y-auto pr-1" : ""}`}>
        {showLibrary && (
          <section aria-label="Your library" className="flex flex-col gap-2">
            <SectionHead title="Your library" count={list.isPending ? "" : rows.length} />
            {list.isPending ? (
              <SkeletonGrid mode={mode} label="Loading your library…" />
            ) : rows.length === 0 ? (
              <p className="rounded-[14px] border border-line bg-panel px-4 py-8 text-center text-sm text-ink3">{q.trim() || kind ? "No matches in your library." : "Nothing here yet. Drop a file above, or add something from the catalog below."}</p>
            ) : (
              <ul className={`${gridClass(mode)} ${list.isFetching ? "" : ""}`}>
                {rows.map((a) => (
                  <AssetTile
                    key={a.id}
                    tile={libTile(a)}
                    mode={mode}
                    pending={pending.has(`lib:${a.id}`)}
                    highlighted={mode === "library" && selected === a.id}
                    introId={defaults?.introAssetId}
                    outroId={defaults?.outroAssetId}
                    applied={applied.has(a.id)}
                    leaving={leaving.has(a.id)}
                    busy={actions.busy}
                    onAdd={() => {}}
                    onOpen={mode === "library" ? () => setViewingId(a.id) : undefined}
                    onSelect={mode === "library" ? () => select(a) : undefined}
                    onSeconds={mode === "library" ? (sec) => void actions.setSeconds(a, sec).then((ok) => ok && setApplied((s) => new Set(s).add(a.id))) : undefined}
                    onPick={() => pick(`lib:${a.id}`, () => Promise.resolve(pickedFromRow(a)))}
                    pickLabel={pickLabel}
                  />
                ))}
              </ul>
            )}
          </section>
        )}

        {showCatalog && section({ title: "Catalog", attribution: providers.data?.find((p) => p.id === "reelsaw")?.attributionLine })}

        {!empty &&
          remoteProviders
            .filter((p) => (source ? source === p.id : providerFits(p)))
            .map((p) =>
              section({
                id: p.id,
                title: p.experimental ? `${p.label} (beta)` : p.label,
                attribution: p.attributionLine,
                extra:
                  p.id === "freesound" ? (
                    <div className="flex gap-1" role="group" aria-label="License">
                      <Chip on={license === "cc0"} onClick={() => setLicense("cc0")}>
                        CC0
                      </Chip>
                      <Chip on={license === "by"} onClick={() => setLicense("by")}>
                        CC0 + BY
                      </Chip>
                    </div>
                  ) : p.id === "iconify" ? (
                    <label className="flex items-center gap-1.5 text-xs text-ink2">
                      Color
                      <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-7 w-7 cursor-pointer rounded border border-line bg-panel p-0.5" aria-label="Icon color" />
                    </label>
                  ) : undefined,
              }),
            )}
        {empty && source && source !== "library" && source !== "catalog" && <p className="py-10 text-center text-sm text-ink3">Type to search {remoteProviders.find((p) => p.id === source)?.label ?? "this provider"}.</p>}
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

/** The catalog (no provider) or one provider: lazy query, skeleton while pending, attribution under it. */
function RemoteSection({
  provider,
  title,
  attribution,
  extra,
  q,
  rawQ,
  kind,
  license,
  forced,
  peek,
  mode,
  kindOk,
  tile,
  pending,
  onSeeAll,
  onAdd,
  onPick,
  pickLabel,
}: {
  provider?: string;
  title: string;
  attribution?: string;
  extra?: React.ReactNode;
  q: string;
  rawQ: string;
  kind?: LibraryKind;
  license?: "cc0" | "by";
  forced: boolean;
  peek: boolean;
  mode: "library" | "picker";
  kindOk: (k: string) => boolean;
  tile: (i: RemoteItem) => TileModel;
  pending: Set<string>;
  onSeeAll: () => void;
  onAdd: (i: RemoteItem, t: TileModel) => void;
  onPick: (i: RemoteItem, t: TileModel) => void;
  pickLabel?: string;
}) {
  const trpc = useTRPC();
  const ref = useRef<HTMLElement>(null);
  const seen = useSeen(ref);
  // the catalog lists everything for an empty search; providers are only mounted with words
  const enabled = forced || seen;
  const search = useInfiniteQuery(
    trpc.catalog.search.infiniteQueryOptions(
      { ...(provider ? { provider } : {}), q, kind, limit: PAGE, ...(license ? { license } : {}) },
      { enabled, getNextPageParam: (last) => last.nextCursor ?? undefined, placeholderData: keepPreviousData, staleTime: 60_000 },
    ),
  );
  const items = useMemo(() => (search.data?.pages.flatMap((p) => p.items) ?? []).filter((i) => kindOk(i.kind)), [search.data, kindOk]);
  const unavailable = search.data?.pages.find((p) => p.unavailable)?.unavailable;
  const isPending = !enabled || search.isPending;
  const shown = peek ? items.slice(0, PEEK) : items;
  return (
    <section ref={ref} aria-label={title} className="flex flex-col gap-2">
      <SectionHead title={title} count={isPending ? "" : `${items.length}${search.hasNextPage ? "+" : ""}`}>
        {extra}
        {peek && !isPending && items.length > PEEK && (
          <button type="button" className="ml-auto text-xs font-semibold text-acc-text hover:underline" onClick={onSeeAll}>
            See all
          </button>
        )}
      </SectionHead>
      {unavailable && <Notice tone="warn">{unavailable}</Notice>}
      {search.isError && <Notice tone="err">{search.error.message}</Notice>}
      {isPending && !search.isError ? (
        <SkeletonGrid mode={mode} label={`Searching ${title}…`} />
      ) : items.length === 0 && !unavailable && !search.isError ? (
        <p className="rounded-[14px] border border-line bg-panel px-4 py-8 text-center text-sm text-ink3">{rawQ.trim() ? `No matches for “${rawQ.trim()}”.` : "Nothing here yet."}</p>
      ) : (
        <>
          <ul className={`${gridClass(mode)} transition-opacity ${search.isPlaceholderData ? "opacity-60" : ""}`} aria-busy={search.isPlaceholderData}>
            {shown.map((i) => {
              const t = tile(i);
              return <AssetTile key={t.key} tile={t} mode={mode} pending={pending.has(t.key)} busy={false} onAdd={() => onAdd(i, t)} onPick={() => onPick(i, t)} pickLabel={pickLabel} />;
            })}
          </ul>
          {!peek && search.hasNextPage && (
            <div className="flex justify-center py-1">
              <button type="button" className="btn-ghost" disabled={search.isFetchingNextPage} onClick={() => void search.fetchNextPage()}>
                {search.isFetchingNextPage ? <Loader2 size={14} className="animate-spin" /> : null}
                {search.isFetchingNextPage ? "Loading…" : "Show more"}
              </button>
            </div>
          )}
        </>
      )}
      {attribution && <p className="text-xs text-ink3">{attribution}</p>}
    </section>
  );
}

/** The finder over the editor (or any page), in the repo's modal: menus portaled out of it are not dismissals (docs/UI.md). */
export function AssetFinderDialog({ open, onOpenChange, kinds, kind, onPick, title = "Find media" }: { open: boolean; onOpenChange: (o: boolean) => void; kinds?: LibraryKind[]; kind?: LibraryKind; onPick: (asset: PickedAsset) => void | Promise<void>; title?: string }) {
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
