/**
 * Surfaces that hold in-memory edits (the clip editor) register here so a stale-chunk
 * recovery can reload the tab only when nothing would be discarded, and guard leaving with
 * useLeaveGuard.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useBlocker } from "react-router";

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

/**
 * Ask before an editor with unsaved edits is left by any route change: its own Back button, ⌘K, a
 * header link, the browser's Back. Hash and search changes stay on the page and pass. The editor
 * renders its "Unsaved changes" dialog from `open`; `stay` and `leave` answer it. Call `allowLeave`
 * before navigating away on purpose (after deleting the thing being edited).
 */
export function useLeaveGuard(dirty: boolean, onExit: () => void) {
  const allowed = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && !allowed.current && currentLocation.pathname !== nextLocation.pathname);
  const [asked, setAsked] = useState(false);
  const blocked = blocker.state === "blocked";
  return {
    open: asked || blocked,
    requestExit: () => (dirty ? setAsked(true) : onExit()),
    stay: () => {
      setAsked(false);
      if (blocked) blocker.reset();
    },
    leave: () => {
      allowed.current = true;
      setAsked(false);
      if (blocked) blocker.proceed();
      else onExit();
    },
    allowLeave: () => {
      allowed.current = true;
    },
  };
}
