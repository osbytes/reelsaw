import { useEffect, useSyncExternalStore } from "react";
import { upgradeFromProject } from "@reelsaw/shared";
import { useMe } from "../lib/account";
import { track } from "../lib/telemetry";
import { Modal } from "./ui";

/**
 * Downloading a finished clip. When the clip carries the watermark and a plan takes it off, the download asks first:
 * the moment someone downloads is when the watermark matters to them. The link carries the clip's project
 * (`upgradeFromProject`), and an upgrade re-renders that project's clips without it by itself (the server's
 * `rerenderWithoutWatermark` handler); the welcome dialog after checkout offers the account's other projects.
 * Every Download goes through `downloadClip` (the clip card's button, the ⌘K palette's action), and one
 * `DownloadOfferHost` (mounted in App) asks; `upgrade_offer_shown` / `upgrade_clicked` carry the placement it came from.
 */
type DownloadClip = { id: string; videoUrl: string; watermark?: boolean | undefined };
type Ask = { clip: DownloadClip; projectId: string; placement: string };

let asking: Ask | null = null;
const listeners = new Set<() => void>();
const setAsking = (a: Ask | null) => {
  asking = a;
  for (const l of listeners) l();
};

const hrefOf = (clip: DownloadClip) => `${clip.videoUrl}?download`;

function save(href: string) {
  const a = Object.assign(document.createElement("a"), { href, download: "" });
  document.body.append(a);
  a.click();
  a.remove();
}

/** Download `clip`, asking about the watermark first when it has one and a plan removes it (the host decides). */
export function downloadClip(clip: DownloadClip, projectId: string, placement: string) {
  if (clip.watermark && listeners.size) setAsking({ clip, projectId, placement });
  else save(hrefOf(clip));
}

/** The one watermark ask for every Download. Without an offer (a plan that keeps it, or none to move to) it just downloads. */
export function DownloadOfferHost() {
  const ask = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => asking,
  );
  const me = useMe();
  const offer = me.data?.watermark?.upgrade;
  const loaded = !!me.data;
  const hasOffer = !!offer;
  // keyed on the ask and primitives: a new Download is a new impression, a `me` refetch (a new object) is not
  useEffect(() => {
    if (!ask || !loaded) return;
    if (hasOffer) track("upgrade_offer_shown", { placement: ask.placement, projectId: ask.projectId, clipId: ask.clip.id });
    else {
      setAsking(null);
      save(hrefOf(ask.clip));
    }
  }, [ask, loaded, hasOffer]);
  if (!ask || !offer) return null;
  const props = { placement: ask.placement, projectId: ask.projectId, clipId: ask.clip.id };
  return (
    <Modal open onOpenChange={(o) => !o && setAsking(null)} title="Download without the watermark?">
      <p className="text-[13px] leading-snug text-ink2">
        This clip carries a small {me.data?.watermark?.text ? `“${me.data.watermark.text}” ` : ""}watermark. Upgrade and Reelsaw renders this project's clips
        again without it, by itself; you choose which other projects to clean up after checkout.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <a className="btn-ghost py-1.5 text-xs no-underline" href={hrefOf(ask.clip)} download="" onClick={() => setAsking(null)}>
          Download with watermark
        </a>
        <a
          className="btn-primary py-1.5 text-xs no-underline"
          href={upgradeFromProject(offer.href, ask.projectId)}
          onClick={() => track("upgrade_clicked", props)}
        >
          {offer.label}
        </a>
      </div>
    </Modal>
  );
}

/** A finished clip's Download: the plain link, or (watermarked) a button that asks first. */
export function DownloadClipButton({ clip, projectId, className }: { clip: DownloadClip; projectId: string; className: string }) {
  const me = useMe();
  if (!(clip.watermark && me.data?.watermark?.upgrade))
    return (
      <a className={className} href={hrefOf(clip)}>
        Download
      </a>
    );
  return (
    <button type="button" className={className} onClick={() => downloadClip(clip, projectId, "download")}>
      Download
    </button>
  );
}
