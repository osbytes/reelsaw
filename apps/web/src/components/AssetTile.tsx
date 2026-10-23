/**
 * One tile for every asset the finder lists: your own upload, a shared row you saved, a catalog result, a provider result.
 * Same box for all of them (fixed thumbnail, one-line name, fixed-height rows) so nothing shifts while data arrives.
 * No in-library badge: the tile is simply there. The only control is one footer CTA ("+ Add" in the library for
 * a result that is not saved yet, "Add to clip" in the picker); the footer row keeps its height without one.
 */
import { useEffect, useRef, useState } from "react";
import { AudioLines, Film, Image as ImageIcon, Loader2, Pause, Play, Plus } from "lucide-react";
import { formatTag } from "../lib/library";
import { lengthText, type LibraryAsset } from "./BumperField";

/** What a tile draws, whatever it came from. */
export interface TileModel {
  /** unique within the finder */
  key: string;
  kind: "video" | "image" | "audio";
  name: string;
  mime?: string | null;
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
  thumbUrl?: string;
  /** what plays in place (video / audio) */
  previewUrl?: string;
  /** "Yours", "Catalog" or the provider's label */
  source: string;
  /** license id (CC0, ISC, Pexels…) for the meta line */
  license?: string;
  /** the library row behind it (own, saved shared, or the row a catalog / provider result was imported as) */
  row?: LibraryAsset;
  /** a shared row that exists on the instance but is not in this library yet (needs `library.save`) */
  unsavedShared?: boolean;
}

/** only one preview plays at a time across tiles */
let stopPrevious: (() => void) | null = null;

export function AssetTile({
  tile: t,
  pending,
  highlighted,
  leaving,
  mode,
  onAdd,
  onOpen,
  onSelect,
  onPick,
  pickLabel = "Add to clip",
}: {
  tile: TileModel;
  /** adding to the library (or picking) is in flight */
  pending: boolean;
  highlighted?: boolean;
  leaving?: boolean;
  mode: "library" | "picker";
  onAdd: () => void;
  onOpen?: () => void;
  onSelect?: () => void;
  onPick?: () => void;
  pickLabel?: string;
}) {
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
  useEffect(() => {
    const v = video.current;
    if (playing && v) void v.play().catch(() => setPlaying(false));
  }, [playing]);
  const toggle = () => {
    if (playing) return stop();
    stopPrevious?.();
    stopPrevious = () => stopRef.current();
    if (t.kind === "audio" && t.previewUrl) {
      const a = new Audio(t.previewUrl);
      a.onended = () => setPlaying(false);
      audio.current = a;
      void a.play().catch(() => setPlaying(false));
    }
    setPlaying(true);
  };
  const row = t.row;
  const inLibrary = !!row && !t.unsavedShared;
  const picker = mode === "picker";
  const fmt = formatTag(t.mime);
  const thumb = !failed && (t.thumbUrl || (t.kind === "image" ? t.previewUrl : undefined));
  const playable = t.kind !== "image" && !!t.previewUrl;
  const chip = "inline-flex items-center gap-1 rounded-full bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold leading-3 text-white";
  const size = t.kind === "image" ? (t.width && t.height ? `${t.width}×${t.height}` : "") : t.durationSec ? lengthText({ durationSec: t.durationSec }) : "";
  const meta = [t.kind, size, t.source, t.license].filter(Boolean).join(" · ");
  return (
    <li id={row ? `asset-${row.id}` : undefined} className={`flex min-w-0 flex-col gap-2 rounded-[14px] border bg-panel p-2 transition-opacity duration-150 ${leaving ? "pointer-events-none opacity-0" : ""} ${highlighted ? "border-acc ring-2 ring-acc" : "border-line"}`}>
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-[10px] border border-line bg-sunk min-[480px]:aspect-[3/4]">
        {t.kind === "video" && playing && t.previewUrl ? (
          <video ref={video} src={t.previewUrl} poster={t.thumbUrl} muted loop playsInline className="absolute inset-0 h-full w-full object-cover" />
        ) : thumb ? (
          <img src={thumb} alt="" loading="lazy" className={`absolute inset-0 h-full w-full ${t.mime === "image/svg+xml" ? "object-contain p-3" : "object-cover"}`} onError={() => setFailed(true)} />
        ) : t.kind === "audio" ? (
          <AudioLines className="absolute left-1/2 top-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 text-ink3" aria-hidden />
        ) : null}
        {picker ? (
          <button type="button" className="absolute inset-0" aria-label={`${pickLabel}: ${t.name}`} disabled={pending} onClick={onPick} />
        ) : (
          onOpen && <button type="button" className="absolute inset-0" aria-label={`View ${t.name}`} title="Details" onClick={onOpen} />
        )}
        <span className={`pointer-events-none absolute left-1.5 top-1.5 ${chip}`}>
          {t.kind === "audio" ? <AudioLines className="h-3 w-3" aria-hidden /> : t.kind === "video" ? <Film className="h-3 w-3" aria-hidden /> : <ImageIcon className="h-3 w-3" aria-hidden />}
          {fmt && <span>{fmt}</span>}
        </span>
        {playable && (
          <button type="button" onClick={toggle} aria-label={playing ? `Pause ${t.name}` : `Play ${t.name}`} aria-pressed={playing} className="absolute bottom-1.5 right-1.5 grid h-8 w-8 place-items-center rounded-full bg-white/90 text-film-ink shadow-pop hover:bg-white">
            {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" className="translate-x-px" />}
          </button>
        )}
        {t.durationSec ? <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white">{lengthText({ durationSec: t.durationSec })}</span> : null}
      </div>
      <div className="min-w-0 text-xs">
        {onSelect ? (
          <button type="button" className="block w-full truncate text-left font-semibold text-ink" onClick={onSelect} title={`${t.name} (link to this item)`}>
            {t.name}
          </button>
        ) : (
          <div className="truncate font-semibold" title={t.name}>
            {t.name}
          </div>
        )}
        <div className="h-4 truncate whitespace-nowrap text-ink3" title={meta}>
          {meta}
        </div>
      </div>
      <div className="flex h-7 items-center">
        {picker ? (
          <button type="button" className="btn-ink h-7 w-full justify-center px-2 py-1 text-xs" disabled={pending} onClick={onPick}>
            {pending ? <Loader2 size={14} className="animate-spin" /> : null}
            {pending ? "Adding…" : pickLabel}
          </button>
        ) : !inLibrary ? (
          <button type="button" className="btn-ghost h-7 w-full justify-center px-2 py-1 text-xs" disabled={pending} onClick={onAdd} aria-label={`Add ${t.name} to your library`}>
            {pending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {pending ? "Adding…" : "Add"}
          </button>
        ) : null}
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
      <div className="h-7" />
    </li>
  );
}
