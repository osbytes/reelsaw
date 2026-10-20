/**
 * Settings → System → Queue: live job depth, what is in flight, and failed work with Retry.
 * Admins only (admin.queue.summary / admin.failures.*).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { toast } from "sonner";
import { useTRPC } from "../lib/trpc";
import { ago } from "../lib/time";
import { ConfirmDialog, Select, Skeleton, SkeletonRegion } from "./ui";

const STAGES = [
  { value: "", label: "Any stage" },
  { value: "ingest", label: "Ingest" },
  { value: "transcribe", label: "Transcribe" },
  { value: "refine", label: "Refine" },
  { value: "analyze", label: "Analyze" },
  { value: "render", label: "Render" },
  { value: "prepare", label: "Prepare" },
];

const SINCE = [
  { value: "", label: "Any time" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
];

function sinceIso(v: string): string | undefined {
  if (v === "24h") return new Date(Date.now() - 24 * 3600_000).toISOString();
  if (v === "7d") return new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  return undefined;
}

export function QueueSection() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [stage, setStage] = useState("");
  const [since, setSince] = useState("");
  const [confirmBulk, setConfirmBulk] = useState(false);

  const filter = useMemo(
    () => ({ q: q.trim() || undefined, stage: (stage || undefined) as "ingest" | "transcribe" | "refine" | "analyze" | "render" | "prepare" | undefined, since: sinceIso(since) }),
    [q, stage, since],
  );
  const filtered = !!(filter.q || filter.stage || filter.since);

  const queue = useQuery({ ...trpc.admin.queue.summary.queryOptions(), refetchInterval: 5000 });
  const failures = useQuery({ ...trpc.admin.failures.list.queryOptions(filter), refetchInterval: 5000 });
  const retry = useMutation(trpc.admin.failures.retry.mutationOptions());

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: trpc.admin.queue.summary.queryKey() });
    void qc.invalidateQueries({ queryKey: trpc.admin.failures.list.queryKey() });
  };

  const onRetry = (ids?: Array<{ kind: "project" | "clip"; id: string }>) => {
    retry
      .mutateAsync({ ...filter, ids })
      .then((r) => {
        toast.success(r.retried ? `Retried ${r.retried}${r.skipped ? ` · skipped ${r.skipped}` : ""}` : r.skipped ? `Nothing to retry (${r.skipped} skipped)` : "Nothing matched");
        invalidate();
      })
      .catch((err: Error) => toast.error(err.message));
  };

  const d = queue.data;
  const f = failures.data;
  const waiting = d?.queues.reduce((n, r) => n + r.waiting + r.retrying, 0) ?? 0;
  const running = d?.queues.reduce((n, r) => n + r.running, 0) ?? 0;

  return (
    <section id="queue" className="flex scroll-mt-4 flex-col gap-4 rounded-[16px] border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[15px] font-bold">Queue</h2>
        <span className="min-h-4 text-xs text-ink3">
          {d ? `${running} running · ${waiting} waiting` : queue.error ? queue.error.message : ""}
        </span>
      </div>
      <p className="text-[13px] text-ink2">Jobs waiting and running on this instance, and failed work you can retry after a platform fix (disk full, model down, encoder missing). Retry uses the same path as the owner&apos;s Retry button.</p>

      {!d && !queue.error ? (
        <SkeletonRegion label="Loading queue…" className="flex flex-col gap-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </SkeletonRegion>
      ) : d?.error ? (
        <p className="text-[13px] text-ink3">Queue tables are not ready yet.</p>
      ) : d ? (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-xs text-ink3">
              <th className="py-1 font-medium">Stage</th>
              <th className="py-1 text-right font-medium">Waiting</th>
              <th className="py-1 text-right font-medium">Running</th>
              <th className="py-1 text-right font-medium">Retrying</th>
            </tr>
          </thead>
          <tbody>
            {d.queues.map((r) => (
              <tr key={r.queue} className="border-t border-line/60">
                <td className="py-1.5">{r.label}</td>
                <td className="py-1.5 text-right font-mono text-xs tabular-nums">{r.waiting || "—"}</td>
                <td className="py-1.5 text-right font-mono text-xs tabular-nums">{r.running || "—"}</td>
                <td className="py-1.5 text-right font-mono text-xs tabular-nums">{r.retrying || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {d && d.active.length > 0 && (
        <div>
          <h3 className="text-[13px] font-bold">In flight{d.truncated ? " (showing 50)" : ""}</h3>
          <table className="mt-1 w-full text-[13px]">
            <thead>
              <tr className="text-left text-xs text-ink3">
                <th className="py-1 font-medium">Project</th>
                <th className="py-1 font-medium">Stage</th>
                <th className="py-1 font-medium">State</th>
                <th className="py-1 text-right font-medium">Attempt</th>
              </tr>
            </thead>
            <tbody>
              {d.active.map((j, i) => (
                <tr key={`${j.queue}:${j.projectId}:${j.clipId}:${i}`} className="border-t border-line/60">
                  <td className="max-w-[14rem] truncate py-1.5">
                    {j.projectId ? (
                      <Link to={`/p/${j.projectId}`} className="text-ink no-underline hover:underline">
                        {j.title ?? j.projectId.slice(0, 8)}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-1.5">{j.label}</td>
                  <td className="py-1.5 text-xs text-ink2">{j.state === "created" ? "waiting" : j.state === "retry" ? "retrying" : "running"}</td>
                  <td className="py-1.5 text-right font-mono text-xs tabular-nums">{j.attempt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-line/60 pt-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h3 className="text-[13px] font-bold">Failed work</h3>
          <div className="flex flex-wrap items-center gap-2">
            <input className="input h-8 w-[12rem] text-xs" placeholder="Filter by reason" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter failed work by error text" />
            <Select className="h-8 w-[9rem]" size="sm" ariaLabel="Stage" value={stage} onValueChange={setStage} options={STAGES} />
            <Select className="h-8 w-[9.5rem]" size="sm" ariaLabel="When" value={since} onValueChange={setSince} options={SINCE} />
            {filtered && (f?.items.length ?? 0) > 0 && (
              <button type="button" className="btn-ghost h-8 text-xs" disabled={retry.isPending} onClick={() => setConfirmBulk(true)}>
                Retry all matching ({Math.min(f?.items.length ?? 0, f?.total ?? 0)})
              </button>
            )}
          </div>
        </div>
        <p className="min-h-4 text-xs text-ink3">
          {f
            ? f.items.length
              ? `Showing ${f.items.length} of ${f.total}${f.truncated ? "+" : ""}`
              : filtered
                ? "No failed work matches this filter."
                : "No failed projects or clips."
            : failures.error
              ? failures.error.message
              : ""}
        </p>
        {!f && !failures.error ? (
          <SkeletonRegion label="Loading failed work…" className="flex flex-col gap-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </SkeletonRegion>
        ) : f && f.items.length > 0 ? (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-xs text-ink3">
                <th className="py-1 font-medium">Item</th>
                <th className="hidden py-1 font-medium sm:table-cell">Owner</th>
                <th className="py-1 font-medium">Stage</th>
                <th className="py-1 font-medium">Reason</th>
                <th className="py-1 font-medium">When</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {f.items.map((row) => (
                <tr key={`${row.kind}:${row.id}`} className="border-t border-line/60">
                  <td className="max-w-[12rem] truncate py-1.5">
                    <Link to={`/p/${row.projectId}`} className="text-ink no-underline hover:underline">
                      {row.title}
                    </Link>
                    <div className="text-[11px] text-ink3">{row.kind === "clip" ? "clip" : "project"}</div>
                  </td>
                  <td className="hidden max-w-[10rem] truncate py-1.5 text-xs text-ink2 sm:table-cell" title={row.ownerEmail}>
                    {row.ownerEmail}
                  </td>
                  <td className="py-1.5">{row.stage}</td>
                  <td className="max-w-[16rem] truncate py-1.5 text-xs text-ink2" title={row.error ?? undefined}>
                    {row.snippet}
                  </td>
                  <td className="whitespace-nowrap py-1.5 text-xs text-ink3">{ago(row.failedAt)}</td>
                  <td className="py-1.5 text-right">
                    <button type="button" className="btn-ghost h-8 px-2 text-xs" disabled={retry.isPending} onClick={() => onRetry([{ kind: row.kind, id: row.id }])}>
                      Retry
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        title="Retry matching failures"
        body={`Retry up to ${f?.items.length ?? 0} failed ${f?.items.length === 1 ? "item" : "items"} that match this filter. Each one uses the same path as the owner Retry button, so live-job limits still apply.`}
        confirm="Retry matching"
        onConfirm={() => onRetry()}
      />
    </section>
  );
}
