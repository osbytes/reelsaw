import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { onBumperFiles, takePendingBumperFiles } from "../lib/uploads";
import { ScrollArea } from "../components/scroll-area";
import { Skeleton } from "../components/ui";
import { AssetFinder } from "../components/AssetFinder";
import { UploadCard, useBumperActions, useBumperLibrary } from "../components/BumperField";

/**
 * Your library, the catalog and the providers behind one finder (components/AssetFinder.tsx), with the upload card above it.
 * Deep links: `#asset=<id>` highlights a tile, `?upload=1` opens the file picker, `?kind=audio&source=catalog&q=boom` filters.
 */
export function LibraryPage() {
  const nav = useNavigate();
  const loc = useLocation();
  const input = useRef<HTMLInputElement>(null);
  const list = useBumperLibrary();
  // a file that is already in the library highlights its tile instead of adding a copy
  const actions = useBumperActions({ onDuplicate: (id) => nav({ pathname: loc.pathname, search: loc.search, hash: `#asset=${id}` }, { replace: true }) });
  const count = list.data?.assets.length ?? 0;

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

  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex max-w-[1180px] flex-col gap-6 px-4 py-7 sm:px-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[28px] font-bold tracking-tight">Library</h1>
            <p className="mt-1 min-h-5 text-sm text-ink2">Videos, images and audio you can attach to clips: intros, outros, overlays and music</p>
          </div>
          <span className="min-w-[4.5rem] text-right text-sm text-ink2">{list.isPending ? <Skeleton className="ml-auto h-3.5 w-12" /> : `${count} item${count === 1 ? "" : "s"}`}</span>
        </div>
        <UploadCard inputRef={input} actions={actions} />
        <AssetFinder mode="library" actions={actions} />
      </main>
    </ScrollArea>
  );
}
