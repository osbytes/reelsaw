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
function Preview({ asset, className = "" }: { asset: Pick<LibraryAsset, "id" | "kind" | "name">; className?: string }) {
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

const lengthText = (a: Pick<LibraryAsset, "durationSec">) => `${a.durationSec.toFixed(a.durationSec % 1 ? 1 : 0)} s`;

/** Settings → Intro and outro: your library; pick which one new projects start with. */
export function BumpersSection({ introId, outroId }: { introId?: string; outroId?: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [imageSec, setImageSec] = useState("3");
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<LibraryAsset | null>(null);
  const list = useBumperLibrary();
  const create = useMutation(trpc.bumpers.create.mutationOptions());
  const setDefault = useMutation(trpc.bumpers.setDefault.mutationOptions());
  const remove = useMutation(trpc.bumpers.delete.mutationOptions());
  const restore = useMutation(trpc.bumpers.restore.mutationOptions());
  const busy = pct !== null || create.isPending || setDefault.isPending || remove.isPending || restore.isPending;
  const assets = list.data?.assets ?? [];
  const deleted = list.data?.deleted ?? [];

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: trpc.me.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.bumpers.pathKey() });
  };
  const fail = (e: unknown) => setError((e as Error).message.slice(0, 200));
  const pick = async (file: File | undefined) => {
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
      if (input.current) input.current.value = "";
    }
  };
  const use = (slot: "intro" | "outro", a: LibraryAsset) => {
    const current = slot === "intro" ? introId : outroId;
    setError("");
    setDefault.mutate({ slot, assetId: current === a.id ? null : a.id }, { onSuccess: () => (refresh(), toast(current === a.id ? `No default ${slot}` : `New projects start with this ${slot}`)), onError: fail });
  };
  const doRemove = (a: LibraryAsset) => remove.mutate({ id: a.id }, { onSuccess: () => (refresh(), toast("Removed. You can restore it below.")), onError: fail });

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <div>
        <h3 className="text-[13px] font-bold">Intro and outro</h3>
        <p className="mt-1 text-[13px] text-ink2">Short videos or images of yours, added to the start and end of every clip. Pick a default intro and outro for new projects; each project can change or drop them later.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept={ACCEPT} className="hidden" onChange={(e) => void pick(e.target.files?.[0])} aria-label="Choose an intro or outro file" />
        <button type="button" className="btn-ghost min-w-[8.5rem]" disabled={busy} onClick={() => input.current?.click()}>
          {pct !== null ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {pct !== null ? `${Math.round(pct * 100)}%` : "Add to library"}
        </button>
        <label className="flex items-center gap-1.5 text-xs text-ink2">
          Image length
          <input className="input w-16" type="number" min={1} max={10} step={0.5} value={imageSec} onChange={(e) => setImageSec(e.target.value)} aria-label="Seconds an image is shown" />s
        </label>
        <span className="text-xs text-ink3">MP4, MOV or WebM up to 10 s and 50 MB, or PNG or JPG up to 20 MB.</span>
      </div>
      <div className="min-h-4 text-xs text-err" role="status">
        {error}
      </div>
      {/* the grid keeps its height while loading or empty */}
      <div className="grid min-h-[230px] grid-cols-2 content-start gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {assets.length === 0 && <p className="col-span-full text-xs text-ink3">{list.isLoading ? "Loading…" : "Nothing here yet. Add a video or an image above."}</p>}
        {assets.map((a) => {
          const isIntro = introId === a.id;
          const isOutro = outroId === a.id;
          return (
            <div key={a.id} className="flex flex-col gap-1.5 rounded-[12px] border border-line p-2">
              <Preview asset={a} className="w-full" />
              <div className="min-h-[3.25rem] text-xs text-ink2">
                <div className="truncate font-semibold text-ink" title={a.name}>
                  {a.name}
                </div>
                <div className="font-mono text-ink3">
                  {a.kind === "image" ? "image" : "video"} · {lengthText(a)}
                  {a.kind === "video" && !a.hasAudio ? " · silent" : ""}
                </div>
                <div className="text-ink3">{a.usedBy ? `Used by ${a.usedBy} project${a.usedBy === 1 ? "" : "s"}` : "Not used yet"}</div>
              </div>
              <div className="flex min-h-5 flex-wrap gap-1 text-[11px] font-semibold text-acc-text">
                {isIntro && <span>● Default intro</span>}
                {isOutro && <span>● Default outro</span>}
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy} aria-pressed={isIntro} onClick={() => use("intro", a)}>
                  {isIntro ? "Not intro" : "Use as intro"}
                </button>
                <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy} aria-pressed={isOutro} onClick={() => use("outro", a)}>
                  {isOutro ? "Not outro" : "Use as outro"}
                </button>
                <button type="button" className="btn-quiet ml-auto px-2 py-1" disabled={busy} aria-label={`Remove ${a.name}`} title="Remove" onClick={() => (a.usedBy ? setRemoving(a) : doRemove(a))}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {deleted.length > 0 && (
        <details className="text-xs text-ink2">
          <summary className="cursor-pointer select-none font-semibold">Recently removed ({deleted.length})</summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {deleted.map((a) => (
              <li key={a.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {a.name} <span className="font-mono text-ink3">· {a.kind} · {lengthText(a)}</span>
                </span>
                <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy} aria-label={`Restore ${a.name}`} onClick={() => restore.mutate({ id: a.id }, { onSuccess: () => (refresh(), toast("Restored")), onError: fail })}>
                  <Undo2 className="h-3.5 w-3.5" /> Restore
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="Remove from your library?"
        body={removing ? `“${removing.name}” is used by ${removing.usedBy} project${removing.usedBy === 1 ? "" : "s"}. Those projects keep rendering with it; you just can’t pick it for new ones. You can restore it for 30 days.` : ""}
        confirm="Remove"
        danger
        onConfirm={() => removing && doRemove(removing)}
      />
    </div>
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
      <p className="min-h-8 text-xs text-ink3">{dirty ? `Re-render ${clipCount} clip${clipCount === 1 ? "" : "s"} now, or save and re-render later.` : "Manage the library in Settings."}</p>
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
