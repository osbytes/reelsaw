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
      <p className="text-[13px] text-ink2">Every API and worker process reports every 15 seconds: CPUs, memory, GPU, render slots, and the jobs it is running. A replica that stops checking in is marked gone after 45 seconds.</p>
      {q.error && !d ? (
        <div className="h-5 text-xs text-ink3">{q.error.message}</div>
      ) : !d ? (
        <SkeletonRegion label="Loading workers…" className="flex flex-col gap-2">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="flex h-14 items-center gap-4 border-t border-line/60">
              <Skeleton className="h-3.5 w-36" />
              <Skeleton className="ml-auto h-3.5 w-16" />
              <Skeleton className="h-3.5 w-24" />
            </div>
          ))}
        </SkeletonRegion>
      ) : d.items.length === 0 ? (
        <p className="text-[13px] text-ink3">Waiting for the first heartbeat. Restart the app if this stays empty.</p>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-xs text-ink3">
              <th className="py-1 font-medium">Process</th>
              <th className="py-1 font-medium">Role</th>
              <th className="py-1 text-right font-medium">CPUs</th>
              <th className="py-1 text-right font-medium">Memory</th>
              <th className="hidden py-1 font-medium sm:table-cell">GPU</th>
              <th className="py-1 text-right font-medium">Renders</th>
              <th className="py-1 font-medium">Processing</th>
            </tr>
          </thead>
          <tbody>
            {d.items.map((w) => (
              <tr key={w.id} className={`border-t border-line/60 ${w.live ? "" : "text-ink3"}`}>
                <td className="max-w-[12rem] truncate py-1.5 font-mono text-xs" title={w.id}>
                  {w.id}
                  <div className="font-sans text-[11px] text-ink3">
                    {w.live ? (w.thisProcess ? "this process · " : "") + ago(w.lastSeenAgoSec) : `gone · last seen ${ago(w.lastSeenAgoSec)}`}
                    {` · ${w.version}`}
                  </div>
                </td>
                <td className="py-1.5">{ROLE[w.role] ?? w.role}</td>
                <td className="py-1.5 text-right font-mono text-xs tabular-nums">{w.cpus}</td>
                <td className="py-1.5 text-right font-mono text-xs tabular-nums">{gb(w.memTotalMB)}</td>
                <td className="hidden max-w-[10rem] truncate py-1.5 text-xs sm:table-cell" title={w.gpu ? `${w.gpu.vendor}: ${w.gpu.devices.join(", ") || w.gpu.note}` : "none"}>
                  {w.gpu ? w.gpu.devices[0] || w.gpu.vendor : "none"}
                </td>
                <td className="py-1.5 text-right font-mono text-xs tabular-nums">
                  {w.renders.running}/{w.renders.max}
                </td>
                <td className="max-w-[14rem] truncate py-1.5 text-xs" title={w.processing.map((p) => `${p.queue} ${p.title ?? p.projectId}`).join(", ")}>
                  {w.processing.length
                    ? w.processing.map((p) => `${queueLabel(p.queue)}${p.title ? ` · ${p.title}` : ""}`).join(", ")
                    : w.live
                      ? "idle"
                      : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
      }}
      className="block min-h-5 text-[13px] text-ink2 no-underline hover:text-ink"
    >
      {d.live === 1 ? "1 process online" : `${d.live} processes online`}
      {d.stale ? ` · ${d.stale} gone` : ""}
    </a>
  );
}
