/**
 * Settings → System → Queue: only the stages that have work, how long the oldest job has waited and how fast
 * jobs were picked up in the last hour, whose work is queued and at what priority, what each job in flight is
 * doing (and why a retry failed), and failed work with its cause, Retry and Dismiss. Idle is one line, not a
 * table of dashes. Admins only (admin.queue.summary / admin.failures.*).
 */
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Search } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";
import { useTRPC } from "../lib/trpc";
import { useSession } from "../lib/auth";
import { ago, elapsed } from "../lib/time";
import { useLoadMoreSentinel } from "../lib/useLoadMore";
import { ScrollArea, SECTION_LIST_MAX_H } from "./scroll-area";
import { ConfirmDialog, Modal, Segmented, Select, Skeleton, SkeletonRegion } from "./ui";
import { isPipelineQueue, LONG_WAIT_MS } from "./FleetSummary";
import { type FailureCause, formatPriority, formatSeconds } from "@reelsaw/shared";
import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, plural, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useDebounced } from "../lib/useDebounced";

const PAGE = 50;

/** The admin users page searched for one account (by email, else id). */
const accountHref = (q: string) => `/admin/users#${new URLSearchParams({ q }).toString()}`;

/**
 * Where an admin goes from a queued or failed item: the project when it is their own, else the owner's account. Another
 * account's project page is not theirs to open (it answers not found), so linking it would be a dead end.
 */
function workHref(
  viewerId: string | undefined,
  w: { projectId: string; clipId?: string | null; ownerId?: string | undefined; ownerEmail?: string | undefined },
): string | null {
  if (w.ownerId && w.ownerId === viewerId) return w.clipId ? `/p/${w.projectId}#clip=${w.clipId}` : `/p/${w.projectId}`;
  const who = w.ownerEmail ?? w.ownerId;
  return who ? accountHref(who) : null;
}
/** Below this many failures the search and filters are noise; they show once there is a list to narrow. */
const FILTER_FROM = 6;

const STAGES: Array<{ value: string; label: MessageDescriptor }> = [
  { value: "", label: msg`Any stage` },
  { value: "ingest", label: msg`Ingest` },
  { value: "transcribe", label: msg`Transcribe` },
  { value: "refine", label: msg`Refine` },
  { value: "analyze", label: msg`Analyze` },
  { value: "render", label: msg`Render` },
  { value: "prepare", label: msg`Prepare` },
];

const CAUSES: Array<{ value: string; label: MessageDescriptor }> = [
  { value: "", label: msg`Any cause` },
  { value: "platform", label: msg`Platform` },
  { value: "input", label: msg`Source` },
  { value: "quota", label: msg`Plan limit` },
];

/** A cause as a glyph and a word (never colour alone), and what Retry would do about it. */
const CAUSE: Record<FailureCause, { glyph: string; word: MessageDescriptor; tone: string; title: MessageDescriptor }> = {
  platform: { glyph: "↻", word: msg`platform`, tone: "text-warn", title: msg`This instance's fault (disk, model, encoder, timeout): retry after the fix` },
  input: { glyph: "✕", word: msg`source`, tone: "text-ink3", title: msg`The video, link or settings: retrying the same thing fails the same way` },
  quota: { glyph: "◷", word: msg`plan limit`, tone: "text-ink3", title: msg`The owner's plan refused it: retried by itself when their plan or limits change` },
};

const SINCE: Array<{ value: string; label: MessageDescriptor; title: MessageDescriptor }> = [
  { value: "", label: msg`Any`, title: msg`Any time` },
  { value: "24h", label: msg`24h`, title: msg`Last 24 hours` },
  { value: "7d", label: msg`7d`, title: msg`Last 7 days` },
];

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

/** "3 jobs started; longest wait 2 min" for a stage's pickup cell. */
function pickupTitle(started: number, longest: string) {
  return plural(started, { one: `# job started; longest wait ${longest}`, other: `# jobs started; longest wait ${longest}` });
}

function retryHint(row: { kind: string; stage: string; cause: FailureCause }) {
  if (row.cause === "input")
    return t`The source itself failed: retrying the same video fails the same way. Dismiss it, or the owner changes the link or settings.`;
  if (row.cause === "quota") return t`The owner's plan refused this video. It is retried by itself when their plan or limits change.`;
  if (row.kind === "clip") return row.stage === "prepare" ? t`Retry prepares this clip again.` : t`Retry re-renders this clip.`;
  const stage = row.stage;
  return t`Retry resumes this project from ${stage}.`;
}

/** Bulk dismiss pages of 50 until nothing is left; a ceiling keeps one click from looping forever. */
const DISMISS_ROUNDS = 20;

export function QueueSection() {
  const { t } = useLingui();
  const trpc = useTRPC();
  const viewerId = useSession().data?.user.id;
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [stage, setStage] = useState("");
  const [cause, setCause] = useState("");
  const [since, setSince] = useState("");
  const [showDismissed, setShowDismissed] = useState(false);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [confirmDismiss, setConfirmDismiss] = useState(false);
  const [sel, setSel] = useState<FailKey | null>(() => readFail());
  const qDebounced = useDebounced(q, 250);

  const filter = useMemo(
    () => ({
      q: qDebounced.trim() || undefined,
      stage: (stage || undefined) as "ingest" | "transcribe" | "refine" | "analyze" | "render" | "prepare" | undefined,
      cause: (cause || undefined) as FailureCause | undefined,
      since: sinceIso(since),
    }),
    [qDebounced, stage, cause, since],
  );
  const dirty = !!(q.trim() || stage || cause || since);
  const filtered = !!(filter.q || filter.stage || filter.cause || filter.since);

  const queue = useQuery({ ...trpc.admin.queue.summary.queryOptions(), refetchInterval: 5000 });
  const workers = useQuery({ ...trpc.admin.workers.list.queryOptions(), refetchInterval: 5000 });
  const failures = useInfiniteQuery(
    trpc.admin.failures.list.infiniteQueryOptions(
      { ...filter, dismissed: showDismissed || undefined, limit: PAGE },
      { getNextPageParam: (last) => last.nextCursor ?? undefined, placeholderData: keepPreviousData, refetchInterval: 5000 },
    ),
  );
  const retry = useMutation(trpc.admin.failures.retry.mutationOptions());
  const dismiss = useMutation(trpc.admin.failures.dismiss.mutationOptions());
  const acting = retry.isPending || dismiss.isPending;
  const items = useMemo(() => failures.data?.pages.flatMap((p) => p.items) ?? [], [failures.data]);
  const total = failures.data?.pages[0]?.total ?? 0;
  const truncated = failures.data?.pages.some((p) => p.truncated) ?? false;
  const more = useLoadMoreSentinel(() => void failures.fetchNextPage(), !!failures.hasNextPage && !failures.isFetching);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: trpc.admin.queue.summary.pathKey() });
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

  const onRetry = (ids?: Array<{ kind: "project" | "clip"; id: string }>, thenClose = false) =>
    retry
      .mutateAsync({ ...filter, ids })
      .then((r) => {
        const retried = r.retried;
        const skipped = r.skipped;
        toast.success(
          retried
            ? skipped
              ? t`Retried ${retried} · skipped ${skipped}`
              : t`Retried ${retried}`
            : skipped
              ? t`Nothing to retry (${skipped} skipped)`
              : t`No matches`,
        );
        invalidate();
        if (thenClose) closeFail();
      })
      .catch((err: Error) => void toast.error(err.message));

  /** Dismiss (or restore, in the dismissed view) these rows, or every match of the filter a page at a time. */
  const onDismiss = async (ids?: Array<{ kind: "project" | "clip"; id: string }>, thenClose = false, restore = showDismissed) => {
    try {
      let changed = 0;
      for (let round = 0; round < (ids ? 1 : DISMISS_ROUNDS); round++) {
        const r = await dismiss.mutateAsync({ ...filter, ids, restore });
        changed += r.changed;
        if (!r.nextCursor || !r.changed) break;
      }
      toast.success(changed ? (restore ? t`Restored ${changed}` : t`Dismissed ${changed}`) : t`No matches`);
      invalidate();
      if (thenClose) closeFail();
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const d = queue.data;
  const waiting = d?.queues.reduce((n, r) => n + r.waiting + r.retrying, 0) ?? 0;
  const running = d?.queues.reduce((n, r) => n + r.running, 0) ?? 0;
  const busy = d?.queues.filter((r) => r.waiting + r.running + r.retrying > 0 || r.pickup.started > 0) ?? [];
  // a stage nobody listens on never drains: say so instead of letting it look slow (only once the heartbeats are in)
  const listened = workers.data ? new Set(workers.data.items.filter((w) => w.live).flatMap((w) => w.queues)) : null;
  const stageNote = (r: (typeof busy)[number]) => {
    if (listened && r.waiting + r.retrying > 0 && isPipelineQueue(r.queue) && !listened.has(r.queue))
      return { text: `✕ ${t`No worker takes this stage`}`, tone: "text-err" };
    if (!r.running && r.oldestWaitingAt && Date.now() - new Date(r.oldestWaitingAt).getTime() > LONG_WAIT_MS)
      return { text: `◷ ${t`Waiting, nothing running`}`, tone: "text-warn" };
    const retrying = r.retrying;
    if (r.retrying) return { text: `↻ ${t`${retrying} retrying`}`, tone: "text-warn" };
    return null;
  };
  const filtersShown = filtered || total >= FILTER_FROM;
  const detailProject = detail?.projectTitle;
  const ownerCount = d?.owners.length ?? 0;
  const windowMin = d?.pickupWindowMinutes ?? 0;
  const p50 = formatSeconds(d?.pickup.p50Sec);
  const p95 = formatSeconds(d?.pickup.p95Sec);
  const stageOptions = STAGES.map((o) => ({ value: o.value, label: i18n._(o.label) }));
  const causeOptions = CAUSES.map((o) => ({ value: o.value, label: i18n._(o.label) }));
  const sinceOptions = SINCE.map((o) => ({ value: o.value, label: i18n._(o.label), title: i18n._(o.title) }));
  const totalShown = truncated ? `${total}+` : String(total);
  const pageOrTotal = Math.min(PAGE, total);
  const shownCount = items.length;
  const nextCount = Math.min(PAGE, Math.max(0, total - items.length));

  return (
    <section id="queue" className="flex scroll-mt-4 flex-col gap-4 rounded-[16px] border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[15px] font-bold">
          <Trans>Queue</Trans>
        </h2>
        <span className="min-h-4 text-xs text-ink3">
          {d ? (running || waiting ? t`${running} running · ${waiting} waiting` : t`idle`) : queue.error ? queue.error.message : ""}
          {d?.pickup.started ? ` · ${t`picked up in ${p50} typically, ${p95} at worst (95%), last ${windowMin} min`}` : ""}
        </span>
      </div>
      <p className="text-[13px] text-ink2">
        <Trans>
          Jobs on this instance by stage, and failed work. Platform failures (disk full, model down, encoder missing) are worth a Retry after the fix; a bad
          source fails the same way again, so dismiss it; plan-limit refusals retry by themselves when the owner&apos;s plan or limits change. Retry is the
          owner&apos;s Retry button, and Dismiss only clears this list.
        </Trans>
      </p>

      {!d && !queue.error ? (
        <SkeletonRegion label={t`Loading queue…`} className="flex flex-col gap-2">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </SkeletonRegion>
      ) : d?.error ? (
        <p className="text-[13px] text-ink3">
          <Trans>Queue tables are not ready yet.</Trans>
        </p>
      ) : d && !busy.length ? (
        <p className="flex h-9 items-center gap-2 rounded-[10px] bg-sunk px-3 text-[13px] text-ink2">
          <span className="font-mono text-ink3">○</span> <Trans>Idle: nothing waiting or running, nothing started in the last {windowMin} min.</Trans>
        </p>
      ) : d ? (
        <ScrollArea>
          <table className="w-full min-w-[38rem] table-fixed text-[13px]">
            <caption className="sr-only">
              <Trans>Stages with work waiting or running, or picked up in the last hour</Trans>
            </caption>
            <colgroup>
              <col className="w-[7rem]" />
              <col className="w-[4.5rem]" />
              <col className="w-[4.5rem]" />
              <col className="w-[7rem]" />
              <col className="w-[8.5rem]" />
              <col />
            </colgroup>
            <thead>
              <tr className="text-start text-xs text-ink3">
                <th scope="col" className="py-1 font-medium">
                  <Trans>Stage</Trans>
                </th>
                <th scope="col" className="py-1 text-end font-medium">
                  <Trans>Running</Trans>
                </th>
                <th scope="col" className="py-1 text-end font-medium">
                  <Trans>Waiting</Trans>
                </th>
                <th scope="col" className="py-1 text-end font-medium">
                  <Trans>Longest wait</Trans>
                </th>
                <th
                  scope="col"
                  className="py-1 text-end font-medium"
                  title={t`Wait from queued to picked up, jobs started in the last ${windowMin} min: median / 95th percentile`}
                >
                  <Trans>Pickup p50 / p95</Trans>
                </th>
                <th scope="col" className="py-1 ps-4 font-medium">
                  <span className="sr-only">
                    <Trans>Note</Trans>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {busy.map((r) => {
                const note = stageNote(r);
                return (
                  <tr key={r.queue} className="border-t border-line/60">
                    <td className="truncate py-1.5">{r.label}</td>
                    <td className="py-1.5 text-end font-mono text-xs tabular-nums">{r.running || "—"}</td>
                    <td className="py-1.5 text-end font-mono text-xs tabular-nums">{r.waiting + r.retrying || "—"}</td>
                    <td className="py-1.5 text-end font-mono text-xs tabular-nums">{r.oldestWaitingAt ? elapsed(r.oldestWaitingAt) : "—"}</td>
                    <td
                      className="py-1.5 text-end font-mono text-xs tabular-nums text-ink2"
                      title={r.pickup.started ? pickupTitle(r.pickup.started, formatSeconds(r.pickup.maxSec)) : undefined}
                    >
                      {r.pickup.started ? `${formatSeconds(r.pickup.p50Sec)} / ${formatSeconds(r.pickup.p95Sec)}` : "—"}
                    </td>
                    <td className={`truncate py-1.5 ps-4 text-xs font-semibold ${note?.tone ?? ""}`}>{note?.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollArea>
      ) : null}

      {d && d.owners.length > 0 && (
        <div>
          <h3 className="text-[13px] font-bold">{d.ownersTruncated ? t`By account (top ${ownerCount})` : t`By account`}</h3>
          <p className="text-xs text-ink3">
            <Trans>
              Priority moves an account&apos;s next jobs ahead by that many jobs of backlog. Paid plans get it automatically; set it per account in Users →
              Limits.
            </Trans>
          </p>
          <ScrollArea className="max-h-[min(16rem,35dvh)]">
            <table className="mt-1 w-full min-w-[30rem] table-fixed text-[13px]">
              <caption className="sr-only">
                <Trans>Accounts with work waiting or running, most waiting first</Trans>
              </caption>
              <colgroup>
                <col />
                <col className="w-[6.5rem]" />
                <col className="w-[4.5rem]" />
                <col className="w-[4.5rem]" />
                <col className="w-[7rem]" />
              </colgroup>
              <thead>
                <tr className="text-start text-xs text-ink3">
                  <th scope="col" className="sticky top-0 z-[1] bg-panel py-1 font-medium">
                    <Trans>Account</Trans>
                  </th>
                  <th scope="col" className="sticky top-0 z-[1] bg-panel py-1 text-end font-medium">
                    <Trans>Priority</Trans>
                  </th>
                  <th scope="col" className="sticky top-0 z-[1] bg-panel py-1 text-end font-medium">
                    <Trans>Running</Trans>
                  </th>
                  <th scope="col" className="sticky top-0 z-[1] bg-panel py-1 text-end font-medium">
                    <Trans>Waiting</Trans>
                  </th>
                  <th scope="col" className="sticky top-0 z-[1] bg-panel py-1 text-end font-medium">
                    <Trans>Longest wait</Trans>
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.owners.map((o) => (
                  <tr key={o.userId} className="border-t border-line/60">
                    <td className="truncate py-1.5" title={o.email ?? o.userId}>
                      <Link to={accountHref(o.email ?? o.userId)} className="text-ink no-underline hover:underline">
                        {o.email ?? o.userId.slice(0, 8)}
                      </Link>
                      {o.plan && o.plan !== "free" ? <span className="text-ink3"> · {o.plan}</span> : null}
                    </td>
                    <td
                      className="py-1.5 text-end font-mono text-xs tabular-nums"
                      title={o.prioritySource === "override" ? t`Set by an admin` : o.prioritySource === "plan" ? t`From the plan` : t`Default`}
                    >
                      {formatPriority(o.priority)}
                      {o.prioritySource === "override" ? (
                        <span className="text-ink3">
                          {" "}
                          <Trans>(set)</Trans>
                        </span>
                      ) : null}
                    </td>
                    <td className="py-1.5 text-end font-mono text-xs tabular-nums">{o.running || "—"}</td>
                    <td className="py-1.5 text-end font-mono text-xs tabular-nums">{o.waiting || "—"}</td>
                    <td className="py-1.5 text-end font-mono text-xs tabular-nums">{o.oldestWaitingAt ? elapsed(o.oldestWaitingAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        </div>
      )}

      {d && d.active.length > 0 && (
        <div>
          <h3 className="text-[13px] font-bold">{d.truncated ? t`Jobs (showing 50)` : t`Jobs`}</h3>
          <p className="text-xs text-ink3">
            <Trans>Running first, then waiting in the order workers will take them.</Trans>
          </p>
          <ScrollArea className="max-h-[min(22rem,45dvh)]">
            <table className="mt-1 w-full min-w-[30rem] table-fixed text-[13px]">
              <caption className="sr-only">
                <Trans>Jobs waiting, running or retrying, running first</Trans>
              </caption>
              <colgroup>
                <col />
                <col className="w-[6.5rem]" />
                <col className="w-[40%]" />
                <col className="w-[5.5rem]" />
              </colgroup>
              <thead>
                <tr className="text-start text-xs text-ink3">
                  <th scope="col" className="sticky top-0 z-[1] bg-panel py-1 font-medium">
                    <Trans>Project</Trans>
                  </th>
                  <th scope="col" className="sticky top-0 z-[1] bg-panel py-1 font-medium">
                    <Trans>Stage</Trans>
                  </th>
                  <th scope="col" className="sticky top-0 z-[1] bg-panel py-1 font-medium">
                    <Trans>State</Trans>
                  </th>
                  <th scope="col" className="sticky top-0 z-[1] bg-panel py-1 text-end font-medium">
                    <Trans>For</Trans>
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.active.map((j, i) => {
                  const state =
                    j.state === "active"
                      ? { glyph: "◔", word: t`Running`, tone: "text-acc-text" }
                      : j.state === "retry"
                        ? { glyph: "↻", word: t`Retrying`, tone: "text-warn" }
                        : { glyph: "○", word: t`Waiting`, tone: "text-ink3" };
                  const prio = formatPriority(j.priority);
                  const owner = j.ownerEmail;
                  const attempt = j.attempt;
                  const href = j.projectId ? workHref(viewerId, { ...j, projectId: j.projectId }) : null;
                  return (
                    <tr key={`${j.queue}:${j.projectId}:${j.clipId}:${i}`} className="border-t border-line/60">
                      <td className="truncate py-1.5" title={owner ? t`${owner} · priority ${prio}` : t`priority ${prio}`}>
                        {j.projectId && href ? (
                          <Link to={href} className="text-ink no-underline hover:underline">
                            {j.title ?? j.projectId.slice(0, 8)}
                          </Link>
                        ) : j.projectId ? (
                          (j.title ?? j.projectId.slice(0, 8))
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="truncate py-1.5">{j.label}</td>
                      <td className="truncate py-1.5 text-xs" title={j.lastError}>
                        <span className={`font-semibold ${state.tone}`}>
                          <span className="font-mono">{state.glyph}</span> {state.word}
                        </span>
                        {j.attempt > 1 ? (
                          <span className="text-ink3">
                            {" "}
                            {"· "}
                            <Trans>try {attempt}</Trans>
                          </span>
                        ) : null}
                        {j.lastError ? <span className="text-ink2"> · {j.lastError}</span> : null}
                      </td>
                      <td className="py-1.5 text-end font-mono text-xs tabular-nums text-ink2">{elapsed(j.startedAt ?? j.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollArea>
        </div>
      )}

      <div className="flex flex-col gap-3 border-t border-line/60 pt-4">
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-bold">
            {showDismissed ? t`Dismissed failures` : t`Failed work`}
            {failures.data && total ? <span className="ms-1.5 font-normal text-ink3">{totalShown}</span> : null}
          </h3>
          <div className="flex min-h-8 min-w-[10.5rem] flex-wrap items-center justify-end gap-2">
            {filtered && items.length > 0 && !showDismissed && filter.cause !== "input" ? (
              <button type="button" className="btn-ghost h-8 text-xs" disabled={acting} onClick={() => setConfirmBulk(true)}>
                {filter.cause ? t`Retry matching (${pageOrTotal})` : t`Retry platform failures`}
              </button>
            ) : null}
            {items.length > 0 ? (
              <button type="button" className="btn-ghost h-8 text-xs" disabled={acting} onClick={() => setConfirmDismiss(true)}>
                {showDismissed
                  ? filtered
                    ? t`Restore matching (${total})`
                    : t`Restore all (${total})`
                  : filtered
                    ? t`Dismiss matching (${total})`
                    : t`Dismiss all (${total})`}
              </button>
            ) : null}
          </div>
        </div>
        <div className={`min-w-0 flex-col gap-2 sm:flex-row sm:items-center ${filtersShown ? "flex" : "hidden"}`}>
          <label className="flex h-9 min-w-0 w-full flex-1 items-center gap-2 rounded-[10px] border border-line bg-sunk px-2.5 focus-within:border-acc">
            <Search className="h-4 w-4 shrink-0 text-ink3" aria-hidden />
            <input
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink3"
              placeholder={t`Search reasons…`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label={t`Search failed work by error text`}
            />
          </label>
          <div className="flex h-9 shrink-0 items-center gap-2">
            <Select className="h-9 w-[8.75rem] shrink-0" size="sm" ariaLabel={t`Stage`} value={stage} onValueChange={setStage} options={stageOptions} />
            <Select className="h-9 w-[8.75rem] shrink-0" size="sm" ariaLabel={t`Cause`} value={cause} onValueChange={setCause} options={causeOptions} />
            <Segmented className="h-9 shrink-0" size="sm" ariaLabel={t`When`} value={since} onChange={setSince} options={sinceOptions} />
          </div>
        </div>
        <p className="flex min-h-4 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink3">
          <span>
            {failures.data
              ? items.length
                ? showDismissed
                  ? t`Showing ${shownCount} of ${totalShown} dismissed`
                  : t`Showing ${shownCount} of ${totalShown}`
                : showDismissed
                  ? t`Nothing dismissed matches`
                  : filtered
                    ? t`No failed work matches this filter`
                    : `✓ ${t`No failed projects or clips.`}`
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
              setCause("");
              setSince("");
            }}
          >
            <Trans>Clear filters</Trans>
          </button>
          <button
            type="button"
            className="btn-quiet ms-auto h-4 px-0 text-xs text-ink3"
            aria-pressed={showDismissed}
            onClick={() => setShowDismissed((v) => !v)}
          >
            {showDismissed ? t`Back to failed work` : t`Show dismissed`}
          </button>
        </p>
        {!failures.data && !failures.error ? (
          <SkeletonRegion label={t`Loading failed work…`} className="flex flex-col gap-2">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </SkeletonRegion>
        ) : items.length > 0 ? (
          <ScrollArea className={SECTION_LIST_MAX_H}>
            <table className="w-full min-w-[34rem] table-fixed text-[13px]">
              <caption className="sr-only">
                <Trans>Failed projects and clips, newest first</Trans>
              </caption>
              <colgroup>
                <col className="w-[38%]" />
                <col className="w-[6rem]" />
                <col />
                <col className="w-[5.5rem]" />
                <col className="w-[5rem]" />
              </colgroup>
              <thead>
                <tr className="text-start text-xs text-ink3">
                  <th scope="col" className="sticky top-0 z-[1] bg-panel py-1 font-medium">
                    <Trans>Item</Trans>
                  </th>
                  <th scope="col" className="sticky top-0 z-[1] bg-panel py-1 font-medium">
                    <Trans>Stage</Trans>
                  </th>
                  <th scope="col" className="sticky top-0 z-[1] bg-panel py-1 font-medium">
                    <Trans>Reason</Trans>
                  </th>
                  <th scope="col" className="sticky top-0 z-[1] bg-panel py-1 font-medium">
                    <Trans>When</Trans>
                  </th>
                  <th scope="col" className="sticky top-0 z-[1] bg-panel py-1">
                    <span className="sr-only">
                      <Trans>Actions</Trans>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => {
                  const projectTitle = row.projectTitle;
                  return (
                    <tr key={`${row.kind}:${row.id}`} className="border-t border-line/60">
                      <td className="truncate py-1.5">
                        <button
                          type="button"
                          className="block w-full truncate text-start text-ink hover:underline"
                          onClick={() => openFail({ kind: row.kind, id: row.id })}
                        >
                          {row.title}
                        </button>
                        <div className="truncate text-[11px] text-ink3" title={row.ownerEmail}>
                          {row.kind === "clip" ? (projectTitle ? t`clip · ${projectTitle}` : t`clip`) : t`project`} · {row.ownerEmail}
                        </div>
                      </td>
                      <td className="truncate py-1.5">
                        {row.stage}
                        <div className={`truncate text-[11px] ${CAUSE[row.cause].tone}`} title={i18n._(CAUSE[row.cause].title)}>
                          <span className="font-mono">{CAUSE[row.cause].glyph}</span> {i18n._(CAUSE[row.cause].word)}
                        </div>
                      </td>
                      <td className="truncate py-1.5 pe-2 text-xs text-ink2">
                        <button
                          type="button"
                          className="block w-full truncate text-start hover:underline"
                          title={row.error ?? undefined}
                          onClick={() => openFail({ kind: row.kind, id: row.id })}
                        >
                          {row.snippet}
                        </button>
                      </td>
                      <td className="truncate py-1.5 text-xs tabular-nums text-ink3" title={ago(row.failedAt)}>
                        {ago(row.failedAt)}
                      </td>
                      <td className="py-1.5 text-end">
                        {showDismissed ? (
                          <button
                            type="button"
                            className="btn-ghost h-8 min-w-[4rem] px-2 text-xs"
                            disabled={acting}
                            onClick={() => void onDismiss([{ kind: row.kind, id: row.id }])}
                          >
                            <Trans>Restore</Trans>
                          </button>
                        ) : row.retryable ? (
                          <button
                            type="button"
                            className="btn-ghost h-8 min-w-[4rem] px-2 text-xs"
                            disabled={acting}
                            onClick={() => onRetry([{ kind: row.kind, id: row.id }])}
                          >
                            <Trans>Retry</Trans>
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn-quiet h-8 min-w-[4rem] px-2 text-xs"
                            disabled={acting}
                            title={t`Clear from this list; the owner's project is untouched`}
                            onClick={() => void onDismiss([{ kind: row.kind, id: row.id }])}
                          >
                            <Trans>Dismiss</Trans>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
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
                  {failures.isFetchingNextPage ? t`Loading…` : t`Load ${nextCount} more`}
                </button>
              </div>
            )}
          </ScrollArea>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmBulk}
        onOpenChange={setConfirmBulk}
        title={t`Retry matching failures?`}
        body={
          filter.cause
            ? t`Retry up to ${PAGE} failures that match this filter. Each one uses the same path as the owner Retry button, so live-job limits still apply.`
            : t`Retry up to ${PAGE} platform failures that match this filter (a bad source or a plan refusal would fail the same way, so they are left out). Each one uses the same path as the owner Retry button, so live-job limits still apply.`
        }
        confirm={t`Retry matching`}
        onConfirm={() => onRetry()}
      />

      <ConfirmDialog
        open={confirmDismiss}
        onOpenChange={setConfirmDismiss}
        title={showDismissed ? t`Restore dismissed failures?` : t`Dismiss failed work?`}
        body={
          showDismissed
            ? filtered
              ? plural(total, {
                  one: "Bring # dismissed failure matching this filter back into Failed work.",
                  other: "Bring # dismissed failures matching this filter back into Failed work.",
                })
              : plural(total, { one: "Bring # dismissed failure back into Failed work.", other: "Bring # dismissed failures back into Failed work." })
            : filtered
              ? plural(total, {
                  one: "Clear # failure matching this filter from this list. The owners' projects keep their error and their own Retry, and anything that fails again shows up here again. Show dismissed brings them back.",
                  other:
                    "Clear # failures matching this filter from this list. The owners' projects keep their error and their own Retry, and anything that fails again shows up here again. Show dismissed brings them back.",
                })
              : plural(total, {
                  one: "Clear # failure from this list. The owners' projects keep their error and their own Retry, and anything that fails again shows up here again. Show dismissed brings them back.",
                  other:
                    "Clear # failures from this list. The owners' projects keep their error and their own Retry, and anything that fails again shows up here again. Show dismissed brings them back.",
                })
        }
        confirm={showDismissed ? t`Restore` : t`Dismiss`}
        onConfirm={() => onDismiss()}
      />

      <Modal open={!!sel} onOpenChange={(o) => !o && closeFail()} title={detail ? detail.title : t`Failed work`} width={520}>
        {loadingDetail ? (
          <SkeletonRegion label={t`Loading failure…`} className="flex flex-col gap-2">
            <Dialog.Description className="sr-only">
              <Trans>Loading the recorded reason</Trans>
            </Dialog.Description>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </SkeletonRegion>
        ) : detail ? (
          <>
            <Dialog.Description asChild>
              <p className="text-sm text-ink2">
                {detail.kind === "clip" ? (detailProject ? t`Clip on ${detailProject}` : t`Clip`) : t`Project`} · {detail.stage} ·{" "}
                {i18n._(CAUSE[detail.cause].word)} · {detail.ownerEmail} · {ago(detail.failedAt)}
              </p>
            </Dialog.Description>
            <p className="min-h-4 text-xs text-ink3">{retryHint(detail)}</p>
            <ScrollArea className="max-h-[min(16rem,40dvh)] rounded-[10px] border border-line bg-sunk">
              <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-ink">
                {detail.error?.trim() || t`Failed with no reason recorded`}
              </pre>
            </ScrollArea>
            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="btn-quiet min-w-[6.5rem]"
                onClick={() => void navigator.clipboard.writeText(detail.error?.trim() || "").then(() => toast(t`Reason copied`))}
              >
                <Trans>Copy reason</Trans>
              </button>
              <Link to={workHref(viewerId, detail) ?? accountHref(detail.ownerEmail)} className="btn-ghost min-w-[7.5rem] no-underline" onClick={closeFail}>
                {detail.ownerId === viewerId ? t`Open project` : t`Open account`}
              </Link>
              <button
                type="button"
                className="btn-ghost min-w-[6rem]"
                disabled={acting}
                onClick={() => void onDismiss([{ kind: detail.kind, id: detail.id }], true, !!detail.dismissedAt)}
              >
                {detail.dismissedAt ? t`Restore` : t`Dismiss`}
              </button>
              <button
                type="button"
                className={`${detail.retryable ? "btn-ink" : "btn-ghost"} min-w-[5.5rem]`}
                disabled={acting}
                onClick={() => onRetry([{ kind: detail.kind, id: detail.id }], true)}
              >
                <Trans>Retry</Trans>
              </button>
            </div>
          </>
        ) : (
          <Dialog.Description asChild>
            <p className="text-sm text-ink2">{got.isError ? got.error.message : t`This failure is gone (retried or deleted).`}</p>
          </Dialog.Description>
        )}
      </Modal>
    </section>
  );
}
