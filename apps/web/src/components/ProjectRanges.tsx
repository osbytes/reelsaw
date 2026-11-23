/**
 * A project's ranges on its page (docs/specs/range-clipping.md): what was processed, the clips in it, and new ranges
 * drawn on the hatched time that is not processed yet. "Clip N ranges" adds them (`projects.extend` with ranges): only
 * the new time is fetched, transcribed and counted, and the clips, fixes and decisions already there stay.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { formatTime, planRanges, spansSec } from "@reelsaw/shared";
import { useTRPC } from "../lib/trpc";
import { QuotaNotice, quotaFromError } from "./QuotaNotice";
import { RangeList, RangeTimeline, type DraftRange } from "./RangeTimeline";

interface ProjectRange {
  id: string;
  startSec: number;
  endSec: number;
  mode: "find" | "clip";
  origin: string;
  label: string | null;
}

/** Whether a project's page shows its ranges: it chose ranges, or part of its video is not processed yet. */
export function showsRanges(p: { durationSec: number | null; ranges?: ProjectRange[] | undefined }): boolean {
  if (!p.durationSec || !p.ranges?.length) return false;
  return p.ranges.some((r) => r.origin !== "whole") || spansSec(p.ranges.map((r) => [r.startSec, r.endSec])) < p.durationSec - 1;
}

export function ProjectRanges({
  projectId,
  durationSec,
  ranges,
  clips,
  maxClipSec,
  busy,
  onExtended,
}: {
  projectId: string;
  durationSec: number;
  ranges: ProjectRange[];
  clips: ReadonlyArray<{ startSec: number; endSec: number }>;
  maxClipSec: number;
  /** the project is working: adding waits until it is done */
  busy: boolean;
  onExtended: () => void;
}) {
  const { t } = useLingui();
  const trpc = useTRPC();
  const [adding, setAdding] = useState(false);
  const [drafts, setDrafts] = useState<DraftRange[]>([]);
  const extend = useMutation({ ...trpc.projects.extend.mutationOptions(), onSuccess: () => (setDrafts([]), setAdding(false), onExtended()) });
  const fixed = ranges.map((r) => ({ startSec: r.startSec, endSec: r.endSec }));
  const ordered = [...drafts].sort((a, b) => a.startSec - b.startSec).map((r) => ({ startSec: r.startSec, endSec: r.endSec, mode: r.mode }));
  // what the new ranges would count: only time no range of the project covers yet (the server plans the same way)
  const plan = ordered.length ? planRanges(ordered, { durationSec, maxClipSec, processed: fixed.map((r) => [r.startSec, r.endSec]) }) : null;
  const billed = plan?.ok ? plan.billedSec : 0;
  const quota = extend.error ? quotaFromError(extend.error) : null;
  const n = ordered.length;
  return (
    <section className="flex flex-col gap-2 rounded-[14px] border border-line bg-panel p-3" aria-labelledby="project-ranges">
      <div className="flex items-center justify-between gap-2">
        <h2 id="project-ranges" className="text-[13px] font-bold">
          <Trans>Ranges</Trans>
        </h2>
        {!adding && (
          <button
            type="button"
            className="btn-ghost py-1 text-xs"
            disabled={busy}
            title={busy ? t`Add ranges once this run is done` : undefined}
            onClick={() => setAdding(true)}
          >
            <Trans>Add a range</Trans>
          </button>
        )}
      </div>
      <RangeTimeline durationSec={durationSec} ranges={drafts} onChange={setDrafts} fixed={fixed} marks={clips} readOnly={!adding} />
      {adding && (
        <>
          <RangeList durationSec={durationSec} ranges={drafts} onChange={setDrafts} />
          <p className="text-xs text-ink2" aria-live="polite">
            {n ? (
              <Trans>{formatTime(billed)} of new video counted. Clips, fixes and settings already here stay.</Trans>
            ) : (
              <Trans>Click the hatched time to add a range.</Trans>
            )}
          </p>
          {extend.error &&
            (quota ? (
              <QuotaNotice message={extend.error.message} quota={quota} placement="precheck" />
            ) : (
              <p className="text-xs text-err">{extend.error.message}</p>
            ))}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-quiet text-xs" onClick={() => (setAdding(false), setDrafts([]), extend.reset())}>
              <Trans>Cancel</Trans>
            </button>
            <button
              type="button"
              className="btn-primary text-xs"
              disabled={!n || !billed || extend.isPending || busy}
              onClick={() => extend.mutate({ id: projectId, ranges: ordered })}
            >
              <Plural value={n} one="Clip # range" other="Clip # ranges" />
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** A clip group's heading on the project page: the range's number, times and mode. */
export function RangeHeading({ index, range }: { index: number; range: ProjectRange }) {
  const n = index + 1;
  const from = formatTime(range.startSec);
  const to = formatTime(range.endSec);
  return (
    <div id={`range-${range.id}`} className="flex scroll-mt-4 items-center gap-2 pt-1 text-xs text-ink2">
      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-acc px-1.5 font-bold text-acc-ink">{n}</span>
      <span className="font-mono">
        {from}–{to}
      </span>
      <span>{range.label ?? (range.mode === "clip" ? <Trans>Exact clip</Trans> : <Trans>Find clips</Trans>)}</span>
    </div>
  );
}
