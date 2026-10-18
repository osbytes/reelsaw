import { useCallback, useEffect, useRef } from "react";

/**
 * Ref for a sentinel element at the end of a list: calls `onNear` while the sentinel is within `margin`
 * px of the visible area of its scroll container (the app scrolls inside a Radix ScrollArea viewport, not
 * the window, so the observer's root is that viewport). Does nothing while `enabled` is false.
 */
export function useLoadMoreSentinel(onNear: () => void, enabled: boolean, margin = 600) {
  const cb = useRef(onNear);
  cb.current = onNear;
  const obs = useRef<IntersectionObserver | null>(null);
  useEffect(() => () => obs.current?.disconnect(), []);
  return useCallback(
    (el: HTMLElement | null) => {
      obs.current?.disconnect();
      obs.current = null;
      if (!el || !enabled || typeof IntersectionObserver === "undefined") return;
      const root = el.closest<HTMLElement>("[data-radix-scroll-area-viewport]");
      const o = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && cb.current(), { root, rootMargin: `0px 0px ${margin}px 0px` });
      o.observe(el);
      obs.current = o;
    },
    [enabled, margin],
  );
}
