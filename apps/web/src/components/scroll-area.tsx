import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type { ComponentProps } from "react";

/** Radix ScrollArea with themed scrollbars. Use this instead of `overflow-auto`. */
export function ScrollArea({ className = "", children, viewportRef, ...props }: ComponentProps<typeof ScrollAreaPrimitive.Root> & { viewportRef?: React.Ref<HTMLDivElement> }) {
  return (
    <ScrollAreaPrimitive.Root className={`relative overflow-hidden ${className}`} {...props}>
      {/* Radix wraps children in a `display:table` div so content never shrinks below its max-content
          width, which kills flex-wrap / truncate on narrow screens. Force it back to block. */}
      <ScrollAreaPrimitive.Viewport ref={viewportRef} tabIndex={-1} className="h-full max-h-[inherit] w-full rounded-[inherit] outline-none [&>div]:!block [&>div]:min-w-0">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar orientation="vertical" className="flex touch-none select-none p-0.5 transition-colors data-[orientation=vertical]:w-2.5">
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border hover:bg-muted/60" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Scrollbar orientation="horizontal" className="flex touch-none select-none p-0.5 data-[orientation=horizontal]:h-2.5 data-[orientation=horizontal]:flex-col">
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border hover:bg-muted/60" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}
