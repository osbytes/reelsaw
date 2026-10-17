import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2, Upload, Undo2 } from "lucide-react";
import { useTRPC } from "../lib/trpc";
import { useToast } from "../lib/toast";
import { uploadFile } from "../lib/uploads";
import { useMe } from "../lib/account";
import { ConfirmDialog, Modal } from "./ui";

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ACCEPT = ".mp4,.mov,.webm,.png,.jpg,.jpeg,video/mp4,video/quicktime,video/webm,image/png,image/jpeg";
const isImageFile = (f: File) => f.type.startsWith("image/") || /\.(png|jpe?g)$/i.test(f.name);

export interface LibraryAsset {
  id: string;
  kind: "video" | "image";
  name: string;
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  usedBy: number;
}

/** The user's library (live assets and recently removed ones). */
export function useBumperLibrary() {
  const trpc = useTRPC();
  return useQuery(trpc.bumpers.list.queryOptions());
}

/** First frame of a video or the image itself, in a fixed 9:16 box so nothing moves when it loads. */
export function Preview({ asset, className = "" }: { asset: Pick<LibraryAsset, "id" | "kind" | "name">; className?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  return (
    <button
      type="button"
      className={`relative aspect-[9/16] overflow-hidden rounded-[10px] border border-line bg-sunk ${asset.kind === "video" ? "" : "cursor-default"} ${className}`}
      aria-label={asset.kind === "video" ? `Play ${asset.name}` : `${asset.name} (image)`}
      onClick={() => {
        const v = video.current;
        if (!v) return;
        if (v.paused) {
          v.muted = false;
          void v.play();
        } else v.pause();
      }}
    >
      {asset.kind === "video" ? (
        <video ref={video} src={`/media/bumpers/${asset.id}#t=0.1`} preload="metadata" playsInline className="h-full w-full object-cover" onEnded={(e) => (e.currentTarget.currentTime = 0.1)} />
      ) : (
        <img src={`/media/bumpers/${asset.id}`} alt="" loading="lazy" className="h-full w-full object-cover" />
      )}
    </button>
  );
}

export const lengthText = (a: Pick<LibraryAsset, "durationSec">) => `${a.durationSec.toFixed(a.durationSec % 1 ? 1 : 0)} s`;

/** Upload, default and remove/restore actions for the library, shared by the page and anything else that needs them. */
export function useBumperActions() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState("");
  const create = useMutation(trpc.bumpers.create.mutationOptions());
  const setDefaultM = useMutation(trpc.bumpers.setDefault.mutationOptions());
  const removeM = useMutation(trpc.bumpers.delete.mutationOptions());
  const restoreM = useMutation(trpc.bumpers.restore.mutationOptions());
  const busy = pct !== null || create.isPending || setDefaultM.isPending || removeM.isPending || restoreM.isPending;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: trpc.me.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.bumpers.pathKey() });
  };
  const fail = (e: unknown) => setError((e as Error).message.slice(0, 200));
  /** Checks size, uploads, adds to the library. Resolves to the new asset id (or undefined on failure). */
  const upload = async (file: File | undefined, imageSec: string) => {
    if (!file) return;
    setError("");
    const image = isImageFile(file);
    const max = image ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
    if (file.size > max) return setError(`This file is ${Math.ceil(file.size / 1024 / 1024)} MB. ${image ? "Images" : "Videos"} can be at most ${max / 1024 / 1024} MB.`);
    const seconds = Math.min(10, Math.max(1, Number(imageSec) || 3));
    try {
      setPct(0);
      const uploadId = await uploadFile(file, setPct);
      await create.mutateAsync({ uploadId, ...(image ? { imageSeconds: seconds } : {}) });
      refresh();
      toast("Added to your library");
    } catch (e) {
      fail(e);
    } finally {
      setPct(null);
    }
  };
  const setDefault = (slot: "intro" | "outro", a: LibraryAsset, current: string | undefined) => {
    setError("");
    setDefaultM.mutate({ slot, assetId: current === a.id ? null : a.id }, { onSuccess: () => (refresh(), toast(current === a.id ? `No default ${slot}` : `New projects start with this ${slot}`)), onError: fail });
  };
  const remove = (a: LibraryAsset) => removeM.mutate({ id: a.id }, { onSuccess: () => (refresh(), toast("Removed. You can restore it below.")), onError: fail });
  const restore = (a: LibraryAsset) => restoreM.mutate({ id: a.id }, { onSuccess: () => (refresh(), toast("Restored")), onError: fail });
  return { pct, error, setError, busy, upload, setDefault, remove, restore };
}

/** The "Add to library" button, image length and limits; the file input is owned by the caller so it can be opened from a link. */
export function UploadBar({ inputRef, actions, imageSec, setImageSec }: { inputRef: React.RefObject<HTMLInputElement | null>; actions: ReturnType<typeof useBumperActions>; imageSec: string; setImageSec: (s: string) => void }) {
  const { pct, busy } = actions;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          void actions.upload(f, imageSec);
        }}
        aria-label="Choose an intro or outro file"
      />
      <button type="button" className="btn-ink min-w-[8.5rem]" disabled={busy} onClick={() => inputRef.current?.click()}>
        {pct !== null ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        {pct !== null ? `${Math.round(pct * 100)}%` : "Add to library"}
      </button>
      <label className="flex items-center gap-1.5 text-xs text-ink2">
        Image length
        <input className="input w-16" type="number" min={1} max={10} step={0.5} value={imageSec} onChange={(e) => setImageSec(e.target.value)} aria-label="Seconds an image is shown" />s
      </label>
      <span className="text-xs text-ink3">MP4, MOV or WebM up to 10 s and 50 MB, or PNG or JPG up to 20 MB.</span>
    </div>
  );
}

/** One library card: preview, facts, default toggles and remove. */
export function AssetCard({ asset: a, introId, outroId, busy, highlighted, onUse, onRemove, onSelect }: { asset: LibraryAsset; introId?: string; outroId?: string; busy: boolean; highlighted: boolean; onUse: (slot: "intro" | "outro") => void; onRemove: () => void; onSelect: () => void }) {
  const isIntro = introId === a.id;
  const isOutro = outroId === a.id;
  return (
    <div id={`asset-${a.id}`} className={`flex flex-col gap-1.5 rounded-[12px] border p-2 ${highlighted ? "border-acc ring-2 ring-acc" : "border-line"}`}>
      <Preview asset={a} className="w-full" />
      <div className="flex min-h-[3.25rem] items-start gap-1 text-xs text-ink2">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect} title="Link to this item">
          <div className="truncate font-semibold text-ink" title={a.name}>
            {a.name}
          </div>
          <div className="font-mono text-ink3">
            {a.kind} · {lengthText(a)} · {a.width}×{a.height}
            {a.kind === "video" && !a.hasAudio ? " · silent" : ""}
          </div>
          <div className="text-ink3">{a.usedBy ? `Used by ${a.usedBy} project${a.usedBy === 1 ? "" : "s"}` : "Not used yet"}</div>
        </button>
        <button type="button" className="btn-quiet shrink-0 px-1.5 py-1" disabled={busy} aria-label={`Remove ${a.name}`} title="Remove" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-h-5 flex-wrap gap-x-2 text-[11px] font-semibold text-acc-text">
        {isIntro && <span>● Default intro</span>}
        {isOutro && <span>● Default outro</span>}
      </div>
      <div className="grid grid-cols-2 gap-1">
        <button type="button" className="btn-ghost justify-center px-1 py-1 text-xs" disabled={busy} aria-pressed={isIntro} onClick={() => onUse("intro")}>
          {isIntro ? "Not intro" : "Use as intro"}
        </button>
        <button type="button" className="btn-ghost justify-center px-1 py-1 text-xs" disabled={busy} aria-pressed={isOutro} onClick={() => onUse("outro")}>
          {isOutro ? "Not outro" : "Use as outro"}
        </button>
      </div>
    </div>
  );
}

/** Removed assets with a Restore button each. */
export function RemovedList({ deleted, busy, onRestore }: { deleted: LibraryAsset[]; busy: boolean; onRestore: (a: LibraryAsset) => void }) {
  if (!deleted.length) return null;
  return (
    <details className="text-xs text-ink2">
      <summary className="cursor-pointer select-none font-semibold">Recently removed ({deleted.length})</summary>
      <ul className="mt-2 flex flex-col gap-1.5">
        {deleted.map((a) => (
          <li key={a.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">
              {a.name} <span className="font-mono text-ink3">· {a.kind} · {lengthText(a)}</span>
            </span>
            <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy} aria-label={`Restore ${a.name}`} onClick={() => onRestore(a)}>
              <Undo2 className="h-3.5 w-3.5" /> Restore
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Confirm before removing an asset that is still in use (or always, from the palette). */
export function RemoveDialog({ asset, onClose, onConfirm }: { asset: LibraryAsset | null; onClose: () => void; onConfirm: (a: LibraryAsset) => void }) {
  return (
    <ConfirmDialog
      open={!!asset}
      onOpenChange={(o) => !o && onClose()}
      title="Remove from your library?"
      body={asset ? (asset.usedBy ? `“${asset.name}” is used by ${asset.usedBy} project${asset.usedBy === 1 ? "" : "s"}. Those projects keep rendering with it; you just can’t pick it for new ones. You can restore it for 30 days.` : `“${asset.name}” will be removed. You can restore it for 30 days.`) : ""}
      confirm="Remove"
      danger
      onConfirm={() => asset && onConfirm(asset)}
    />
  );
}

type Choice = string; // "default" | "none" | library asset id

/**
 * This project's intro and outro: Default (what your Settings say now), None, or a specific one from the
 * library. Saving asks whether to re-render the clips, like other project-wide changes.
 */
export function ProjectBumpersModal({ open, onOpenChange, projectId, clipCount, introId, outroId }: { open: boolean; onOpenChange: (o: boolean) => void; projectId: string; clipCount: number; introId: string | null | undefined; outroId: string | null | undefined }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const library = useBumperLibrary();
  const defaults = useMe().data?.projectDefaults;
  const save = useMutation(trpc.projects.setBumpers.mutationOptions());
  const assets = library.data?.assets ?? [];
  const known = (id: string | null | undefined, slotDefault: string | undefined): Choice => (id === null ? "none" : id ? (id === slotDefault ? "default" : id) : slotDefault ? "none" : "default");
  const initial = { intro: known(introId, defaults?.introAssetId), outro: known(outroId, defaults?.outroAssetId) };
  const [pick, setPick] = useState<{ intro?: Choice; outro?: Choice }>({});
  const intro = pick.intro ?? initial.intro;
  const outro = pick.outro ?? initial.outro;
  const dirty = intro !== initial.intro || outro !== initial.outro;
  const name = (id: string | undefined) => (id ? (assets.find((a) => a.id === id)?.name ?? "removed") : "none");
  const options = (slotDefault: string | undefined, current: string | null | undefined) => (
    <>
      <option value="default">{`Default (${name(slotDefault)})`}</option>
      <option value="none">None</option>
      {assets.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} · {lengthText(a)}
        </option>
      ))}
      {current && !assets.some((a) => a.id === current) && current !== slotDefault && <option value={current}>Removed asset (still used here)</option>}
    </>
  );
  const apply = (rerender: boolean) =>
    save.mutate(
      { id: projectId, intro, outro, rerender },
      {
        onSuccess: (r) => {
          void qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: projectId }) });
          void qc.invalidateQueries({ queryKey: trpc.bumpers.pathKey() });
          toast(r.rerendered ? `Saved · re-rendering ${r.rerendered} clip${r.rerendered === 1 ? "" : "s"}` : "Saved");
          setPick({});
          onOpenChange(false);
        },
        onError: (e) => toast(e.message),
      },
    );
  return (
    <Modal open={open} onOpenChange={(o) => (setPick({}), onOpenChange(o))} title="Intro and outro for this project" width={460}>
      <label className="flex flex-col gap-1 text-xs text-ink2">
        Intro
        <select className="input" value={intro} onChange={(e) => setPick((p) => ({ ...p, intro: e.target.value }))}>
          {options(defaults?.introAssetId, introId)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink2">
        Outro
        <select className="input" value={outro} onChange={(e) => setPick((p) => ({ ...p, outro: e.target.value }))}>
          {options(defaults?.outroAssetId, outroId)}
        </select>
      </label>
      <p className="min-h-8 text-xs text-ink3">{dirty ? `Re-render ${clipCount} clip${clipCount === 1 ? "" : "s"} now, or save and re-render later.` : "Manage the library on the Library page."}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <button className="btn-ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
        <button className="btn-ghost" disabled={!dirty || save.isPending} onClick={() => apply(false)}>
          Save
        </button>
        <button className="btn-ink min-w-[10rem]" disabled={!dirty || save.isPending} onClick={() => apply(true)}>
          {save.isPending ? "Saving…" : `Save & re-render ${clipCount}`}
        </button>
      </div>
    </Modal>
  );
}
