import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { plural, upgradeFromProject, type PartialSource } from "@reelsaw/shared";
import { useTRPC } from "../lib/trpc";
import { track } from "../lib/telemetry";
import { Pending } from "./ui";
import { QuotaNotice, quotaFromError } from "./QuotaNotice";

type Offer = { label: string; href: string };

/**
 * One quiet line above a project's clips for what a plan would change about them: only the start of the video was
 * clipped (the account's minutes covered that much) and/or the finished clips carry the watermark. One upgrade link
 * names every benefit that applies and the plan's price, so two offers never stack. "Clip the rest" shows when the
 * minutes cover more now (projects.extend, the same service as MCP extend_project). The link carries this project
 * (`upgradeFromProject`): upgrading from here finishes this video and re-renders its clips without the watermark by
 * itself, and the welcome dialog after checkout offers the other projects. `upgrade_offer_shown` / `upgrade_clicked` keep placement
 * "partial_project" (or "watermark" when that is the only reason), with `watermark` saying whether it was part of it.
 * `capacity`: clips whose render went back to the queue for the account's plan ceiling or the busy-hours reserve
 * (`clip.capacity_wait`); its offer names the next plan's cores, placement "capacity_wait" when it is the only reason.
 */
export function UpgradeNotice({
  partial,
  watermark,
  capacity = null,
  projectId,
  onExtended,
}: {
  partial: PartialSource | null;
  watermark: { text: string; upgrade: Offer } | null;
  capacity?: { waiting: number; upgrade: Offer | null } | null;
  projectId: string;
  onExtended: () => void;
}) {
  const trpc = useTRPC();
  const extend = useMutation(trpc.projects.extend.mutationOptions({ onSuccess: onExtended }));
  const m = (sec: number) => Math.round(sec / 60);
  const open = partial && !partial.extending ? partial : null;
  const remaining = open ? m(open.remainingSec) : 0;
  const more = open?.extendableSec != null ? m(open.extendableSec) : null;
  // a plan that covers the rest of the video removes the watermark too; else the watermark's own offer
  const waiting = capacity && capacity.waiting > 0 ? capacity : null;
  const upgrade = open?.upgrade ?? watermark?.upgrade ?? waiting?.upgrade ?? null;
  const benefits = [open?.upgrade && `clip the other ${remaining} min`, watermark && "remove the watermark", waiting?.upgrade && "render sooner"]
    .filter(Boolean)
    .join(" and ");
  const placement = open?.upgrade ? "partial_project" : watermark ? "watermark" : "capacity_wait";
  const props = { placement, projectId, watermark: !!watermark, capacityWait: !!waiting, ...(open ? { remainingMinutes: remaining } : {}) };
  // keyed on primitives: refetches hand back new objects, which are not a new impression
  const shown = !!upgrade;
  const marked = !!watermark;
  const isPartial = !!open;
  const isWaiting = !!waiting;
  useEffect(() => {
    if (shown)
      track("upgrade_offer_shown", { placement, projectId, watermark: marked, capacityWait: isWaiting, ...(isPartial ? { remainingMinutes: remaining } : {}) });
  }, [shown, placement, projectId, marked, isWaiting, isPartial, remaining]);
  if (!partial && !watermark && !waiting) return null;

  const facts = [
    partial?.extending
      ? partial.sentence
      : open && (open.upgrade || more !== null)
        ? `Clipped the first ${m(open.processedSec)} of ${m(open.durationSec)} min`
        : open?.sentence,
    watermark && `${watermark.text ? `“${watermark.text}” ` : ""}watermark on`,
    waiting && `${plural(waiting.waiting, "clip")} waiting for render capacity`,
  ].filter(Boolean);
  const quota = quotaFromError(extend.error);
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-line px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="min-w-0 flex-1 text-ink2">
          {facts.join(" · ")}
          {upgrade && (
            <>
              {facts.length > 0 && ". "}
              <a
                href={upgradeFromProject(upgrade.href, projectId)}
                className="font-semibold text-acc-text no-underline"
                onClick={() => track("upgrade_clicked", props)}
              >
                Upgrade to {benefits} →
              </a>{" "}
              <span className="text-ink3">{upgrade.label}</span>
            </>
          )}
        </span>
        {more !== null && (
          <button
            type="button"
            className="btn-quiet h-6 shrink-0 px-2 py-0 text-xs"
            disabled={extend.isPending}
            aria-busy={extend.isPending}
            onClick={() => {
              track("partial_extend_clicked", { projectId, minutes: more, remainingMinutes: remaining });
              extend.mutate({ id: projectId });
            }}
          >
            <Pending busy={extend.isPending}>{more >= remaining ? `Clip the remaining ${remaining} min` : `Clip ${more} more min`}</Pending>
          </button>
        )}
      </div>
      {extend.error && <QuotaNotice message={extend.error.message} quota={quota} projectId={projectId} />}
    </div>
  );
}
