import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";

/**
 * The height cap for a list inside a Settings card (share links, deliveries, keys, failures, rules): past it the list
 * scrolls in place, so a card never grows with its rows and the sections below stay reachable (docs/UI.md).
 */
export const SECTION_LIST_MAX_H = "max-h-[min(28rem,55dvh)]";

/** Which horizontal edges of a scroller hide content: the strip fades there so a clipped tab reads as "scroll for more". */
function useEdgeFade(enabled: boolean) {
  const el = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const v = el.current;
    if (!v) return;
    const left = v.scrollLeft > 1;
    const right = v.scrollLeft + v.clientWidth < v.scrollWidth - 1;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);
  useEffect(() => {
    const v = el.current;
    if (!enabled || !v) return;
    measure();
    v.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(v);
    if (v.firstElementChild) ro.observe(v.firstElementChild);
    return () => {
      v.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [enabled, measure]);
  const fade = 28;
  const mask =
    enabled && (edges.left || edges.right)
      ? `linear-gradient(to right, ${edges.left ? `transparent, black ${fade}px` : "black"}, ${edges.right ? `black calc(100% - ${fade}px), transparent` : "black"})`
      : undefined;
  return { el, style: mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined };
}

/**
 * Radix ScrollArea with themed scrollbars. Use this instead of `overflow-auto`. `fadeEdges` is for a one-row strip
 * that scrolls sideways (tabs, a toolbar on a phone): an edge that hides content fades out, so it reads as more.
 */
export function ScrollArea({
  className = "",
  children,
  viewportRef,
  fadeEdges = false,
  ...props
}: ComponentProps<typeof ScrollAreaPrimitive.Root> & { viewportRef?: React.Ref<HTMLDivElement>; fadeEdges?: boolean }) {
  const fade = useEdgeFade(fadeEdges);
  const setViewport = useCallback(
    (node: HTMLDivElement | null) => {
      fade.el.current = node;
      if (typeof viewportRef === "function") viewportRef(node);
      else if (viewportRef) (viewportRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewportRef],
  );
  return (
    <ScrollAreaPrimitive.Root className={`relative overflow-hidden ${className}`} {...props}>
      {/* Radix wraps children in a `display:table` div so content never shrinks below its max-content
          width, which kills flex-wrap / truncate on narrow screens. Force it back to block. */}
      <ScrollAreaPrimitive.Viewport
        ref={setViewport}
        tabIndex={-1}
        style={fade.style}
        className="h-full max-h-[inherit] w-full rounded-[inherit] outline-none [&>div]:!block [&>div]:min-w-0"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar orientation="vertical" className="flex touch-none select-none p-0.5 transition-colors data-[orientation=vertical]:w-2.5">
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-line2 hover:bg-ink3" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Scrollbar
        orientation="horizontal"
        className="flex touch-none select-none p-0.5 data-[orientation=horizontal]:h-2.5 data-[orientation=horizontal]:flex-col"
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-line2 hover:bg-ink3" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}
