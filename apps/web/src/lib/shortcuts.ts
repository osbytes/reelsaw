import { useEffect, useRef, useSyncExternalStore } from "react";

/** The ⌘ / Ctrl prefix for this platform. */
export const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";

export type Shortcut = [label: string, keys: string];
export interface ShortcutGroup {
  scope: string;
  items: Shortcut[];
}

/** Typing in a text field never triggers a shortcut (checkboxes and sliders still allow them). */
export const isTypingTarget = (el: EventTarget | null) => !!(el as HTMLElement | null)?.closest?.("input:not([type=checkbox]):not([type=range]), textarea, select, [contenteditable]");

// One registry of what each mounted view offers, so the `?` sheet lists exactly what works on this
// screen. Handlers stay with their views; this holds the documentation.
const groups = new Map<symbol, ShortcutGroup>();
const listeners = new Set<() => void>();
let snapshot: ShortcutGroup[] = [];
const emit = () => {
  snapshot = [...groups.values()];
  for (const l of listeners) l();
};

/** Register a view's shortcuts while it is mounted. Later registrations list first. */
export function useShortcuts(scope: string, items: Shortcut[]) {
  const key = JSON.stringify(items);
  const id = useRef(Symbol(scope));
  useEffect(() => {
    const k = id.current;
    groups.delete(k); // re-insert last so the most specific view lists first
    groups.set(k, { scope, items: JSON.parse(key) as Shortcut[] });
    emit();
    return () => {
      groups.delete(k);
      emit();
    };
  }, [scope, key]);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The registered groups, most specific view first. */
export function useShortcutGroups(): ShortcutGroup[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** `?` toggles the sheet from anywhere on the screen, except while typing. */
export function useSheetKey(toggle: () => void) {
  const t = useRef(toggle);
  t.current = toggle;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      t.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
