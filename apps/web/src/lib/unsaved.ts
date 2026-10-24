/**
 * Surfaces that hold in-memory edits (the clip editor) register here so a stale-chunk
 * recovery can reload the tab only when nothing would be discarded.
 */
import { useEffect, useSyncExternalStore } from "react";

const dirty = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function setUnsaved(id: string, on: boolean) {
  const was = dirty.size > 0;
  if (on) dirty.add(id);
  else dirty.delete(id);
  if (was !== dirty.size > 0) emit();
}

export function hasUnsaved() {
  return dirty.size > 0;
}

export function subscribeUnsaved(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useUnsaved() {
  return useSyncExternalStore(subscribeUnsaved, hasUnsaved, () => false);
}

/** Register `on` as unsaved work for `id` for as long as this component is mounted. */
export function useUnsavedFlag(id: string, on: boolean) {
  useEffect(() => {
    setUnsaved(id, on);
    return () => setUnsaved(id, false);
  }, [id, on]);
}
