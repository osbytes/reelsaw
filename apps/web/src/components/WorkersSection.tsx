/**
 * Settings → System → Workers: every process that has checked in, with what it is doing, whether it can take
 * heavy jobs right now (and why not), and its specs. Admins only (the query is admin.workers.list).
 */
import { useQuery } from "@tanstack/react-query";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useTRPC } from "../lib/trpc";
import { pausedWord } from "./FleetSummary";
import { Skeleton, SkeletonRegion } from "./ui";
import { formatMb, formatNumber } from "@reelsaw/shared";

function roleLabel(role: string): string {
  if (role === "app") return t`API + worker`;
  if (role === "api") return t`API only`;
  if (role === "worker") return t`worker`;
  return role;
}

/** How long since the last check-in, short: "just now", "12s ago", "3m ago", "2h ago". */
function ago(sec: number) {
  if (sec < 5) return t`just now`;
  if (sec < 60) return t`${sec}s ago`;
  const m = Math.round(sec / 60);
  if (sec < 3600) return t`${m}m ago`;
  const h = Math.round(sec / 3600);
  return t`${h}h ago`;
}

/** The same span without "ago": "12s", "3m", "2h". */
function span(sec: number) {
  if (sec < 60) return `${formatNumber(sec)}s`;
  if (sec < 3600) return `${formatNumber(Math.round(sec / 60))}m`;
  return `${formatNumber(Math.round(sec / 3600))}h`;
}

function queueLabel(q: string) {
  return q.split(".").pop() ?? q;
}

function diskLine(w: { diskFreeMB: number; diskTotalMB: number; diskLeasedMB: number }) {
  if (w.diskFreeMB < 0) return t`disk n/a`;
  // leased: free bytes jobs in flight on this volume have claimed for the scratch they are writing
  const free = formatMb(w.diskFreeMB);
  const leased = formatMb(w.diskLeasedMB);
  return w.diskLeasedMB > 0 ? t`${free} free (${leased} leased)` : t`${free} free`;
}

/** A worker process that dropped the media queues: short of disk with nothing left to evict (queue/disk-gate.ts). */
function diskPaused(w: { role: string; live: boolean; queues: string[] }) {
  return w.live && w.role !== "api" && w.queues.length > 0 && !w.queues.includes("project.ingest");
}

/** cores and memory jobs in flight on this host have leased (ffmpeg threads, render memory), when there are any */
function cpuLine(w: { cpus: number; coresLeased: number }) {
  const cpus = w.cpus;
  const leased = w.coresLeased;
  return w.coresLeased > 0 ? t`${cpus} CPU (${leased} leased)` : t`${cpus} CPU`;
}
function memLine(w: { memTotalMB: number; memLeasedMB: number }) {
  const total = formatMb(w.memTotalMB);
  const leased = formatMb(w.memLeasedMB);
  return w.memLeasedMB > 0 ? t`${total} (${leased} leased)` : total;
}

function gpuLine(w: { gpu: { vendor: string; devices: string[]; note: string } | null }) {
  if (!w.gpu) return t`no GPU`;
  return w.gpu.devices[0] || w.gpu.vendor;
}

type Status = { glyph: string; word: string; tone: string; title: string };

function statusOf(w: { live: boolean; role: string; queues: string[]; paused: string | null; lastSeenAgoSec: number }): Status {
  if (!w.live) {
    const silent = span(w.lastSeenAgoSec);
    return { glyph: "○", word: t`Gone`, tone: "text-ink3", title: t`No check-in for ${silent}` };
  }
  if (diskPaused(w))
    return {
      glyph: "◷",
      word: t`Disk full`,
      tone: "text-warn",
      title: t`Not taking media jobs: disk is below the floor and nothing more can be evicted. Other workers take them; it resumes once free disk is back.`,
    };
  if (w.paused) {
    const why = pausedWord(w.paused);
    return { glyph: "◷", word: t`Paused`, tone: "text-warn", title: t`Heavy jobs wait here: ${why}` };
  }
  if (w.role === "api") return { glyph: "●", word: t`Serving`, tone: "text-ok", title: t`Serves the app and API; runs no jobs` };
  return { glyph: "●", word: t`Online`, tone: "text-ok", title: t`Takes jobs` };
}

export function WorkersSection() {
  const { t: tr } = useLingui();
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.admin.workers.list.queryOptions(), refetchInterval: 5000 });
  const d = q.data;
  const version = d?.items.find((w) => w.thisProcess)?.version;
  const liveCount = d?.live ?? 0;
  const staleCount = d?.stale ?? 0;

  return (
    <section id="workers" className="flex scroll-mt-4 flex-col gap-4 rounded-[16px] border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[15px] font-bold">
          <Trans>Workers</Trans>
        </h2>
        <span className="min-h-4 text-xs text-ink3">
          {d
            ? d.items.length
              ? d.stale
                ? tr`${liveCount} online · ${staleCount} gone`
                : tr`${liveCount} online`
              : tr`no process has checked in yet`
            : q.error
              ? q.error.message
              : ""}
        </span>
      </div>
      <p className="text-[13px] text-ink2">
        <Trans>
          Each process checks in every 15 seconds with its specs, whether it has room for heavy jobs, and what it is running. One that stops checking in is gone
          after 45 seconds and dropped after an hour.
        </Trans>
      </p>
      {q.error && !d ? (
        <div className="h-5 text-xs text-ink3">{q.error.message}</div>
      ) : !d ? (
        <SkeletonRegion label={tr`Loading workers…`} className="flex flex-col">
          {Array.from({ length: 2 }, (_, i) => (
            <div
              key={i}
              className="grid h-[3.75rem] grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 border-t border-line/60 sm:grid-cols-[6.5rem_minmax(0,1fr)_13rem]"
            >
              <Skeleton className="h-3.5 w-16" />
              <div>
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="mt-2 h-3 w-3/5" />
              </div>
              <Skeleton className="hidden h-3 w-24 justify-self-end sm:block" />
            </div>
          ))}
        </SkeletonRegion>
      ) : d.items.length === 0 ? (
        <p className="text-[13px] text-ink3">
          <Trans>Waiting for the first heartbeat. Restart the app if this stays empty.</Trans>
        </p>
      ) : (
        <ul className="flex flex-col">
          {d.items.map((w) => {
            const st = statusOf(w);
            const work = w.processing.length
              ? w.processing.map((p) => `${queueLabel(p.queue)}${p.title ? ` · ${p.title}` : ""}`).join(", ")
              : w.role === "api"
                ? "—"
                : w.live
                  ? tr`idle`
                  : "—";
            const running = w.renders.running;
            const max = w.renders.max;
            const specs = `${cpuLine(w)} · ${memLine(w)} · ${diskLine(w)} · ${gpuLine(w)}${w.role === "api" ? "" : ` · ${tr`${running}/${max} renders`}`}`;
            const otherVersion = w.live && version && w.version !== version;
            const seen = ago(w.lastSeenAgoSec);
            return (
              <li
                key={w.id}
                className={`grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-3 border-t border-line/60 py-3 sm:grid-cols-[6.5rem_minmax(0,1fr)_13rem] ${w.live ? "" : "text-ink3"}`}
              >
                <span className={`pt-px text-xs font-semibold whitespace-nowrap ${st.tone}`} title={st.title}>
                  <span className="font-mono">{st.glyph}</span> {st.word}
                </span>
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate font-mono text-xs" title={w.id}>
                      {w.id}
                    </span>
                    <span className="chip shrink-0 bg-sunk px-2 py-0.5 text-[11px] text-ink2">{roleLabel(w.role)}</span>
                    {otherVersion ? (
                      <span className="chip shrink-0 bg-warn-soft px-2 py-0.5 text-[11px] text-ink" title={tr`This page is served by ${version}`}>
                        {w.version}
                      </span>
                    ) : null}
                    {w.thisProcess ? (
                      <span className="shrink-0 text-[11px] text-ink3">
                        <Trans>this page</Trans>
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 truncate text-xs text-ink2" title={specs}>
                    {specs}
                  </div>
                  {/* phones: what it is doing folds under the specs */}
                  <div className="mt-0.5 truncate text-xs text-ink3 sm:hidden" title={work}>
                    {work} · {w.live ? seen : tr`gone ${seen}`}
                  </div>
                </div>
                <div className="hidden min-w-0 text-end sm:block">
                  <div className="truncate text-xs leading-5" title={work}>
                    {work}
                  </div>
                  <div className="truncate text-[11px] leading-4 tabular-nums text-ink3">{w.live ? tr`checked in ${seen}` : tr`gone ${seen}`}</div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
