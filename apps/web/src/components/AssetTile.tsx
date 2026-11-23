/**
 * One tile for every asset the finder lists: your own upload, a catalog result, a provider result.
 * Same box for all of them (fixed thumbnail, one-line name, fixed-height rows) so nothing shifts while data arrives.
 * No in-library badge: the tile is simply there. In the picker the CTA is "Add to clip" on the thumbnail corner,
 * shown on hover / focus on desktop and always on touch. The library page has no add control: catalog and
 * provider results are browsed here and imported when a clip uses them.
 */
import { useEffect, useRef, useState } from "react";
import { AudioLines, Film, Image as ImageIcon, Loader2, Pause, Play, Plus } from "lucide-react";
import { isStickerAsset } from "@reelsaw/shared";
import { formatTag } from "../lib/library";
import { lengthText, type LibraryAsset } from "./BumperField";
import { Trans, useLingui } from "@lingui/react/macro";

/** What a tile draws, whatever it came from. */
export interface TileModel {
  /** unique within the finder */
  key: string;
  kind: "video" | "image" | "audio";
  name: string;
  mime?: string | null | undefined;
  durationSec?: number | null | undefined;
  width?: number | null | undefined;
  height?: number | null | undefined;
  hasAudio?: boolean | undefined;
  thumbUrl?: string | undefined;
  /** what plays in place (video / audio) */
  previewUrl?: string | undefined;
  /** "Yours", "Catalog" or the provider's label */
  source: string;
  /** license id (CC0, ISC, Pexels…) for the meta line */
  license?: string | undefined;
  /** the library row behind it (one of this account's uploads) */
  row?: LibraryAsset;
  /** "2 clips" / "1 project" for a library item that is in use */
  usage?: string | undefined;
}

/** only one preview plays at a time across tiles */
let stopPrevious: (() => void) | null = null;

export function AssetTile({
  tile,
  pending,
  highlighted,
  leaving,
  mode,
  onOpen,
  onSelect,
  onPick,
  pickLabel: pickLabelProp,
}: {
  tile: TileModel;
  /** picking (importing a catalog / provider result, then adding the layer) is in flight */
  pending: boolean;
  highlighted?: boolean;
  leaving?: boolean;
  mode: "library" | "picker";
  onOpen?: (() => void) | undefined;
  onSelect?: (() => void) | undefined;
  onPick?: () => void;
  pickLabel?: string | undefined;
}) {
  const { t } = useLingui();
  const pickLabel = pickLabelProp ?? t`Add to clip`;
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stop = () => {
    audio.current?.pause();
    audio.current = null;
    setPlaying(false);
  };
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(
    () => () => {
      audio.current?.pause();
    },
    [],
  );
  const toggle = () => {
    if (playing) return stop();
    stopPrevious?.();
    stopPrevious = () => stopRef.current();
    if (tile.kind === "audio" && tile.previewUrl) {
      const a = new Audio();
      if (/^https?:\/\//i.test(tile.previewUrl)) a.setAttribute("referrerpolicy", "no-referrer");
      a.src = tile.previewUrl;
      a.onended = () => setPlaying(false);
      audio.current = a;
      void a.play().catch(() => setPlaying(false));
    }
    setPlaying(true);
  };
  const row = tile.row;
  const picker = mode === "picker";
  const fmt = formatTag(tile.mime);
  const remote = (url?: string) => !!url && /^https?:\/\//i.test(url);
  // CDNs (Giphy, Pexels, …) often refuse a localhost Referer; same-origin /media needs the cookie, not this.
  const referrerPolicy = remote(tile.previewUrl) || remote(tile.thumbUrl) ? ("no-referrer" as const) : undefined;
  const gifLike = (url?: string) => !!url && /\.gif(\?|#|$)/i.test(url);
  // a GIF URL is not a <video> source (Giphy/Klipy used to send one); draw it as an img so it still loops
  const previewIsImage = tile.kind === "image" || !!tile.mime?.startsWith("image/") || gifLike(tile.previewUrl);
  const thumb = failed
    ? undefined
    : (gifLike(tile.previewUrl) ? tile.previewUrl : undefined) || tile.thumbUrl || (tile.kind === "image" ? tile.previewUrl : undefined);
  const idleAnimates = gifLike(thumb);
  // imported GIF-as-mp4 loops in the tile like a GIF; remote results already have an animated gif thumb (don't fetch every mp4)
  const stickerVideo = tile.kind === "video" && !!tile.previewUrl && !previewIsImage && !idleAnimates && isStickerAsset(tile);
  const showVideo = (playing || stickerVideo) && tile.kind === "video" && !!tile.previewUrl && !previewIsImage;
  const playable = tile.kind !== "image" && !!tile.previewUrl && !previewIsImage && !idleAnimates && !stickerVideo;
  useEffect(() => {
    const v = video.current;
    if ((playing || stickerVideo) && v)
      void v.play().catch(() => {
        if (playing) setPlaying(false);
      });
  }, [playing, stickerVideo]);
  const chip = "inline-flex items-center gap-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold leading-3 text-white";
  // an image's stored duration is only how long it shows as an intro / outro, never a media length
  const size =
    tile.kind === "image"
      ? tile.width && tile.height
        ? `${tile.width}×${tile.height}`
        : ""
      : tile.durationSec
        ? lengthText({ durationSec: tile.durationSec })
        : "";
  const showAdd = picker;
  const addLabel = t`${pickLabel}: ${tile.name}`;
  const kindWord = tile.kind === "audio" ? t`audio` : tile.kind === "video" ? t`video` : t`image`;
  const meta = [kindWord, size, tile.source, tile.license].filter(Boolean).join(" · ");
  return (
    <li
      id={row ? `asset-${row.id}` : undefined}
      className={`group flex min-w-0 flex-col gap-2 rounded-[14px] border bg-panel p-2 transition-opacity duration-150 ${leaving ? "pointer-events-none opacity-0" : ""} ${highlighted ? "border-acc ring-2 ring-acc" : "border-line"}`}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-[10px] border border-line bg-sunk min-[480px]:aspect-[3/4]">
        {showVideo ? (
          <video
            ref={(el) => {
              video.current = el;
              if (el && referrerPolicy) el.setAttribute("referrerpolicy", referrerPolicy);
            }}
            src={tile.previewUrl}
            poster={tile.thumbUrl}
            muted
            loop
            autoPlay={stickerVideo}
            playsInline
            className="absolute inset-0 h-full w-full object-contain"
          />
        ) : thumb ? (
          <img
            src={thumb}
            alt=""
            loading="lazy"
            referrerPolicy={referrerPolicy}
            className={`absolute inset-0 h-full w-full ${tile.mime === "image/svg+xml" || idleAnimates ? "object-contain p-1" : "object-cover"}`}
            onError={() => setFailed(true)}
          />
        ) : tile.kind === "audio" ? (
          <AudioLines className="absolute start-1/2 top-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 text-ink3" aria-hidden />
        ) : null}
        {picker ? (
          <button type="button" className="absolute inset-0" aria-label={addLabel} disabled={pending} onClick={onPick} />
        ) : (
          onOpen && <button type="button" className="absolute inset-0" aria-label={t`View ${tile.name}`} title={t`Details`} onClick={onOpen} />
        )}
        <span className={`pointer-events-none absolute start-1.5 top-1.5 ${chip}`}>
          {tile.kind === "audio" ? (
            <AudioLines className="h-3 w-3" aria-hidden />
          ) : tile.kind === "video" ? (
            <Film className="h-3 w-3" aria-hidden />
          ) : (
            <ImageIcon className="h-3 w-3" aria-hidden />
          )}
          {fmt && <span>{fmt}</span>}
        </span>
        {playable && (
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? t`Pause ${tile.name}` : t`Play ${tile.name}`}
            aria-pressed={playing}
            className="absolute bottom-1.5 end-1.5 z-[1] grid h-8 w-8 place-items-center rounded-full bg-white/90 text-film-ink shadow-pop hover:bg-white"
          >
            {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" className="translate-x-px" />}
          </button>
        )}
        {tile.usage ? (
          <span className={`pointer-events-none absolute bottom-1.5 start-1.5 ${chip}`}>{tile.usage}</span>
        ) : tile.kind !== "image" && tile.durationSec ? (
          <span className="pointer-events-none absolute bottom-1.5 start-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white">
            {lengthText({ durationSec: tile.durationSec })}
          </span>
        ) : null}
        {showAdd && (
          <button
            type="button"
            disabled={pending}
            onClick={onPick}
            aria-label={pending ? t`Adding…` : addLabel}
            title={pickLabel}
            className="absolute end-1.5 top-1.5 z-[1] inline-flex h-7 items-center gap-1 rounded-full bg-white/90 px-2 text-xs font-semibold text-film-ink opacity-0 shadow-pop transition-opacity duration-150 hover:bg-white focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 touch:opacity-100 disabled:opacity-100"
          >
            {pending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Plus size={14} aria-hidden />}
            {picker && !pending && (
              <span>
                <Trans>Add</Trans>
              </span>
            )}
          </button>
        )}
      </div>
      <div className="min-w-0 text-xs">
        {onSelect ? (
          <button
            type="button"
            className="block w-full truncate text-start font-semibold text-ink"
            onClick={onSelect}
            title={t`${tile.name} (link to this item)`}
          >
            {tile.name}
          </button>
        ) : (
          <div className="truncate font-semibold" title={tile.name}>
            {tile.name}
          </div>
        )}
        <div className="h-4 truncate whitespace-nowrap text-ink3" title={meta}>
          {meta}
        </div>
      </div>
    </li>
  );
}

export function AssetTileSkeleton({ i = 0, liRef }: { i?: number; liRef?: React.Ref<HTMLLIElement> }) {
  return (
    <li ref={liRef} className="flex min-w-0 flex-col gap-2 rounded-[14px] border border-line bg-panel p-2" aria-hidden>
      <div className="aspect-[4/3] w-full animate-pulse rounded-[10px] bg-sunk min-[480px]:aspect-[3/4]" />
      <div className={`h-3 animate-pulse rounded bg-sunk ${["w-3/4", "w-1/2", "w-2/3"][i % 3]}`} />
      <div className="h-4" />
    </li>
  );
}
