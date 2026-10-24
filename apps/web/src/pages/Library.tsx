import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { onBumperFiles, takePendingBumperFiles } from "../lib/uploads";
import { ScrollArea } from "../components/scroll-area";
import { AssetFinder } from "../components/AssetFinder";
import { UploadInput, useBumperActions } from "../components/BumperField";

/**
 * Your uploads, the catalog and the providers behind one finder (components/AssetFinder.tsx); Upload sits next to its search box.
 * Deep links: `#asset=<id>` highlights a tile, `?upload=1` opens the file picker, `?kind=audio&q=boom` filters.
 */
export function LibraryPage() {
  const nav = useNavigate();
  const loc = useLocation();
  const input = useRef<HTMLInputElement>(null);
  // a file that is already in the library highlights its tile instead of adding a copy
  const actions = useBumperActions({ onDuplicate: (id) => nav({ pathname: loc.pathname, search: loc.search, hash: `#asset=${id}` }, { replace: true }) });

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
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold tracking-tight">Library</h1>
          <p className="mt-1 min-h-5 text-sm text-ink2">Intros, overlays, stickers, b-roll and sounds for your clips</p>
        </div>
        <UploadInput inputRef={input} actions={actions} />
        <AssetFinder mode="library" actions={actions} onUpload={() => input.current?.click()} />
      </main>
    </ScrollArea>
  );
}
