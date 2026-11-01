import { useEffect, useState } from "react";
import type { StreamStatus } from "../lib/projectEvents";

/**
 * Shown while a project's live event stream is not open. Fixed to the viewport corner, so it never moves
 * content. A first connection gets a short grace period so a normal page load does not flash it.
 */
export function LiveStatusPill({ status }: { status: StreamStatus }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    setLate(false);
    if (status !== "connecting") return;
    const t = window.setTimeout(() => setLate(true), 2500);
    return () => window.clearTimeout(t);
  }, [status]);
  if (status === "open" || (status === "connecting" && !late)) return null;
  return (
    <div
      role="status"
      className="pointer-events-none fixed bottom-4 left-4 z-[70] max-w-[calc(100vw-32px)] rounded-full border border-line bg-panel px-3 py-1.5 text-xs text-ink2 shadow-pop"
    >
      {status === "closed" ? "Live updates stopped; sign in again to resume." : "Live updates paused, reconnecting…"}
    </div>
  );
}
