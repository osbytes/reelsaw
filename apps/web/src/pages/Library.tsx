import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Link2 } from "lucide-react";
import { useMe } from "../lib/account";
import { useToast } from "../lib/toast";
import { linkWith, useHashParams } from "../lib/hash";
import { takePendingBumperFile } from "../lib/uploads";
import { ScrollArea } from "../components/scroll-area";
import { AssetCard, RemovedList, RemoveDialog, UploadBar, useBumperActions, useBumperLibrary, type LibraryAsset } from "../components/BumperField";

/**
 * Your intro and outro library. Deep links: `#asset=<id>` highlights a card, `?upload=1` opens the file picker.
 */
export function LibraryPage() {
  const nav = useNavigate();
  const loc = useLocation();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [imageSec, setImageSec] = useState("3");
  const [removing, setRemoving] = useState<LibraryAsset | null>(null);
  const list = useBumperLibrary();
  const actions = useBumperActions();
  const defaults = useMe().data?.projectDefaults;
  const assets = list.data?.assets ?? [];
  const deleted = list.data?.deleted ?? [];
  const selected = useHashParams().get("asset");

  // a file picked from ⌘K or the Projects menu uploads on arrival
  useEffect(() => {
    const f = takePendingBumperFile();
    if (f) void actions.upload(f, "3");
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex max-w-[1180px] flex-col gap-4 px-4 py-7 sm:px-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[28px] font-bold tracking-tight">Library</h1>
            <p className="mt-1 min-h-5 text-sm text-ink2">Short videos or images of yours, added to the start and end of every clip. Pick a default intro and outro for new projects; each project can change or drop them later.</p>
          </div>
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
        <UploadBar inputRef={input} actions={actions} imageSec={imageSec} setImageSec={setImageSec} />
        <div className="min-h-4 text-xs text-err" role="status">
          {actions.error}
        </div>
        {/* the grid keeps its height while loading or empty */}
        <div className="grid min-h-[230px] grid-cols-2 content-start gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {assets.length === 0 && <p className="col-span-full text-xs text-ink3">{list.isLoading ? "Loading…" : "Nothing here yet. Add a video or an image above."}</p>}
          {assets.map((a) => (
            <AssetCard
              key={a.id}
              asset={a}
              introId={defaults?.introAssetId}
              outroId={defaults?.outroAssetId}
              busy={actions.busy}
              highlighted={selected === a.id}
              onSelect={() => select(a)}
              onUse={(slot) => actions.setDefault(slot, a, slot === "intro" ? defaults?.introAssetId : defaults?.outroAssetId)}
              onRemove={() => (a.usedBy ? setRemoving(a) : actions.remove(a))}
            />
          ))}
        </div>
        <RemovedList deleted={deleted} busy={actions.busy} onRestore={actions.restore} />
        <RemoveDialog asset={removing} onClose={() => setRemoving(null)} onConfirm={actions.remove} />
      </main>
    </ScrollArea>
  );
}
