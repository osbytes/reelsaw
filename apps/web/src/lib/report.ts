// One "Report an issue" dialog for the whole app; entry points open it with their context.
import { useSyncExternalStore } from "react";

export interface ReportTarget {
  projectId?: string;
  projectTitle?: string;
  clipId?: string;
  /** Opens the report with this already in the box (capacity requests from a quota refusal). */
  prefill?: string;
  tags?: Record<string, string>;
}
let state: ReportTarget | null = null;
const subs = new Set<() => void>();
const set = (s: ReportTarget | null) => {
  state = s;
  subs.forEach((f) => f());
};

export const openReport = (target: ReportTarget = {}) => set(target);
export const closeReport = () => set(null);
export const useReportTarget = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => state,
  );

/** Open the report about whatever is on screen: the project (and focused clip) when on one. */
export function openReportHere() {
  const projectId = /^\/p\/([^/]+)/.exec(location.pathname)?.[1];
  const clipId = /^\/p\/[^/]+\/clips\/([^/#?]+)/.exec(location.pathname)?.[1] ?? new URLSearchParams(location.hash.slice(1)).get("clip") ?? undefined;
  openReport({ projectId, clipId });
}

/** Keyboard shortcut: "!" anywhere except while typing (bound in ReportDialog). */
export const REPORT_SHORTCUT = "!";
