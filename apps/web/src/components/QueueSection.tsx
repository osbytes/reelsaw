/**
 * Settings → System → Queue: live job depth, what is in flight, and failed work with Retry.
 * Admins only (admin.queue.summary / admin.failures.*).
 */
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Search } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { useTRPC } from "../lib/trpc";
import { ago } from "../lib/time";
import { useLoadMoreSentinel } from "../lib/useLoadMore";
import { ScrollArea } from "./scroll-area";
import { ConfirmDialog, Modal, Segmented, Select, Skeleton, SkeletonRegion } from "./ui";

const PAGE = 50;

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
  { value: "", label: "Any", title: "Any time" },
  { value: "24h", label: "24h", title: "Last 24 hours" },
  { value: "7d", label: "7d", title: "Last 7 days" },
];

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function sinceIso(v: string): string | undefined {
  if (v === "24h") return new Date(Date.now() - 24 * 3600_000).toISOString();
  if (v === "7d") return new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  return undefined;
}

type FailKey = { kind: "project" | "clip"; id: string };

function readFail(): FailKey | null {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw.startsWith("queue")) return null;
  const rest = raw.slice("queue".length).replace(/^=/, "").replace(/^&/, "");
  const fail = new URLSearchParams(rest).get("fail");
  if (!fail) return null;
  const i = fail.indexOf(":");
  if (i < 1) return null;
  const kind = fail.slice(0, i);
  const id = fail.slice(i + 1);
  if ((kind !== "project" && kind !== "clip") || !id) return null;
  return { kind, id };
}

function writeFail(key: FailKey | null) {
  history.replaceState(null, "", key ? `#queue&fail=${encodeURIComponent(`${key.kind}:${key.id}`)}` : "#queue");
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

function retryHint(row: { kind: string; stage: string }) {
  if (row.kind === "clip") return row.stage === "prepare" ? "Retry prepares this clip again." : "Retry re-renders this clip.";
  return `Retry resumes this project from ${row.stage}.`;
}

export function QueueSection() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [stage, setStage] = useState("");
  const [since, setSince] = useState("");
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [sel, setSel] = useState<FailKey | null>(() => readFail());
  const qDebounced = useDebounced(q, 250);

  const filter = useMemo(
    () => ({
      q: qDebounced.trim() || undefined,
      stage: (stage || undefined) as "ingest" | "transcribe" | "refine" | "analyze" | "render" | "prepare" | undefined,
      since: sinceIso(since),
    }),
    [qDebounced, stage, since],
  );
  const dirty = !!(q.trim() || stage || since);
  const filtered = !!(filter.q || filter.stage || filter.since);

  const queue = useQuery({ ...trpc.admin.queue.summary.queryOptions(), refetchInterval: 5000 });
  const failures = useInfiniteQuery(
    trpc.admin.failures.list.infiniteQueryOptions(
      { ...filter, limit: PAGE },
      { getNextPageParam: (last) => last.nextCursor ?? undefined, placeholderData: keepPreviousData, refetchInterval: 5000 },
    ),
  );
  const retry = useMutation(trpc.admin.failures.retry.mutationOptions());
  const items = useMemo(() => failures.data?.pages.flatMap((p) => p.items) ?? [], [failures.data]);
  const total = failures.data?.pages[0]?.total ?? 0;
  const truncated = failures.data?.pages.some((p) => p.truncated) ?? false;
  const more = useLoadMoreSentinel(() => void failures.fetchNextPage(), !!failures.hasNextPage && !failures.isFetching);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: trpc.admin.queue.summary.queryKey() });
    void qc.invalidateQueries({ queryKey: trpc.admin.failures.pathKey() });
  };

  const fromList = sel ? items.find((i) => i.kind === sel.kind && i.id === sel.id) : undefined;
  const got = useQuery({
    ...trpc.admin.failures.get.queryOptions(sel ?? { kind: "project", id: "_" }),
    enabled: !!sel && !fromList,
    retry: false,
  });
  const detail = fromList ?? (got.data === null ? null : (got.data ?? undefined));
  const loadingDetail = !!sel && !detail && (failures.isPending || got.isFetching);

  useEffect(() => {
    const onHash = () => setSel(readFail());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const openFail = (key: FailKey) => writeFail(key);
  const closeFail = () => writeFail(null);

  const onRetry = (ids?: Array<{ kind: "project" | "clip"; id: string }>, thenClose = false) => {
    retry
      .mutateAsync({ ...filter, ids })
      .then((r) => {
        toast.success(
          r.retried
            ? `Retried ${r.retried}${r.skipped ? ` · skipped ${r.skipped}` : ""}`
            : r.skipped
              ? `Nothing to retry (${r.skipped} skipped)`
              : "No matches",
        );
        invalidate();
        if (thenClose) closeFail();
      })
      .catch((err: Error) => toast.error(err.message));
  };

  const d = queue.data;
  const waiting = d?.queues.reduce((n, r) => n + r.waiting + r.retrying, 0) ?? 0;
  const running = d?.queues.reduce((n, r) => n + r.running, 0) ?? 0;

  return (
    <section id="queue" className="flex scroll-mt-4 flex-col gap-4 rounded-[16px] border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[15px] font-bold">Queue</h2>
        <span className="min-h-4 text-xs text-ink3">{d ? `${running} running · ${waiting} waiting` : queue.error ? queue.error.message : ""}</span>
      </div>
      <p className="text-[13px] text-ink2">
        Jobs waiting and running on this instance, and failed work you can retry after a platform fix (disk full, model down, encoder missing). Retry uses the
        same path as the owner&apos;s Retry button.
      </p>

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
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-bold">Failed work</h3>
          <div className="flex min-h-8 min-w-[10.5rem] items-center justify-end">
            {filtered && items.length > 0 ? (
              <button type="button" className="btn-ghost h-8 text-xs" disabled={retry.isPending} onClick={() => setConfirmBulk(true)}>
                Retry matching ({Math.min(PAGE, total)})
              </button>
            ) : null}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <label className="flex h-9 min-w-0 w-full flex-1 items-center gap-2 rounded-[10px] border border-line bg-sunk px-2.5 focus-within:border-acc">
            <Search className="h-4 w-4 shrink-0 text-ink3" aria-hidden />
            <input
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink3"
              placeholder="Search reasons…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search failed work by error text"
            />
          </label>
          <div className="flex h-9 shrink-0 items-center gap-2">
            <Select className="h-9 w-[8.75rem] shrink-0" size="sm" ariaLabel="Stage" value={stage} onValueChange={setStage} options={STAGES} />
            <Segmented className="h-9 shrink-0" size="sm" ariaLabel="When" value={since} onChange={setSince} options={SINCE} />
          </div>
        </div>
        <p className="flex min-h-4 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink3">
          <span>
            {failures.data
              ? items.length
                ? `Showing ${items.length} of ${total}${truncated ? "+" : ""}`
                : filtered
                  ? "No failed work matches this filter"
                  : "No failed projects or clips."
              : failures.error
                ? failures.error.message
                : ""}
          </span>
          <button
            type="button"
            className={`btn-quiet h-4 px-0 text-xs text-ink3 ${dirty ? "" : "invisible"}`}
            disabled={!dirty}
            onClick={() => {
              setQ("");
              setStage("");
              setSince("");
            }}
          >
            Clear
          </button>
        </p>
        {!failures.data && !failures.error ? (
          <SkeletonRegion label="Loading failed work…" className="flex flex-col gap-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </SkeletonRegion>
        ) : items.length > 0 ? (
          <>
            <ScrollArea className="max-h-[min(28rem,55dvh)]">
              <table className="w-full table-fixed text-[13px]">
                <caption className="sr-only">Failed projects and clips, newest first</caption>
                <colgroup>
                  <col />
                  <col className="hidden w-[9rem] sm:table-column" />
                  <col className="w-[5.5rem]" />
                  <col />
                  <col className="w-[6.5rem]" />
                  <col className="w-[4.5rem]" />
                </colgroup>
                <thead>
                  <tr className="text-left text-xs text-ink3">
                    <th scope="col" className="sticky top-0 z-[1] bg-panel py-1 font-medium">
                      Item
                    </th>
                    <th scope="col" className="sticky top-0 z-[1] hidden bg-panel py-1 font-medium sm:table-cell">
                      Owner
                    </th>
                    <th scope="col" className="sticky top-0 z-[1] bg-panel py-1 font-medium">
                      Stage
                    </th>
                    <th scope="col" className="sticky top-0 z-[1] bg-panel py-1 font-medium">
                      Reason
                    </th>
                    <th scope="col" className="sticky top-0 z-[1] bg-panel py-1 font-medium">
                      When
                    </th>
                    <th scope="col" className="sticky top-0 z-[1] bg-panel py-1">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr key={`${row.kind}:${row.id}`} className="border-t border-line/60">
                      <td className="truncate py-1.5">
                        <button
                          type="button"
                          className="block w-full truncate text-left text-ink hover:underline"
                          onClick={() => openFail({ kind: row.kind, id: row.id })}
                        >
                          {row.title}
                        </button>
                        <div className="truncate text-[11px] text-ink3">
                          {row.kind === "clip" ? (row.projectTitle ? `clip · ${row.projectTitle}` : "clip") : "project"}
                        </div>
                      </td>
                      <td className="hidden truncate py-1.5 text-xs text-ink2 sm:table-cell" title={row.ownerEmail}>
                        {row.ownerEmail}
                      </td>
                      <td className="truncate py-1.5">{row.stage}</td>
                      <td className="truncate py-1.5 text-xs text-ink2">
                        <button
                          type="button"
                          className="block w-full truncate text-left hover:underline"
                          title={row.error ?? undefined}
                          onClick={() => openFail({ kind: row.kind, id: row.id })}
                        >
                          {row.snippet}
                        </button>
                      </td>
                      <td className="truncate py-1.5 text-xs tabular-nums text-ink3" title={ago(row.failedAt)}>
                        {ago(row.failedAt)}
                      </td>
                      <td className="py-1.5 text-right">
                        <button
                          type="button"
                          className="btn-ghost h-8 min-w-[3.5rem] px-2 text-xs"
                          disabled={retry.isPending}
                          onClick={() => onRetry([{ kind: row.kind, id: row.id }])}
                        >
                          Retry
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(failures.hasNextPage || failures.isFetchingNextPage) && (
                <div ref={more} className="flex h-10 items-center justify-center">
                  <button
                    type="button"
                    className="btn-ghost h-8 min-w-[8rem] text-xs"
                    disabled={failures.isFetchingNextPage}
                    onClick={() => void failures.fetchNextPage()}
                  >
                    {failures.isFetchingNextPage ? "Loading…" : `Load ${Math.min(PAGE, Math.max(0, total - items.length))} more`}
                  </button>
                </div>
              )}
            </ScrollArea>
          </>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        title="Retry matching failures?"
        body={`Retry up to ${Math.min(PAGE, total)} failed ${Math.min(PAGE, total) === 1 ? "item" : "items"} that match this filter. Each one uses the same path as the owner Retry button, so live-job limits still apply.`}
        confirm="Retry matching"
        onConfirm={() => onRetry()}
      />

      <Modal open={!!sel} onOpenChange={(o) => !o && closeFail()} title={detail ? detail.title : "Failed work"} width={520}>
        {loadingDetail ? (
          <SkeletonRegion label="Loading failure…" className="flex flex-col gap-2">
            <Dialog.Description className="sr-only">Loading the recorded reason</Dialog.Description>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </SkeletonRegion>
        ) : detail ? (
          <>
            <Dialog.Description asChild>
              <p className="text-sm text-ink2">
                {detail.kind === "clip" ? (detail.projectTitle ? `Clip on ${detail.projectTitle}` : "Clip") : "Project"} · {detail.stage} · {detail.ownerEmail}{" "}
                · {ago(detail.failedAt)}
              </p>
            </Dialog.Description>
            <p className="min-h-4 text-xs text-ink3">{retryHint(detail)}</p>
            <ScrollArea className="max-h-[min(16rem,40dvh)] rounded-[10px] border border-line bg-sunk">
              <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-ink">
                {detail.error?.trim() || "Failed with no reason recorded"}
              </pre>
            </ScrollArea>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="btn-quiet min-w-[6.5rem]"
                onClick={() => void navigator.clipboard.writeText(detail.error?.trim() || "").then(() => toast("Reason copied"))}
              >
                Copy reason
              </button>
              <Link
                to={detail.kind === "clip" ? `/p/${detail.projectId}#clip=${detail.id}` : `/p/${detail.projectId}`}
                className="btn-ghost min-w-[7.5rem] no-underline"
                onClick={closeFail}
              >
                Open project
              </Link>
              <button
                type="button"
                className="btn-ink min-w-[5.5rem]"
                disabled={retry.isPending}
                onClick={() => onRetry([{ kind: detail.kind, id: detail.id }], true)}
              >
                Retry
              </button>
            </div>
          </>
        ) : (
          <Dialog.Description asChild>
            <p className="text-sm text-ink2">{got.isError ? got.error.message : "This failure is gone (retried or deleted)."}</p>
          </Dialog.Description>
        )}
      </Modal>
    </section>
  );
}
