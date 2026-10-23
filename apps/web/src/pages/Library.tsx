import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollText, Search, X } from "lucide-react";
import { ASSET_CATEGORIES, type AssetCategory } from "@reelsaw/shared";
import { useLocation, useNavigate } from "react-router";
import { useMe } from "../lib/account";
import { useHashParams } from "../lib/hash";
import { createFuzzy } from "../lib/fuzzy";
import { categoryLabel, KIND_FILTERS, matchesCategory, SEARCH_KEYS, searchable, UNCATEGORISED, type LibraryKind } from "../lib/library";
import { onBumperFiles, takePendingBumperFiles } from "../lib/uploads";
import { ScrollArea } from "../components/scroll-area";
import { Skeleton, SkeletonRegion } from "../components/ui";
import { AssetCard, AssetCardSkeleton, AssetLightbox, copyCredits, RemoveDialog, UploadCard, useBumperActions, useBumperLibrary, type LibraryAsset } from "../components/BumperField";

/**
 * Your asset library: videos, images and audio. Deep links: `#asset=<id>` highlights a card, `?upload=1` opens the file picker,
 * `?kind=audio&category=sfx&q=boom` filters.
 */
/** A filter pill with its count; the count has its own tabular slot so toggling never reflows the row. */
function Chip({ on, count, onClick, children }: { on: boolean; count: number; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition ${on ? "border-acc bg-acc-soft text-acc-text" : "border-line bg-panel text-ink2 hover:text-ink"}`}>
      {children}
      <span className="font-mono text-[11px] font-normal tabular-nums opacity-75">{count}</span>
    </button>
  );
}

export function LibraryPage() {
  const nav = useNavigate();
  const loc = useLocation();
  const input = useRef<HTMLInputElement>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<LibraryAsset | null>(null);
  // a card being removed fades out first, then the list refetches without it
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const fadeOut = (a: LibraryAsset) => {
    setLeaving((s) => new Set(s).add(a.id));
    window.setTimeout(() => void actions.remove(a).then(() => setLeaving((s) => (s.delete(a.id), new Set(s)))), 160);
  };
  const list = useBumperLibrary();
  // a file that is already in the library highlights its card instead of adding a copy
  const actions = useBumperActions({ onDuplicate: (id) => nav({ pathname: loc.pathname, search: loc.search, hash: `#asset=${id}` }, { replace: true }) });
  const defaults = useMe().data?.projectDefaults;
  const all = useMemo(() => list.data?.assets ?? [], [list.data]);
  const selected = useHashParams().get("asset");
  const params = new URLSearchParams(loc.search);
  const kindParam = params.get("kind");
  const kind: LibraryKind | "" = kindParam === "video" || kindParam === "image" || kindParam === "audio" ? kindParam : "";
  const category = params.get("category") ?? "";
  const q = params.get("q") ?? "";
  const setFilter = (patch: Record<string, string>) => {
    const next = new URLSearchParams(loc.search);
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    const search = next.toString();
    nav({ pathname: loc.pathname, search: search ? `?${search}` : "", hash: loc.hash }, { replace: true });
  };
  // search first, then each chip row counts what the other filters leave (so a count is what the click would show)
  const fuse = useMemo(() => createFuzzy(all.map(searchable), SEARCH_KEYS), [all]);
  const searched = useMemo(() => (q.trim() ? new Set(fuse.filter(q).map((a) => a.id)) : null), [fuse, q]);
  const inSearch = (a: LibraryAsset) => !searched || searched.has(a.id);
  const kindCount = (k: LibraryKind | "") => all.filter((a) => inSearch(a) && matchesCategory(a, category) && (!k || a.kind === k)).length;
  const catCount = (c: string) => all.filter((a) => inSearch(a) && (!kind || a.kind === kind) && matchesCategory(a, c)).length;
  const categoryChips = [
    ...ASSET_CATEGORIES.filter((c) => all.some((a) => a.category === c.id) || category === c.id).map((c) => ({ id: c.id as string, label: c.label as string })),
    ...(all.some((a) => !a.category) || category === UNCATEGORISED ? [{ id: UNCATEGORISED, label: "Uncategorised" }] : []),
  ];
  const assets = useMemo(() => {
    const ranked = q.trim() ? fuse.filter(q).map((a) => all.find((x) => x.id === a.id)!) : all;
    return ranked.filter((a) => (!kind || a.kind === kind) && matchesCategory(a, category));
  }, [all, fuse, q, kind, category]);
  const filtered = !!(kind || category || q.trim());
  // images whose length was just changed: their cards say "re-render to apply"
  const [applied, setApplied] = useState<Set<string>>(new Set());

  // files picked in ⌘K or the Projects menu, or dropped anywhere on this page, upload as one batch
  const uploadRef = useRef(actions.uploadMany);
  uploadRef.current = actions.uploadMany;
  useEffect(() => {
    const take = () => uploadRef.current(takePendingBumperFiles());
    take();
    return onBumperFiles(take);
  }, []);
  // ?upload=1 opens the picker (browsers may refuse without a click, so the file input is focused too)
  useEffect(() => {
    if (new URLSearchParams(loc.search).get("upload") !== "1") return;
    try {
      input.current?.click();
    } catch {
      /* needs a user gesture */
    }
    nav({ pathname: loc.pathname, hash: loc.hash }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.search]);
  // #asset=<id> scrolls its card into view once the list is there
  useEffect(() => {
    if (!selected || !assets.some((a) => a.id === selected)) return;
    document.getElementById(`asset-${selected}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, assets.length]);

  // the router location is the source of truth for the hash, so the highlight follows it
  const select = (a: LibraryAsset) => nav({ pathname: loc.pathname, search: loc.search, hash: selected === a.id ? "" : `#asset=${a.id}` }, { replace: true });

  const viewing = all.find((a) => a.id === viewingId) ?? null;
  const remove = (a: LibraryAsset) => (a.usedBy ? setRemoving(a) : fadeOut(a));

  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex max-w-[1180px] flex-col gap-6 px-4 py-7 sm:px-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[28px] font-bold tracking-tight">Library</h1>
            <p className="mt-1 min-h-5 text-sm text-ink2">Videos, images and audio you can attach to clips: intros, outros, overlays and music</p>
          </div>
          <button type="button" className="btn-ghost shrink-0 px-2.5 py-1.5 text-xs" disabled={list.isPending} onClick={() => copyCredits(all)} title="Plain-text credits for every item that needs an attribution or a license other than CC0">
            <ScrollText className="h-3.5 w-3.5" />
            Copy credits
          </button>
          <span className="min-w-[4.5rem] text-right text-sm text-ink2">{list.isPending ? <Skeleton className="ml-auto h-3.5 w-12" /> : filtered ? `${assets.length} of ${all.length}` : `${all.length} item${all.length === 1 ? "" : "s"}`}</span>
        </div>
        <UploadCard inputRef={input} actions={actions} />
        <div className="flex flex-col gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink3" aria-hidden />
            <input className="input h-[38px] w-full pl-9 pr-9" type="text" value={q} placeholder="Search names, tags, categories and credits…" aria-label="Search the library" onChange={(e) => setFilter({ q: e.target.value })} />
            {q && (
              <button type="button" className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-ink3 hover:bg-sunk hover:text-ink" aria-label="Clear search" onClick={() => setFilter({ q: "" })}>
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {/* the rows keep their height while the list loads, so the grid below never jumps */}
          <div className="flex h-8 items-center gap-1.5 overflow-x-auto" role="group" aria-label="Filter by kind">
            {list.isPending ? (
              <Skeleton className="h-7 w-64 rounded-full" />
            ) : (
              [{ id: "" as const, label: "All" }, ...KIND_FILTERS].map((k) => (
                <Chip key={k.id} on={kind === k.id} count={kindCount(k.id)} onClick={() => setFilter({ kind: k.id })}>
                  {k.label}
                </Chip>
              ))
            )}
          </div>
          <div className="flex h-8 items-center gap-1.5 overflow-x-auto" role="group" aria-label="Filter by category">
            {list.isPending ? (
              <Skeleton className="h-7 w-80 rounded-full" />
            ) : (
              categoryChips.map((c) => (
                <Chip key={c.id} on={category === c.id} count={catCount(c.id)} onClick={() => setFilter({ category: category === c.id ? "" : c.id })}>
                  {c.label}
                </Chip>
              ))
            )}
          </div>
        </div>
        {list.isPending ? (
          <SkeletonRegion label="Loading library…" className="grid grid-cols-2 content-start gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {Array.from({ length: 5 }, (_, i) => (
              <AssetCardSkeleton key={i} i={i} />
            ))}
          </SkeletonRegion>
        ) : (
        <div className="grid grid-cols-2 content-start gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {assets.length === 0 && (
            <div className="col-span-full grid h-[26rem] place-items-center rounded-[16px] border border-line bg-panel px-6 text-center text-sm text-ink3 sm:h-[30rem]">
              {filtered ? (
                <span className="flex flex-col items-center gap-3">
                  Nothing matches these filters.
                  <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setFilter({ kind: "", category: "", q: "" })}>
                    Clear filters
                  </button>
                </span>
              ) : (
                "Nothing here yet. Drop a video, an image or an audio file above to add your first item."
              )}
            </div>
          )}
          {assets.map((a) => (
            <AssetCard
              key={a.id}
              asset={a}
              introId={defaults?.introAssetId}
              outroId={defaults?.outroAssetId}
              busy={actions.busy}
              highlighted={selected === a.id}
              applied={applied.has(a.id)}
              leaving={leaving.has(a.id)}
              onSeconds={(sec) => void actions.setSeconds(a, sec).then((ok) => ok && setApplied((s) => new Set(s).add(a.id)))}
              onSelect={() => select(a)}
              onOpen={() => setViewingId(a.id)}
              onUse={(slot) => actions.setDefault(slot, a, slot === "intro" ? defaults?.introAssetId : defaults?.outroAssetId)}
              onRemove={() => remove(a)}
              onRename={(name) => void actions.rename(a, name)}
              onCategory={(c) => void actions.setCategory(a, c)}
            />
          ))}
        </div>
        )}
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
          onCategory={(c) => viewing && void actions.setCategory(viewing, c)}
          onTags={(tags) => viewing && void actions.setTags(viewing, tags)}
        />
        <RemoveDialog asset={removing} onClose={() => setRemoving(null)} onConfirm={fadeOut} />
      </main>
    </ScrollArea>
  );
}
