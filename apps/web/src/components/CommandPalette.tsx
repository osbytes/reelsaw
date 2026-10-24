import { createContext, lazy, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import { useShortcut } from "../lib/shortcuts";
import { useSession } from "../lib/auth";
import { isOnlyUrls } from "../lib/links";
import { ErrorBoundary } from "./ErrorBoundary";

/** Whitespace and newlines collapse to single spaces so a pasted list of links survives a one-line input. */
const oneLine = (s: string) => s.trim().split(/\s+/).join(" ");

// the palette (search, fuzzy ranking, actions) loads the first time it opens, not with the app
const Palette = lazy(() => import("./CommandPaletteDialog").then((m) => ({ default: m.Palette })));

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
    { enabled: !!session, inFields: true },
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
          <Suspense fallback={null}>
            <Palette open={open} onOpenChange={setOpen} q={q} setQ={setQ} />
          </Suspense>
        </ErrorBoundary>
      )}
    </Ctx.Provider>
  );
}
