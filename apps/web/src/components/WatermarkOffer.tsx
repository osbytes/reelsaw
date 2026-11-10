import { useEffect } from "react";
import { track } from "../lib/telemetry";

/**
 * Above a project's clips when finished renders carry the watermark and the next plan takes it off: what the watermark
 * is, what removes it and what it costs. `upgrade_offer_shown` (once per project view) and `upgrade_clicked` share
 * `placement`, so the click rate of each offer can be read on its own.
 */
export function WatermarkOffer({ text, offer, projectId }: { text: string; offer: { label: string; href: string }; projectId: string }) {
  useEffect(() => {
    track("upgrade_offer_shown", { placement: "watermark", projectId });
  }, [projectId]);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] bg-warn-soft px-3 py-2.5 text-[13px]">
      <span className="min-w-0 flex-1 text-ink2">These clips carry a small “{text}” watermark. Re-render after upgrading and it’s gone.</span>
      <a
        href={offer.href}
        className="btn-primary shrink-0 py-1.5 text-xs no-underline"
        onClick={() => track("upgrade_clicked", { placement: "watermark", projectId })}
      >
        {offer.label}
      </a>
    </div>
  );
}
