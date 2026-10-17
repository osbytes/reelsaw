import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Link2 } from "lucide-react";
import { useMe } from "../lib/account";
import { toast } from "sonner";
import { linkWith, useHashParams } from "../lib/hash";
import { onBumperFiles, takePendingBumperFiles } from "../lib/uploads";
import { ScrollArea } from "../components/scroll-area";
import { Skeleton, SkeletonRegion } from "../components/ui";
import { AssetCard, AssetCardSkeleton, AssetLightbox, RemoveDialog, UploadCard, useBumperActions, useBumperLibrary, type LibraryAsset } from "../components/BumperField";

/**
 * Your intro and outro library. Deep links: `#asset=<id>` highlights a card, `?upload=1` opens the file picker.
 */
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
  const assets = list.data?.assets ?? [];
  const selected = useHashParams().get("asset");
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

  const viewing = assets.find((a) => a.id === viewingId) ?? null;
  const remove = (a: LibraryAsset) => (a.usedBy ? setRemoving(a) : fadeOut(a));

  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex max-w-[1180px] flex-col gap-6 px-4 py-7 sm:px-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[28px] font-bold tracking-tight">Library</h1>
            <p className="mt-1 min-h-5 text-sm text-ink2">Intros and outros you can attach to clips</p>
          </div>
          <span className="min-w-[4.5rem] text-right text-sm text-ink2">{list.isPending ? <Skeleton className="ml-auto h-3.5 w-12" /> : `${assets.length} item${assets.length === 1 ? "" : "s"}`}</span>
          <button
            type="button"
            className="btn-ghost min-w-[7.5rem]"
            disabled={!selected}
            onClick={() => selected && void navigator.clipboard.writeText(linkWith({ asset: selected }, "/library")).then(() => toast("Link copied"))}
            title={selected ? "Copy a link to the selected item" : "Select an item to link to it"}
          >
            <Link2 className="h-4 w-4" /> Copy link
          </button>
        </div>
        <UploadCard inputRef={input} actions={actions} />
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
              Nothing here yet. Drop a video or an image above to add your first intro or outro.
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
        />
        <RemoveDialog asset={removing} onClose={() => setRemoving(null)} onConfirm={fadeOut} />
      </main>
    </ScrollArea>
  );
}
