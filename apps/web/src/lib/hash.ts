import { useLocation } from "react-router";

/**
 * Deep links live in the URL hash as query-style params (#fix=…&t=…) so they survive reloads and can
 * be shared. Writes use replaceState: opening a popover shouldn't add a back-button entry.
 */
export function readHash(): URLSearchParams {
  return new URLSearchParams(window.location.hash.replace(/^#/, ""));
}

export function writeHash(patch: Record<string, string | number | null | undefined>) {
  const p = readHash();
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") p.delete(k);
    else p.set(k, String(v));
  }
  const h = p.toString().replace(/%2C/g, ",");
  const url = `${window.location.pathname}${window.location.search}${h ? `#${h}` : ""}`;
  if (url !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(window.history.state, "", url);
}

/** Absolute link to the current page with these hash params (others dropped). */
export function linkWith(params: Record<string, string | number>, path = window.location.pathname) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) p.set(k, String(v));
  return `${window.location.origin}${path}#${p.toString()}`;
}

/**
 * Current hash params. Follows react-router's location (it sees pasted links, back/forward and hash
 * edits); our own replaceState writes don't notify it, so writing never loops back into a re-apply.
 */
export function useHashParams(): URLSearchParams {
  const { hash } = useLocation();
  return new URLSearchParams(hash.replace(/^#/, ""));
}

export const fmtSec = (t: number) => String(Math.max(0, Math.round(t * 10) / 10));
