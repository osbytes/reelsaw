/**
 * Settings → System → Workers: every process that has checked in, with specs and what it last
 * reported it was processing. Admins only (the query is admin.workers.list).
 */
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "../lib/trpc";
import { Skeleton, SkeletonRegion } from "./ui";

const ROLE: Record<string, string> = { app: "this box", api: "API", worker: "worker" };

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

export function WorkersSection() {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.admin.workers.list.queryOptions(), refetchInterval: 5000 });
  const d = q.data;

  return (
    <section id="workers" className="flex scroll-mt-4 flex-col gap-4 rounded-[16px] border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[15px] font-bold">Workers</h2>
        <span className="min-h-4 text-xs text-ink3">
          {d
            ? d.items.length
              ? `${d.live} online${d.stale ? ` · ${d.stale} last seen over 45s ago` : ""}`
              : "no process has checked in yet"
            : q.error
              ? q.error.message
              : ""}
        </span>
      </div>
      <p className="text-[13px] text-ink2">Every API and worker process reports every 15 seconds: CPUs, memory, disk, GPU, render slots, and the jobs it is running. A replica that stops checking in is marked gone after 45 seconds.</p>
      {q.error && !d ? (
        <div className="h-5 text-xs text-ink3">{q.error.message}</div>
      ) : !d ? (
        <SkeletonRegion label="Loading workers…" className="flex flex-col">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="flex h-[4.25rem] items-center gap-4 border-t border-line/60">
              <div className="min-w-0 flex-1">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="mt-2 h-3 w-3/5" />
              </div>
              <Skeleton className="h-3 w-14 shrink-0" />
            </div>
          ))}
        </SkeletonRegion>
      ) : d.items.length === 0 ? (
        <p className="text-[13px] text-ink3">Waiting for the first heartbeat. Restart the app if this stays empty.</p>
      ) : (
        <ul className="flex flex-col">
          {d.items.map((w) => {
            const seen = w.live ? ago(w.lastSeenAgoSec) : `gone ${ago(w.lastSeenAgoSec)}`;
            const work = w.processing.length
              ? w.processing.map((p) => `${queueLabel(p.queue)}${p.title ? ` · ${p.title}` : ""}`).join(", ")
              : w.live
                ? "idle"
                : "—";
            const specs = `${w.cpus} CPU · ${gb(w.memTotalMB)} · ${diskLine(w)} · ${gpuLine(w)} · ${w.renders.running}/${w.renders.max} renders`;
            return (
              <li key={w.id} className={`flex items-start gap-4 border-t border-line/60 py-3 ${w.live ? "" : "text-ink3"}`}>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate font-mono text-xs" title={w.id}>
                      {w.id}
                    </span>
                    <span className="chip shrink-0 bg-sunk text-ink2">{ROLE[w.role] ?? w.role}</span>
                    {diskPaused(w) ? (
                      <span className="chip shrink-0 bg-warn-soft text-warn" title="Not taking media jobs: disk is below the floor and nothing more can be evicted. Other workers take them; it resumes once free disk is back.">
                        disk full
                      </span>
                    ) : null}
                    {w.thisProcess ? <span className="shrink-0 text-[11px] text-ink3">this process</span> : null}
                  </div>
                  <div className="mt-1 truncate text-xs text-ink2" title={specs}>
                    {specs}
                  </div>
                </div>
                <div className="w-[7rem] shrink-0 pt-0.5 text-right">
                  <div className="h-4 truncate text-[11px] tabular-nums leading-4 text-ink3" title={seen}>
                    {seen}
                  </div>
                  <div className="mt-1 h-4 truncate text-xs leading-4" title={work}>
                    {work}
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

/** One-line summary for Overview, linking to #workers. */
export function WorkersOnlineLine() {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.admin.workers.list.queryOptions(), refetchInterval: 5000 });
  const d = q.data;
  if (!d || !d.items.length) return <div className="h-5" />;
  return (
    <a
      href="#workers"
      onClick={(e) => {
        e.preventDefault();
        document.getElementById("workers")?.scrollIntoView({ behavior: "smooth", block: "start" });
        history.replaceState(null, "", "#workers");
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      }}
      className="block min-h-5 text-[13px] text-ink2 no-underline hover:text-ink"
    >
      {d.live === 1 ? "1 process online" : `${d.live} processes online`}
      {d.stale ? ` · ${d.stale} gone` : ""}
    </a>
  );
}
