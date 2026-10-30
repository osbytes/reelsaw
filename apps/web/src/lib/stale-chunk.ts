/**
 * After a deploy, a tab that still has the previous HTML asks for hashed chunks that no longer
 * exist. Vite emits `vite:preloadError`; React.lazy surfaces the same as a failed dynamic import.
 *
 * Do not preventDefault on the Vite event: the preload helper then resolves to undefined and
 * React.lazy throws a different error. Let the rejected import reach the nearest ErrorBoundary.
 *
 * Prevention beats recovery: the server stamps every API response with its build id
 * (X-Reelsaw-Build), and a tab whose page came from another build reloads on its next route change
 * (noteServerBuild / reloadIfNewBuild), before it asks for a chunk that is gone. Lazy pieces that
 * open without a route change (the command palette) prefetch on idle instead.
 *
 * Reload only when nothing is unsaved. If the clip editor is dirty, set a persistent nudge
 * (header chip) instead: a toast disappears, a modal blocks, and a bar above the page would
 * shift layout (docs/PRINCIPLES.md). The user refreshes when ready; beforeunload still warns.
 */
import { useSyncExternalStore } from "react";
import { hasUnsaved } from "./unsaved";

const RELOAD_KEY = "reelsaw.stale-chunk-reload";
/** A second stale chunk this soon after the last automatic reload means the file is really missing: stop, don't loop. */
const RELOAD_GUARD_MS = 30_000;

const nudgeListeners = new Set<() => void>();
let nudge = false;
let reloadInFlight = false;

export function isStaleChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|unable to preload css/i.test(
    msg,
  );
}

/**
 * Did this tab reload for a stale chunk moments ago? A timestamp, not a once-per-session flag: a
 * tab that recovered from one deploy must recover from the next one too.
 */
export function staleChunkReloadUsed(): boolean {
  try {
    const at = Number(sessionStorage.getItem(RELOAD_KEY));
    return Number.isFinite(at) && Date.now() - at < RELOAD_GUARD_MS;
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
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
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
 * A second failure right after an automatic reload is ignored so a missing file cannot loop.
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

/** Build the page was served from (the server injects the meta tag; absent under Vite dev). */
const pageBuild = typeof document === "undefined" ? null : (document.querySelector<HTMLMetaElement>('meta[name="reelsaw-build"]')?.content ?? null);
let newBuild = false;

/** Called with each API response's X-Reelsaw-Build header. */
export function noteServerBuild(build: string | null) {
  if (build && pageBuild && build !== pageBuild) newBuild = true;
}

/**
 * On a route change: if the server runs a newer build and nothing is unsaved, load the new page
 * from the server (the URL already points at it) instead of rendering with the old chunk map.
 */
export function reloadIfNewBuild() {
  if (!newBuild || hasUnsaved()) return;
  newBuild = false;
  location.reload();
}

/** Fetch a lazy chunk while the browser is idle so a later deploy cannot strand it. */
export function prefetchWhenIdle(load: () => Promise<unknown>) {
  const run = () => void load().catch(() => {});
  if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 5_000 });
  else setTimeout(run, 2_000);
}
