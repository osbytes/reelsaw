/**
 * Settings → System → Machine: expected vs actual processing time per stage on this instance, learned from
 * its finished projects with the current models. Nothing to configure: the runs are the calibration.
 */
import { useQuery } from "@tanstack/react-query";
import { formatTime } from "@reelsaw/shared";
import { useTRPC } from "../lib/trpc";
import { Skeleton, SkeletonRegion } from "./ui";

const STAGE: Record<string, string> = { ingest: "Download", transcribe: "Transcribe", refine: "Refine", analyze: "Find moments", render: "Render" };
const TEN_MIN = 600;

export function ProcessingTimes() {
  const trpc = useTRPC();
  const q = useQuery(trpc.admin.processingTimes.queryOptions());
  const d = q.data;
  if (q.error && !d) return <div className="h-5 text-xs text-ink3">{q.error.message}</div>;
  if (!d)
    return (
      <SkeletonRegion label="Loading processing times…" className="flex flex-col gap-3 border-t border-line pt-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-full" />
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex h-8 items-center gap-4 border-t border-line/60">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="ml-auto h-3.5 w-14" />
            <Skeleton className="h-3.5 w-14" />
            <Skeleton className="h-3.5 w-14" />
            <Skeleton className="h-3.5 w-16" />
          </div>
        ))}
      </SkeletonRegion>
    );
  const learned = d.stages.filter((s) => s.source === "history").length;
  const total = d.stages.reduce((a, s) => a + s.factor, 0);
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[14px] font-bold">Processing time</h3>
        <span className="text-xs text-ink3">
          {d.samples
            ? `learned from ${d.samples} finished project${d.samples === 1 ? "" : "s"} with the current models${learned < d.stages.length ? `; ${d.stages.length - learned} stage${d.stages.length - learned === 1 ? "" : "s"} still on defaults` : ""}`
            : "no finished project with the current models yet; showing defaults from the README until one finishes"}
        </span>
      </div>
      <p className="text-[13px] text-ink2">
        A 10-minute video takes about <b className="font-mono text-xs tabular-nums">{formatTime(total * TEN_MIN)}</b> end to end with <span className="font-mono text-xs">{d.models.language}</span> and <span className="font-mono text-xs">{d.models.transcription}</span>. Refine runs alongside finding moments, so stages don’t add up exactly.
      </p>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-xs text-ink3">
            <th className="py-1 font-medium">Stage</th>
            <th className="py-1 text-right font-medium">Per 10 min of video</th>
            <th className="py-1 text-right font-medium">Actual avg</th>
            <th className="py-1 text-right font-medium">Expected avg</th>
            <th className="py-1 text-right font-medium">Basis</th>
          </tr>
        </thead>
        <tbody className="font-mono text-xs tabular-nums">
          {d.stages.map((s) => (
            <tr key={s.stage} className="border-t border-line/60">
              <td className="py-1.5 font-sans text-[13px]">{STAGE[s.stage] ?? s.stage}</td>
              <td className="py-1.5 text-right">~{formatTime(s.factor * TEN_MIN)}</td>
              <td className="py-1.5 text-right">{s.actualAvgSec !== null ? formatTime(s.actualAvgSec) : "—"}</td>
              <td className="py-1.5 text-right">{s.expectedAvgSec !== null ? formatTime(s.expectedAvgSec) : "—"}</td>
              <td className="py-1.5 text-right font-sans text-xs text-ink3">{s.source === "history" ? `${s.samples} project${s.samples === 1 ? "" : "s"}` : "default"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.recent.length > 0 && (
        <details className="text-[13px]">
          <summary className="cursor-pointer text-xs text-ink3 hover:text-ink">Recent projects: actual / expected per stage</summary>
          <table className="mt-2 w-full">
            <thead>
              <tr className="text-left text-xs text-ink3">
                <th className="py-1 font-medium">Project</th>
                <th className="py-1 text-right font-medium">Length</th>
                {d.stages.map((s) => (
                  <th key={s.stage} className="py-1 text-right font-medium">
                    {STAGE[s.stage] ?? s.stage}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono text-xs tabular-nums">
              {d.recent.map((r) => (
                <tr key={r.projectId} className="border-t border-line/60">
                  <td className="max-w-[220px] truncate py-1.5 font-sans text-[13px]">
                    <a href={`/projects/${r.projectId}`} className="text-ink no-underline hover:text-acc-text">
                      {r.title}
                    </a>
                  </td>
                  <td className="py-1.5 text-right">{formatTime(r.durationSec)}</td>
                  {d.stages.map((s) => {
                    const v = r.stages[s.stage];
                    return (
                      <td key={s.stage} className={`py-1.5 text-right ${v && v.actualSec > v.expectedSec * 1.5 ? "text-warn" : ""}`}>
                        {v && v.actualSec > v.expectedSec * 1.5 ? "▲ " : ""}{v ? `${formatTime(v.actualSec)} / ~${formatTime(v.expectedSec)}` : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
