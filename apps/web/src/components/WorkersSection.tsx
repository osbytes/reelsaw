/**
 * Settings → System → Workers: every process that has checked in, with what it is doing, whether it can take
 * heavy jobs right now (and why not), and its specs. Admins only (the query is admin.workers.list).
 */
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "../lib/trpc";
import { pausedWord } from "./FleetSummary";
import { Skeleton, SkeletonRegion } from "./ui";

const ROLE: Record<string, string> = { app: "API + worker", api: "API only", worker: "worker" };

function gb(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function ago(sec: number) {
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function queueLabel(q: string) {
  return q.split(".").pop() ?? q;
}

function diskLine(w: { diskFreeMB: number; diskTotalMB: number; diskLeasedMB: number }) {
  if (w.diskFreeMB < 0) return "disk n/a";
  // leased: free bytes jobs in flight on this volume have claimed for the scratch they are writing
  return `${gb(w.diskFreeMB)} free${w.diskLeasedMB > 0 ? ` (${gb(w.diskLeasedMB)} leased)` : ""}`;
}

/** A worker process that dropped the media queues: short of disk with nothing left to evict (queue/disk-gate.ts). */
function diskPaused(w: { role: string; live: boolean; queues: string[] }) {
  return w.live && w.role !== "api" && w.queues.length > 0 && !w.queues.includes("project.ingest");
}

function gpuLine(w: { gpu: { vendor: string; devices: string[]; note: string } | null }) {
  if (!w.gpu) return "no GPU";
  return w.gpu.devices[0] || w.gpu.vendor;
}

type Status = { glyph: string; word: string; tone: string; title: string };

function statusOf(w: { live: boolean; role: string; queues: string[]; paused: string | null; lastSeenAgoSec: number }): Status {
  if (!w.live) return { glyph: "○", word: "Gone", tone: "text-ink3", title: `No check-in for ${ago(w.lastSeenAgoSec).replace(" ago", "")}` };
  if (diskPaused(w))
    return {
      glyph: "◷",
      word: "Disk full",
      tone: "text-warn",
      title: "Not taking media jobs: disk is below the floor and nothing more can be evicted. Other workers take them; it resumes once free disk is back.",
    };
  if (w.paused) return { glyph: "◷", word: "Paused", tone: "text-warn", title: `Heavy jobs wait here: ${pausedWord(w.paused)}` };
  if (w.role === "api") return { glyph: "●", word: "Serving", tone: "text-ok", title: "Serves the app and API; runs no jobs" };
  return { glyph: "●", word: "Online", tone: "text-ok", title: "Takes jobs" };
}

export function WorkersSection() {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.admin.workers.list.queryOptions(), refetchInterval: 5000 });
  const d = q.data;
  const version = d?.items.find((w) => w.thisProcess)?.version;

  return (
    <section id="workers" className="flex scroll-mt-4 flex-col gap-4 rounded-[16px] border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[15px] font-bold">Workers</h2>
        <span className="min-h-4 text-xs text-ink3">
          {d ? (d.items.length ? `${d.live} online${d.stale ? ` · ${d.stale} gone` : ""}` : "no process has checked in yet") : q.error ? q.error.message : ""}
        </span>
      </div>
      <p className="text-[13px] text-ink2">
        Each process checks in every 15 seconds with its specs, whether it has room for heavy jobs, and what it is running. One that stops checking in is gone
        after 45 seconds and dropped after an hour.
      </p>
      {q.error && !d ? (
        <div className="h-5 text-xs text-ink3">{q.error.message}</div>
      ) : !d ? (
        <SkeletonRegion label="Loading workers…" className="flex flex-col">
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
        <p className="text-[13px] text-ink3">Waiting for the first heartbeat. Restart the app if this stays empty.</p>
      ) : (
        <ul className="flex flex-col">
          {d.items.map((w) => {
            const st = statusOf(w);
            const work = w.processing.length
              ? w.processing.map((p) => `${queueLabel(p.queue)}${p.title ? ` · ${p.title}` : ""}`).join(", ")
              : w.role === "api"
                ? "—"
                : w.live
                  ? "idle"
                  : "—";
            const specs = `${w.cpus} CPU · ${gb(w.memTotalMB)} · ${diskLine(w)} · ${gpuLine(w)}${w.role === "api" ? "" : ` · ${w.renders.running}/${w.renders.max} renders`}`;
            const otherVersion = w.live && version && w.version !== version;
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
                    <span className="chip shrink-0 bg-sunk px-2 py-0.5 text-[11px] text-ink2">{ROLE[w.role] ?? w.role}</span>
                    {otherVersion ? (
                      <span className="chip shrink-0 bg-warn-soft px-2 py-0.5 text-[11px] text-ink" title={`This page is served by ${version}`}>
                        {w.version}
                      </span>
                    ) : null}
                    {w.thisProcess ? <span className="shrink-0 text-[11px] text-ink3">this page</span> : null}
                  </div>
                  <div className="mt-1 truncate text-xs text-ink2" title={specs}>
                    {specs}
                  </div>
                  {/* phones: what it is doing folds under the specs */}
                  <div className="mt-0.5 truncate text-xs text-ink3 sm:hidden" title={work}>
                    {work} · {w.live ? ago(w.lastSeenAgoSec) : `gone ${ago(w.lastSeenAgoSec)}`}
                  </div>
                </div>
                <div className="hidden min-w-0 text-right sm:block">
                  <div className="truncate text-xs leading-5" title={work}>
                    {work}
                  </div>
                  <div className="truncate text-[11px] leading-4 tabular-nums text-ink3">
                    {w.live ? `checked in ${ago(w.lastSeenAgoSec)}` : `gone ${ago(w.lastSeenAgoSec)}`}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
