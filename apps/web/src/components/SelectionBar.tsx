import type { ReactNode } from "react";
import { X } from "lucide-react";

/**
 * One compact selection row, sticky at the bottom of its scroll parent (the clips list, Deleted).
 * Count, the primary actions (the same `btn` buttons as the rest of the app), then whatever else
 * the caller puts here (usually a ⋯ menu), then × to clear.
 */
export function SelectionBar({ label, count, onClear, children }: { label: string; count: number; onClear: () => void; children: ReactNode }) {
  return (
    <div role="region" aria-label={label} className="sticky bottom-3 z-10 mx-auto mt-2 flex w-fit max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-[14px] border border-line bg-panel px-2 py-1.5 shadow-pop relative">
      <span className="shrink-0 px-1.5 text-[13px] font-semibold" aria-live="polite">
        <span aria-hidden className="mr-1.5 font-mono text-acc-text">
          ✓
        </span>
        {count} selected
      </span>
      {children}
      <button type="button" className="btn-ghost h-8 w-8 shrink-0 px-0" onClick={onClear} aria-label="Clear selection">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
