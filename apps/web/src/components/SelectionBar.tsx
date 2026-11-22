import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Spinner } from "./ui";

/**
 * One compact selection row, sticky at the bottom of its scroll parent (the clips list, Projects, Deleted, Users).
 * Count, the primary actions (the same `btn` buttons as the rest of the app), then whatever else the caller puts here
 * (usually a ⋯ menu), then × to clear.
 *
 * `busy` is required: while an action on the selection runs, the ✓ turns into a spinner in the same slot (nothing
 * moves), the row says so to screen readers, and the caller disables its actions with the same flag ("Work in flight
 * shows", docs/PRINCIPLES.md). Pass the OR of every mutation the bar starts.
 */
export function SelectionBar({
  label,
  count,
  busy,
  onClear,
  children,
}: {
  label: string;
  count: number;
  busy: boolean;
  onClear: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      aria-busy={busy}
      className="sticky bottom-3 z-10 mx-auto mt-2 flex w-fit max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-[14px] border border-line bg-panel px-2 py-1.5 shadow-pop relative"
    >
      <span className="shrink-0 px-1.5 text-[13px] font-semibold" aria-live="polite">
        <span aria-hidden className="me-1.5 inline-grid w-3 place-items-center font-mono text-acc-text">
          {busy ? <Spinner /> : "✓"}
        </span>
        {count}
        {/* a phone has room for the actions or the word, not both */}
        <span className="max-sm:sr-only"> selected</span>
        {busy && <span className="sr-only">, working…</span>}
      </span>
      {children}
      <button type="button" className="btn-ghost h-8 w-8 shrink-0 px-0" onClick={onClear} aria-label="Clear selection">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
