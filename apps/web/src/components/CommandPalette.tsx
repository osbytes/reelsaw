import { createContext, lazy, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import { Trans } from "@lingui/react/macro";
import { useShortcut } from "../lib/shortcuts";
import { useSession } from "../lib/auth";
import { isOnlyUrls } from "../lib/links";
import { prefetchWhenIdle } from "../lib/stale-chunk";
import { ErrorBoundary } from "./ErrorBoundary";
import { Spinner } from "./ui";

/** Whitespace and newlines collapse to single spaces so a pasted list of links survives a one-line input. */
const oneLine = (s: string) => s.trim().split(/\s+/).join(" ");

// the palette (search, fuzzy ranking, actions) stays out of the first bundle; it prefetches once the
// app is idle so ⌘K still opens after a deploy has replaced the chunk files
const loadPalette = () => import("./CommandPaletteDialog");
/** Fetch the palette's code before it is asked for (hovering or focusing the search button). Safe to call often. */
export const prefetchPalette = () => void loadPalette().catch(() => {});

/**
 * What a first open shows while the palette's code arrives: the same box, at once. With nothing there, a second
 * click to "try again" landed on the palette's overlay as it appeared and closed it.
 */
function PaletteLoading({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="fixed inset-0 z-[85] bg-black/40" onClick={onClose} aria-hidden />
      <div
        role="status"
        className="fixed start-1/2 top-[12dvh] z-[86] flex h-[52px] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 items-center gap-3 rounded-[18px] border border-line bg-panel px-4 text-[15px] text-ink3 shadow-pop"
      >
        <Spinner />
        <Trans>Search projects, clips and your library, or paste video links…</Trans>
      </div>
    </>
  );
}
const Palette = lazy(() => loadPalette().then((m) => ({ default: m.Palette })));

const Ctx = createContext<(q?: string) => void>(() => {});
export const useCommandPalette = () => useContext(Ctx);

/**
 * ⌘K: jump to a project or clip, run an action, or paste a video link to start a project.
 * A link (or a list of links) pasted anywhere outside a text field opens it too.
 */
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (open) setLoaded(true);
  }, [open]);
  const [q, setQ] = useState("");
  const { data: session } = useSession();
  useEffect(() => {
    if (session) prefetchWhenIdle(loadPalette);
  }, [!!session]);
  const show = (initial = "") => {
    setQ(initial);
    setOpen(true);
  };
  useShortcut(
    "mod+k",
    () => {
      setOpen((o) => !o);
      setQ("");
    },
    { enabled: !!session, inFields: true, inDialogs: true },
  );
  useEffect(() => {
    if (!session) return;
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]")) return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (isOnlyUrls(text)) {
        e.preventDefault();
        show(oneLine(text));
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [session]);
  return (
    <Ctx.Provider value={show}>
      {children}
      {session && (open || loaded) && (
        <ErrorBoundary quiet>
          <Suspense fallback={open ? <PaletteLoading onClose={() => setOpen(false)} /> : null}>
            <Palette open={open} onOpenChange={setOpen} q={q} setQ={setQ} />
          </Suspense>
        </ErrorBoundary>
      )}
    </Ctx.Provider>
  );
}
