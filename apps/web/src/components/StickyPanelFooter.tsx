import type { ReactNode } from "react";

/**
 * A settings panel's save/discard row, kept on screen while its panel scrolls past (`sticky` in the page's
 * ScrollArea; the panel bounds it, so the next panel's footer takes over). Bleeds over the panel's `p-5` so rows
 * pass under an opaque, edge-to-edge bar. The panel adds PANEL_FOCUS_CLEARANCE so a tabbed-to field stops above it.
 */
export function StickyPanelFooter({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-[2] -mx-5 -mb-5 flex min-h-9 flex-wrap items-center justify-end gap-2 rounded-b-[15px] border-t border-line bg-panel px-5 py-3">
      {children}
    </div>
  );
}

/** Room for the footer (it wraps to two lines on a phone) when the browser scrolls a focused control into view. */
export const PANEL_FOCUS_CLEARANCE = "[&_:is(input,textarea,button,[role=combobox])]:scroll-mb-28";
