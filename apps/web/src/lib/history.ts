import { useCallback, useState } from "react";

interface H<T> {
  past: T[];
  present: T;
  future: T[];
  /** coalescing key of the last change; consecutive changes with the same key form one undo step */
  key: string | null;
  at: number;
}

const LIMIT = 200;
const COALESCE_MS = 1500;

/**
 * Undo/redo for an immutable document. `set(next, key)` records a step; repeated calls with the same
 * `key` within 1.5 s replace the top step instead of pushing (typing). Keys starting with "g:" (one
 * pointer gesture) coalesce regardless of time.
 */
export function useHistory<T>(initial: T | (() => T)) {
  const [h, setH] = useState<H<T>>(() => ({
    past: [],
    present: typeof initial === "function" ? (initial as () => T)() : initial,
    future: [],
    key: null,
    at: 0,
  }));

  const set = useCallback((updater: T | ((prev: T) => T), key?: string) => {
    setH((s) => {
      const next = typeof updater === "function" ? (updater as (p: T) => T)(s.present) : updater;
      if (Object.is(next, s.present) || JSON.stringify(next) === JSON.stringify(s.present)) return s;
      const now = Date.now();
      if (key && s.key === key && (key.startsWith("g:") || now - s.at < COALESCE_MS)) return { ...s, present: next, future: [], at: now };
      return { past: [...s.past.slice(-(LIMIT - 1)), s.present], present: next, future: [], key: key ?? null, at: now };
    });
  }, []);

  const undo = useCallback(
    () =>
      setH((s) => (s.past.length ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1]!, future: [s.present, ...s.future], key: null, at: 0 } : s)),
    [],
  );
  const redo = useCallback(
    () => setH((s) => (s.future.length ? { past: [...s.past, s.present], present: s.future[0]!, future: s.future.slice(1), key: null, at: 0 } : s)),
    [],
  );

  return { state: h.present, set, undo, redo, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}
