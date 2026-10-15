import type { ProjectStatus, ClipStatus } from "@reelsaw/shared";

const statusColor: Record<ProjectStatus | ClipStatus, string> = {
  queued: "bg-muted/20 text-muted",
  ingesting: "bg-accent-2/20 text-accent-2",
  transcribing: "bg-accent-2/20 text-accent-2",
  refining: "bg-accent-2/20 text-accent-2",
  analyzing: "bg-accent-2/20 text-accent-2",
  rendering: "bg-accent/20 text-accent",
  pending: "bg-muted/20 text-muted",
  preparing: "bg-accent-2/20 text-accent-2",
  done: "bg-ok/20 text-ok",
  failed: "bg-danger/20 text-danger",
};

export function StatusBadge({ status }: { status: ProjectStatus | ClipStatus }) {
  return <span className={`rounded px-2 py-0.5 text-xs font-medium capitalize ${statusColor[status]}`}>{status}</span>;
}

export function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-accent" />;
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-panel-2">
      <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </div>
  );
}
