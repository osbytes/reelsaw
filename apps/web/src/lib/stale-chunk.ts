/**
 * After a deploy, a tab that still has the previous HTML asks for hashed chunks that no longer
 * exist. Vite emits `vite:preloadError`; React.lazy surfaces the same as a failed dynamic import.
 *
 * Do not preventDefault on the Vite event: the preload helper then resolves to undefined and
 * React.lazy throws a different error. Let the rejected import reach the nearest ErrorBoundary.
 *
 * Reload only when nothing is unsaved. If the clip editor is dirty, set a persistent nudge
 * (header chip) instead: a toast disappears, a modal blocks, and a bar above the page would
 * shift layout (docs/PRINCIPLES.md). The user refreshes when ready; beforeunload still warns.
 */
import { useSyncExternalStore } from "react";
import { hasUnsaved } from "./unsaved";

const RELOAD_KEY = "reelsaw.stale-chunk-reload";

const nudgeListeners = new Set<() => void>();
let nudge = false;
let reloadInFlight = false;

export function isStaleChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|unable to preload css/i.test(msg);
}

export function staleChunkReloadUsed(): boolean {
  try {
    return sessionStorage.getItem(RELOAD_KEY) === "1";
  } catch {
    return true;
  }
}

export function staleChunkReloadInFlight() {
  return reloadInFlight;
}

/** Reload this tab once. Returns true when the reload was started. */
export function reloadOnceForStaleChunk(): boolean {
  if (reloadInFlight || staleChunkReloadUsed()) return false;
  try {
    sessionStorage.setItem(RELOAD_KEY, "1");
  } catch {
    return false;
  }
  reloadInFlight = true;
  location.reload();
  return true;
}

export type StaleChunkAction = "reload" | "nudge" | "ignore";

/**
 * Reload if the tab has no unsaved edits; otherwise keep the current tree and show the chip.
 * A second failure in a tab that already reloaded is ignored so a missing file cannot loop.
 */
export function handleStaleChunk(): StaleChunkAction {
  if (staleChunkReloadUsed() || reloadInFlight) return "ignore";
  if (!hasUnsaved()) {
    return reloadOnceForStaleChunk() ? "reload" : "ignore";
  }
  if (!nudge) {
    nudge = true;
    for (const l of nudgeListeners) l();
  }
  return "nudge";
}

export function staleChunkNudgePending() {
  return nudge;
}

export function subscribeStaleChunkNudge(fn: () => void) {
  nudgeListeners.add(fn);
  return () => nudgeListeners.delete(fn);
}

export function useStaleChunkNudge() {
  return useSyncExternalStore(subscribeStaleChunkNudge, staleChunkNudgePending, () => false);
}

/** Explicit Refresh: do not set the once-flag first, so a cancelled beforeunload can stay. */
export function refreshForNewVersion() {
  location.reload();
}

export function installStaleChunkHandler() {
  window.addEventListener("vite:preloadError", () => {
    handleStaleChunk();
  });
}
