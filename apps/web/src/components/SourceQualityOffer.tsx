import { useEffect } from "react";
import { upgradeFromProject } from "@reelsaw/shared";
import { track } from "../lib/telemetry";
import { Trans, useLingui } from "@lingui/react/macro";

/**
 * On a video shown from its small preview (a plan's source cap): what it is, and the plan that downloads links at full
 * quality. `overlay` sits on the player (project page); `chip` fits the editor's canvas header. `upgrade_offer_shown`
 * and `upgrade_clicked` share `placement` with the other offers, so each one's click rate reads on its own.
 */
export function SourceQualityOffer({
  height,
  offer,
  projectId,
  variant,
}: {
  height: number;
  offer?: { label: string; href: string } | undefined;
  projectId: string;
  variant: "overlay" | "chip";
}) {
  const { t } = useLingui();
  const placement = variant === "overlay" ? "source_preview" : "editor_source_preview";
  // keyed on primitives: `me` refetches hand back a new offer object, which is not a new impression
  const shown = !!offer;
  useEffect(() => {
    if (shown) track("upgrade_offer_shown", { placement, projectId });
  }, [shown, placement, projectId]);
  const what = t`A ${height}p preview, for editing. Your clips still render in full quality.`;
  const click = () => track("upgrade_clicked", { placement, projectId });
  if (variant === "chip")
    return (
      <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 text-xs text-ink" title={what}>
        <span className="font-mono text-ink3">
          <Trans>{height}p preview</Trans>
        </span>
        {offer && (
          <a href={upgradeFromProject(offer.href, projectId)} className="font-semibold text-acc-text no-underline" title={offer.label} onClick={click}>
            <Trans>Upgrade for HD</Trans>
          </a>
        )}
      </span>
    );
  return (
    <div className="pointer-events-none absolute inset-x-1.5 top-1.5 z-10 flex items-start justify-between gap-2">
      <span className="rounded-[6px] bg-black/65 px-1.5 py-0.5 font-mono text-[10px] text-white" title={what}>
        <Trans>{height}p preview · clips in HD</Trans>
      </span>
      {offer && (
        <a
          href={upgradeFromProject(offer.href, projectId)}
          className="btn-primary pointer-events-auto px-2 py-0.5 text-[11px] no-underline shadow-pop"
          title={offer.label}
          onClick={click}
        >
          <Trans>Upgrade for HD</Trans>
        </a>
      )}
    </div>
  );
}
