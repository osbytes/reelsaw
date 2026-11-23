/**
 * Settings → System → Machine: expected vs actual processing time per stage on this instance, learned from
 * its finished projects with the current models. Nothing to configure: the runs are the calibration.
 */
import { useQuery } from "@tanstack/react-query";
import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { formatTime, projectPath } from "@reelsaw/shared";
import { useTRPC } from "../lib/trpc";
import { Skeleton, SkeletonRegion } from "./ui";

const STAGE: Record<string, MessageDescriptor> = {
  ingest: msg`Source`,
  transcribe: msg`Transcribe`,
  refine: msg`Refine`,
  analyze: msg`Find moments`,
  render: msg`Render`,
};
const stageLabel = (stage: string) => {
  const d = STAGE[stage];
  return d ? i18n._(d) : stage;
};
const TEN_MIN = 600;

export function ProcessingTimes() {
  const { t } = useLingui();
  const trpc = useTRPC();
  const q = useQuery(trpc.admin.processingTimes.queryOptions());
  const d = q.data;
  if (q.error && !d) return <div className="h-5 text-xs text-ink3">{q.error.message}</div>;
  if (!d)
    return (
      <SkeletonRegion label={t`Loading processing times…`} className="flex flex-col gap-3 border-t border-line pt-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-full" />
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex h-8 items-center gap-4 border-t border-line/60">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="ms-auto h-3.5 w-14" />
            <Skeleton className="h-3.5 w-14" />
            <Skeleton className="h-3.5 w-14" />
            <Skeleton className="h-3.5 w-16" />
          </div>
        ))}
      </SkeletonRegion>
    );
  const learned = d.stages.filter((s) => s.source === "history").length;
  const total = d.stages.reduce((a, s) => a + s.factor, 0);
  const samples = d.samples;
  const onDefaults = d.stages.length - learned;
  const tenMinutes = formatTime(total * TEN_MIN);
  const language = d.models.language;
  const transcription = d.models.transcription;
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[14px] font-bold">
          <Trans>Processing time</Trans>
        </h3>
        <span className="text-xs text-ink3">
          {d.samples
            ? learned < d.stages.length
              ? t`learned from ${plural(samples, { one: "# finished project", other: "# finished projects" })} with the current models; ${plural(onDefaults, { one: "# stage", other: "# stages" })} still on defaults`
              : t`learned from ${plural(samples, { one: "# finished project", other: "# finished projects" })} with the current models`
            : t`no finished project with the current models yet; showing defaults from the README until one finishes`}
        </span>
      </div>
      <p className="text-[13px] text-ink2">
        <Trans>
          A 10-minute video takes about <b className="font-mono text-xs tabular-nums">{tenMinutes}</b> end to end with{" "}
          <span className="font-mono text-xs">{language}</span> and <span className="font-mono text-xs">{transcription}</span>. Refine runs alongside finding
          moments, so stages don’t add up exactly.
        </Trans>
      </p>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-start text-xs text-ink3">
            <th className="py-1 font-medium">
              <Trans>Stage</Trans>
            </th>
            <th className="py-1 text-end font-medium">
              <Trans>Per 10 min of video</Trans>
            </th>
            <th className="py-1 text-end font-medium">
              <Trans>Actual avg</Trans>
            </th>
            <th className="py-1 text-end font-medium">
              <Trans>Expected avg</Trans>
            </th>
            <th className="py-1 text-end font-medium">
              <Trans>Basis</Trans>
            </th>
          </tr>
        </thead>
        <tbody className="font-mono text-xs tabular-nums">
          {d.stages.map((s) => (
            <tr key={s.stage} className="border-t border-line/60">
              <td className="py-1.5 font-sans text-[13px]">{stageLabel(s.stage)}</td>
              <td className="py-1.5 text-end">~{formatTime(s.factor * TEN_MIN)}</td>
              <td className="py-1.5 text-end">{s.actualAvgSec !== null ? formatTime(s.actualAvgSec) : "—"}</td>
              <td className="py-1.5 text-end">{s.expectedAvgSec !== null ? formatTime(s.expectedAvgSec) : "—"}</td>
              <td className="py-1.5 text-end font-sans text-xs text-ink3">
                {s.source === "history" ? plural(s.samples, { one: "# project", other: "# projects" }) : t`default`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.recent.length > 0 && (
        <details className="text-[13px]">
          <summary className="cursor-pointer text-xs text-ink3 hover:text-ink">
            <Trans>Recent projects: actual / expected per stage</Trans>
          </summary>
          <table className="mt-2 w-full">
            <thead>
              <tr className="text-start text-xs text-ink3">
                <th className="py-1 font-medium">
                  <Trans>Project</Trans>
                </th>
                <th className="py-1 text-end font-medium">
                  <Trans>Length</Trans>
                </th>
                {d.stages.map((s) => (
                  <th key={s.stage} className="py-1 text-end font-medium">
                    {stageLabel(s.stage)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono text-xs tabular-nums">
              {d.recent.map((r) => (
                <tr key={r.projectId} className="border-t border-line/60">
                  <td className="max-w-[220px] truncate py-1.5 font-sans text-[13px]">
                    <a href={projectPath(r.projectId)} className="text-ink no-underline hover:text-acc-text">
                      {r.title}
                    </a>
                  </td>
                  <td className="py-1.5 text-end">{formatTime(r.durationSec)}</td>
                  {d.stages.map((s) => {
                    const v = r.stages[s.stage];
                    return (
                      <td key={s.stage} className={`py-1.5 text-end ${v && v.actualSec > v.expectedSec * 1.5 ? "text-warn" : ""}`}>
                        {v && v.actualSec > v.expectedSec * 1.5 ? "▲ " : ""}
                        {v ? `${formatTime(v.actualSec)} / ~${formatTime(v.expectedSec)}` : "—"}
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
