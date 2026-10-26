import { useEffect, useRef, useSyncExternalStore } from "react";
import { useHotkeys } from "react-hotkeys-hook";

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
  useShortcut("?", toggle, { useKey: true });
}

/**
 * One keyboard binding (react-hotkeys-hook underneath). `keys` is its syntax: "mod+s", "shift+left",
 * "space", "delete", or several in one string separated by commas. Typing in a text field never
 * triggers a binding unless `inFields` is set (checkboxes and sliders still allow it, like
 * `isTypingTarget`). The handler is read through a ref, so no dependency list is needed and the
 * binding never fires a stale closure. Pass `preventDefault: false` to decide per event.
 */
/** Space on a confirm's button, Backspace in a crop dialog: those keys belong to the dialog, not the page behind it. */
const inDialog = (t: EventTarget | null) => t instanceof Element && !!t.closest('[role="dialog"], [role="alertdialog"]');

export function useShortcut(
  keys: string,
  handler: (e: KeyboardEvent) => void,
  opts: {
    enabled?: boolean;
    /** also fire while typing in inputs / textareas / contenteditable */
    inFields?: boolean;
    /** also fire while focus is inside a dialog (by default a page's keys stay quiet behind an open dialog) */
    inDialogs?: boolean;
    preventDefault?: boolean;
    /** match `event.key` (for "?", "!" and other shifted characters) instead of the physical key */
    useKey?: boolean;
    /** fire whatever modifiers are held (a shifted character needs this) */
    ignoreModifiers?: boolean;
  } = {},
) {
  const h = useRef(handler);
  h.current = handler;
  const inFields = opts.inFields ?? false;
  useHotkeys(
    keys,
    (e) => h.current(e),
    {
      enabled: opts.enabled ?? true,
      // the library's own form-tag rule is coarser than ours (it would also skip checkboxes and sliders)
      enableOnFormTags: true,
      enableOnContentEditable: true,
      // a shifted character is matched on `event.key` with modifiers ignored, so ⌘? / Alt+! are refused here
      ignoreEventWhen: (e) => (!inFields && isTypingTarget(e.target)) || (!opts.inDialogs && inDialog(e.target)) || (!!opts.useKey && !opts.ignoreModifiers && (e.metaKey || e.ctrlKey || e.altKey)),
      preventDefault: opts.preventDefault ?? true,
      useKey: opts.useKey ?? false,
      ignoreModifiers: opts.ignoreModifiers ?? opts.useKey ?? false,
    },
    [keys, opts.enabled, inFields, opts.inDialogs, opts.preventDefault, opts.useKey, opts.ignoreModifiers],
  );
}
