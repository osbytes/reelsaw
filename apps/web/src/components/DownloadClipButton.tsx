import { useState } from "react";
import { useMe } from "../lib/account";
import { track } from "../lib/telemetry";
import { Modal } from "./ui";

/**
 * A finished clip's Download. When the clip carries the watermark and a plan takes it off, the click asks first: the
 * moment someone downloads is when the watermark matters to them. Upgrading re-renders the account's watermarked clips
 * without it by itself (the server's `rerenderWithoutWatermark` handler), so the offer can promise that. Otherwise it
 * is the plain download link. `upgrade_offer_shown` / `upgrade_clicked` with placement "download", like the other offers.
 */
export function DownloadClipButton({
  clip,
  projectId,
  className,
}: {
  clip: { id: string; videoUrl: string; watermark?: boolean | undefined };
  projectId: string;
  className: string;
}) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const href = `${clip.videoUrl}?download`;
  const offer = clip.watermark ? me.data?.watermark?.upgrade : undefined;
  if (!offer)
    return (
      <a className={className} href={href}>
        Download
      </a>
    );
  const props = { placement: "download", projectId, clipId: clip.id };
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => {
          setOpen(true);
          track("upgrade_offer_shown", props);
        }}
      >
        Download
      </button>
      <Modal open={open} onOpenChange={setOpen} title="Download without the watermark?">
        <p className="text-[13px] leading-snug text-ink2">
          This clip carries a small {me.data?.watermark?.text ? `“${me.data.watermark.text}” ` : ""}watermark. Upgrade and Reelsaw renders your clips again
          without it, by itself; download them clean when they finish.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <a className="btn-ghost py-1.5 text-xs no-underline" href={href} onClick={() => setOpen(false)}>
            Download with watermark
          </a>
          <a className="btn-primary py-1.5 text-xs no-underline" href={offer.href} onClick={() => track("upgrade_clicked", props)}>
            {offer.label}
          </a>
        </div>
      </Modal>
    </>
  );
}
