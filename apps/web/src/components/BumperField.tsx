import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Equal, Loader2, Star, Trash2, Upload, Undo2, X } from "lucide-react";
import { useTRPC } from "../lib/trpc";
import { useToast } from "../lib/toast";
import { uploadFile } from "../lib/uploads";
import { useMe } from "../lib/account";
import { ConfirmDialog, Modal } from "./ui";
import { ScrollArea } from "./scroll-area";
import { BumperCombobox, Thumb, type FixedOption } from "./BumperCombobox";
import * as Popover from "@radix-ui/react-popover";
import type { ClipBumpers } from "@reelsaw/shared";

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ACCEPT = ".mp4,.mov,.webm,.png,.jpg,.jpeg,video/mp4,video/quicktime,video/webm,image/png,image/jpeg";
const isImageFile = (f: File) => f.type.startsWith("image/") || /\.(png|jpe?g)$/i.test(f.name);
const clampSec = (n: number) => Math.min(10, Math.max(1, Math.round(n * 10) / 10));

export interface LibraryAsset {
  id: string;
  kind: "video" | "image";
  name: string;
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  usedBy: number;
  thumbnailUrl: string;
}

/** The user's library (live assets and recently removed ones). */
export function useBumperLibrary() {
  const trpc = useTRPC();
  return useQuery(trpc.bumpers.list.queryOptions());
}

/** The server-made thumbnail in a fixed 9:16 box; a video swaps to its player on click so nothing moves. */
export function Preview({ asset, className = "" }: { asset: Pick<LibraryAsset, "id" | "kind" | "name" | "thumbnailUrl">; className?: string }) {
  const [playing, setPlaying] = useState(false);
  const video = asset.kind === "video";
  return (
    <button
      type="button"
      className={`relative aspect-[9/16] overflow-hidden rounded-[10px] border border-line bg-sunk ${video ? "" : "cursor-default"} ${className}`}
      aria-label={video ? `${playing ? "Stop" : "Play"} ${asset.name}` : `${asset.name} (image)`}
      onClick={() => video && setPlaying((p) => !p)}
    >
      <img src={asset.thumbnailUrl} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
      {video && !playing && <span className="absolute bottom-1.5 right-1.5 grid h-6 w-6 place-items-center rounded-full bg-white/90 text-[9px] text-[#1c1c1e]">▶</span>}
      {playing && <video src={`/media/bumpers/${asset.id}`} autoPlay playsInline className="absolute inset-0 h-full w-full object-cover" onEnded={() => setPlaying(false)} />}
    </button>
  );
}

export const lengthText = (a: Pick<LibraryAsset, "durationSec">) => `${a.durationSec.toFixed(a.durationSec % 1 ? 1 : 0)} s`;

export interface UploadJob {
  key: string;
  name: string;
  pct: number;
  state: "queued" | "uploading" | "saving" | "done" | "failed";
  error?: string;
}

/** Upload (several at once, two at a time), default and remove/restore actions for the library. */
export function useBumperActions() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [error, setError] = useState("");
  const queue = useRef<Array<{ key: string; file: File; seconds: number }>>([]);
  const running = useRef(0);
  const finished = useRef({ ok: 0, failed: 0 });
  const create = useMutation(trpc.bumpers.create.mutationOptions());
  const setDefaultM = useMutation(trpc.bumpers.setDefault.mutationOptions());
  const removeM = useMutation(trpc.bumpers.delete.mutationOptions());
  const restoreM = useMutation(trpc.bumpers.restore.mutationOptions());
  const updateM = useMutation(trpc.bumpers.update.mutationOptions());
  const busy = setDefaultM.isPending || removeM.isPending || restoreM.isPending || updateM.isPending;
  const uploading = jobs.some((j) => j.state === "queued" || j.state === "uploading" || j.state === "saving");
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: trpc.me.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.bumpers.pathKey() });
  };
  const fail = (e: unknown) => setError((e as Error).message.slice(0, 200));
  const patch = (key: string, p: Partial<UploadJob>) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...p } : j)));

  const work = async () => {
    running.current++;
    for (let next = queue.current.shift(); next; next = queue.current.shift()) {
      const { key, file, seconds } = next;
      try {
        patch(key, { state: "uploading" });
        const uploadId = await uploadFile(file, (pct) => patch(key, { pct }));
        patch(key, { state: "saving", pct: 1 });
        await create.mutateAsync({ uploadId, ...(isImageFile(file) ? { imageSeconds: seconds } : {}) });
        patch(key, { state: "done" });
        finished.current.ok++;
        refresh();
      } catch (e) {
        patch(key, { state: "failed", error: (e as Error).message.replace(/^"|"$/g, "").slice(0, 200) });
        finished.current.failed++;
      }
    }
    if (--running.current === 0) {
      const { ok, failed } = finished.current;
      finished.current = { ok: 0, failed: 0 };
      toast(failed ? `Added ${ok} to your library · ${failed} failed` : ok === 1 ? "Added to your library" : `Added ${ok} to your library`);
    }
  };
  /** Checks sizes, then uploads and adds each file to the library, two at a time. */
  const uploadMany = (files: File[], imageSec: string) => {
    if (!files.length) return;
    setError("");
    const seconds = clampSec(Number(imageSec) || 3);
    const fresh: UploadJob[] = [];
    for (const file of files) {
      const key = `${file.name}:${file.size}:${Date.now()}:${Math.random()}`;
      const image = isImageFile(file);
      const max = image ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
      if (file.size > max) {
        fresh.push({ key, name: file.name, pct: 0, state: "failed", error: `This file is ${Math.ceil(file.size / 1024 / 1024)} MB. ${image ? "Images" : "Videos"} can be at most ${max / 1024 / 1024} MB.` });
        continue;
      }
      fresh.push({ key, name: file.name, pct: 0, state: "queued" });
      queue.current.push({ key, file, seconds });
    }
    setJobs((js) => [...js, ...fresh]);
    // each worker takes its first file synchronously, so this starts at most two and never an idle one
    while (running.current < 2 && queue.current.length > 0) void work();
  };
  const dismiss = (key?: string) => setJobs((js) => js.filter((j) => (key ? j.key !== key : j.state === "queued" || j.state === "uploading" || j.state === "saving")));

  const setDefault = (slot: "intro" | "outro", a: LibraryAsset, current: string | undefined) => {
    setError("");
    setDefaultM.mutate({ slot, assetId: current === a.id ? null : a.id }, { onSuccess: () => (refresh(), toast(current === a.id ? `No default ${slot}` : `New projects start with this ${slot}`)), onError: fail });
  };
  const remove = (a: LibraryAsset) => removeM.mutate({ id: a.id }, { onSuccess: () => (refresh(), toast("Removed. You can restore it below.")), onError: fail });
  const restore = (a: LibraryAsset) => restoreM.mutate({ id: a.id }, { onSuccess: () => (refresh(), toast("Restored")), onError: fail });
  /** Image length; resolves true when saved. */
  const setSeconds = (a: LibraryAsset, sec: number) =>
    updateM.mutateAsync({ id: a.id, imageSeconds: clampSec(sec) }).then(
      () => (refresh(), true),
      (e) => (fail(e), false),
    );
  return { jobs, uploading, error, setError, busy, uploadMany, dismiss, setDefault, remove, restore, setSeconds };
}

/** The "Add to library" button, image length and limits; the file input is owned by the caller so it can be opened from a link. */
export function UploadBar({ inputRef, actions, imageSec, setImageSec }: { inputRef: React.RefObject<HTMLInputElement | null>; actions: ReturnType<typeof useBumperActions>; imageSec: string; setImageSec: (s: string) => void }) {
  const { uploading } = actions;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          actions.uploadMany(files, imageSec);
        }}
        aria-label="Choose intro or outro files"
      />
      <button type="button" className="btn-ink min-w-[8.5rem]" onClick={() => inputRef.current?.click()}>
        {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
        {uploading ? "Uploading…" : "Add to library"}
      </button>
      <label className="flex items-center gap-1.5 text-xs text-ink2">
        Image length
        <input className="input w-16" type="number" min={1} max={10} step={0.5} value={imageSec} onChange={(e) => setImageSec(e.target.value)} aria-label="Seconds an image is shown" />s
      </label>
      <span className="text-xs text-ink3">MP4, MOV or WebM up to 10 s and 50 MB, or PNG or JPG up to 20 MB. Pick or drop several at once.</span>
    </div>
  );
}

/** Per-file progress for the current batch; rows stay until dismissed. The space is reserved so the page below does not jump. */
export function UploadJobs({ jobs, onDismiss }: { jobs: UploadJob[]; onDismiss: (key?: string) => void }) {
  const finished = jobs.filter((j) => j.state === "done" || j.state === "failed").length;
  return (
    <div className="min-h-[3.5rem]" aria-live="polite">
      {jobs.length > 0 && (
        <div className="rounded-[10px] border border-line bg-panel">
          <ScrollArea className="max-h-[9rem]">
            <ul className="flex flex-col gap-1.5 p-2 text-xs">
              {jobs.map((j) => (
                <li key={j.key} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    {j.state === "done" ? <span className="font-mono text-ok">●</span> : j.state === "failed" ? <span className="font-mono text-err">▲</span> : <Loader2 className="h-3 w-3 shrink-0 animate-spin text-acc-text" />}
                    <span className="min-w-0 flex-1 truncate">{j.name}</span>
                    <span className="shrink-0 font-mono text-ink3">{j.state === "queued" ? "waiting" : j.state === "uploading" ? `${Math.round(j.pct * 100)}%` : j.state === "saving" ? "adding" : j.state === "done" ? "added" : "failed"}</span>
                    {(j.state === "done" || j.state === "failed") && (
                      <button type="button" className="text-ink3 hover:text-ink" aria-label={`Dismiss ${j.name}`} onClick={() => onDismiss(j.key)}>
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {j.state === "uploading" && (
                    <div className="h-1 overflow-hidden rounded-full bg-sunk">
                      <div className="h-full bg-acc transition-all" style={{ width: `${j.pct * 100}%` }} />
                    </div>
                  )}
                  {j.error && <span className="text-err">{j.error}</span>}
                </li>
              ))}
            </ul>
          </ScrollArea>
          {finished > 0 && (
            <div className="border-t border-line px-2 py-1 text-right">
              <button type="button" className="text-xs font-semibold text-ink2 hover:text-ink" onClick={() => onDismiss()}>
                Dismiss finished
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Seconds field for an image; empty means the library item's own length. */
function SecField({ value, onChange, placeholder, label }: { value: number | undefined; onChange: (v: number | undefined) => void; placeholder: number; label: string }) {
  return (
    <label className="flex shrink-0 items-center gap-1 text-xs text-ink2">
      <input
        className="input h-[38px] w-[3.75rem] px-2 py-1 text-xs"
        type="number"
        min={1}
        max={10}
        step={0.5}
        value={value ?? ""}
        placeholder={String(placeholder)}
        aria-label={label}
        onChange={(e) => onChange(e.target.value === "" || !Number.isFinite(Number(e.target.value)) ? undefined : Number(e.target.value))}
        onBlur={(e) => e.target.value !== "" && onChange(clampSec(Number(e.target.value)))}
      />
      s
    </label>
  );
}

/** One labelled row: the combobox, plus a seconds field when the chosen item is an image. */
function SlotRow({
  slot,
  label,
  choice,
  sec,
  onChange,
  fixed,
  assets,
  known,
  defaultId,
  inheritedId,
  secOnInherit,
}: {
  slot: "intro" | "outro";
  label: string;
  choice: string;
  sec: number | undefined;
  onChange: (choice: string, sec: number | undefined) => void;
  fixed: FixedOption[];
  assets: LibraryAsset[];
  known: LibraryAsset[];
  defaultId?: string | null;
  /** the asset a "follow the project / default" choice ends up using */
  inheritedId?: string | null;
  /** seconds may be set even when the choice is "default" (the project modal) */
  secOnInherit?: boolean;
}) {
  const effective = fixed.some((f) => f.value === choice) ? (secOnInherit && (choice === "default" || choice === "inherit") ? inheritedId : null) : choice;
  const image = effective ? known.find((a) => a.id === effective && a.kind === "image") : undefined;
  return (
    <>
      <span className="text-xs text-ink2">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        <BumperCombobox className="min-w-0 flex-1" slot={slot} label={`${label} choice`} value={choice} onChange={(c) => onChange(c, undefined)} fixed={fixed} assets={assets} known={known} defaultId={defaultId} />
        {image && <SecField value={sec} onChange={(v) => onChange(choice, v)} placeholder={image.durationSec} label={`Seconds the ${slot} is shown`} />}
      </div>
    </>
  );
}

/** One library card: preview, facts, image length, default toggles and remove. */
export function AssetCard({ asset: a, introId, outroId, busy, highlighted, applied, onUse, onRemove, onSelect, onSeconds }: { asset: LibraryAsset; introId?: string; outroId?: string; busy: boolean; highlighted: boolean; applied: boolean; onUse: (slot: "intro" | "outro") => void; onRemove: () => void; onSelect: () => void; onSeconds: (sec: number) => void }) {
  const isIntro = introId === a.id;
  const isOutro = outroId === a.id;
  const [secs, setSecs] = useState<string | null>(null);
  const shown = secs ?? String(a.durationSec);
  const commit = () => {
    const n = Number(secs);
    setSecs(null);
    if (secs !== null && Number.isFinite(n) && secs !== "" && clampSec(n) !== a.durationSec) onSeconds(n);
  };
  return (
    <div id={`asset-${a.id}`} className={`flex flex-col gap-1.5 rounded-[12px] border p-2 ${highlighted ? "border-acc ring-2 ring-acc" : "border-line"}`}>
      <Preview asset={a} className="w-full" />
      <div className="flex min-h-[3.25rem] items-start gap-1 text-xs text-ink2">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect} title="Link to this item">
          <div className="truncate font-semibold text-ink" title={a.name}>
            {a.name}
          </div>
          <div className="font-mono text-ink3">
            {a.kind} · {a.kind === "video" ? `${lengthText(a)} · ` : ""}
            {a.width}×{a.height}
            {a.kind === "video" && !a.hasAudio ? " · silent" : ""}
          </div>
          <div className="text-ink3">{a.usedBy ? `Used by ${a.usedBy} project${a.usedBy === 1 ? "" : "s"}${applied ? ", re-render to apply" : ""}` : applied ? "Saved" : "Not used yet"}</div>
        </button>
        <button type="button" className="btn-quiet shrink-0 px-1.5 py-1" disabled={busy} aria-label={`Remove ${a.name}`} title="Remove" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      {/* the length row is on every card so image and video cards stay the same height */}
      <div className="flex h-7 items-center gap-1.5 text-xs text-ink2">
        {a.kind === "image" ? (
          <>
            Shown for
            <input
              className="input h-7 w-14 px-1.5 py-0 text-xs"
              type="number"
              min={1}
              max={10}
              step={0.5}
              value={shown}
              disabled={busy}
              aria-label={`Seconds ${a.name} is shown`}
              onChange={(e) => setSecs(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            s
          </>
        ) : (
          <span className="text-ink3">Plays its own length</span>
        )}
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
            <Thumb asset={a} className="h-7 w-4" />
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

/** A per-clip slot choice: "inherit" (follow the project), "none", "keep" (bulk: leave alone), or a library asset id. */
export type SlotChoice = string;
export interface SlotChoices {
  intro: SlotChoice;
  outro: SlotChoice;
  /** seconds for an image picked in that slot (overrides the library item's length) */
  introSec?: number;
  outroSec?: number;
}
const toChoice = (v: string | null | undefined): SlotChoice => (v === undefined ? "inherit" : v === null ? "none" : v);
export const choicesFrom = (b: ClipBumpers | null | undefined): SlotChoices => ({ intro: toChoice(b?.intro), outro: toChoice(b?.outro), ...(b?.introSec ? { introSec: b.introSec } : {}), ...(b?.outroSec ? { outroSec: b.outroSec } : {}) });
const isAssetChoice = (c: SlotChoice) => c !== "inherit" && c !== "none" && c !== "keep" && c !== "default";
/** The value stored on the clip: slots that inherit are left out, seconds only travel with a picked asset. */
export const clipBumpersFrom = (c: SlotChoices): ClipBumpers => ({
  ...(c.intro !== "inherit" ? { intro: c.intro === "none" ? null : c.intro } : {}),
  ...(isAssetChoice(c.intro) && c.introSec ? { introSec: clampSec(c.introSec) } : {}),
  ...(c.outro !== "inherit" ? { outro: c.outro === "none" ? null : c.outro } : {}),
  ...(isAssetChoice(c.outro) && c.outroSec ? { outroSec: clampSec(c.outroSec) } : {}),
});
/** The asset a slot ends up using on a clip: its own choice, else the project's. */
export const effectiveAsset = (own: string | null | undefined, project: string | null | undefined) => (own === undefined ? project || null : own);
/** Seconds a slot lasts on a clip: its own, else the project's, else the asset's own length. */
export const effectiveSeconds = (clipSec: number | undefined, ownChoice: string | null | undefined, projectSec: number | undefined, assetSec: number | undefined) => (ownChoice !== undefined && ownChoice !== null ? (clipSec ?? assetSec) : (projectSec ?? assetSec));

/** Intro and Outro rows for one clip or a selection of clips: Project default (name) / None / each library asset. */
export function BumperSelects({ value, onChange, projectIntroId, projectOutroId, className = "", keep = false }: { value: SlotChoices; onChange: (v: SlotChoices) => void; projectIntroId?: string | null; projectOutroId?: string | null; className?: string; keep?: boolean }) {
  const library = useBumperLibrary();
  const defaults = useMe().data?.projectDefaults;
  const assets = library.data?.assets ?? [];
  const known = [...assets, ...(library.data?.deleted ?? [])];
  const name = (id: string | null | undefined) => (id ? (known.find((a) => a.id === id)?.name ?? "removed") : "none");
  const fixed = (projectId: string | null | undefined): FixedOption[] => [
    ...(keep ? [{ value: "keep", label: "Leave as it is", hint: "Don’t change this slot", icon: <Equal className="h-4 w-4" /> }] : []),
    { value: "inherit", label: `Project default (${name(projectId)})`, hint: "Follow the project", icon: <Star className="h-4 w-4" /> },
    { value: "none", label: "None", hint: "Nothing here", icon: <Ban className="h-4 w-4" /> },
  ];
  const row = (slot: "intro" | "outro", label: string, projectId: string | null | undefined, defaultId: string | undefined) => (
    <SlotRow
      slot={slot}
      label={label}
      choice={value[slot]}
      sec={value[`${slot}Sec`]}
      onChange={(c, s) => onChange({ ...value, [slot]: c, [`${slot}Sec`]: s })}
      fixed={fixed(projectId)}
      assets={assets}
      known={known}
      defaultId={defaultId}
    />
  );
  return (
    <div className={`grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 ${className}`}>
      {row("intro", "Intro", projectIntroId, defaults?.introAssetId)}
      {row("outro", "Outro", projectOutroId, defaults?.outroAssetId)}
    </div>
  );
}

/** "Intro / outro…" on a clip card: this clip's own choice without opening the editor. */
export function ClipBumpersPopover({ clipId, projectId, bumpers, rendered, projectIntroId, projectOutroId, className }: { clipId: string; projectId: string; bumpers: ClipBumpers | null | undefined; rendered: boolean; projectIntroId?: string | null; projectOutroId?: string | null; className: string }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<SlotChoices>(choicesFrom(bumpers));
  const update = useMutation(trpc.clips.update.mutationOptions());
  const dirty = JSON.stringify(clipBumpersFrom(v)) !== JSON.stringify(clipBumpersFrom(choicesFrom(bumpers)));
  const save = (rerender: boolean) =>
    update.mutate(
      { id: clipId, bumpers: clipBumpersFrom(v), rerender },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: projectId }) });
          toast(rerender ? "Saved · re-rendering this clip" : "Saved for this clip");
          setOpen(false);
        },
        onError: (e) => toast(e.message),
      },
    );
  return (
    <Popover.Root open={open} onOpenChange={(o) => (o && setV(choicesFrom(bumpers)), setOpen(o))}>
      <Popover.Trigger asChild>
        <button className={className} title="Choose an intro and outro for just this clip">
          Intro / outro…
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} collisionPadding={12} className="z-[80] flex w-[min(360px,calc(100vw-24px))] flex-col gap-3 rounded-[12px] border border-line bg-panel p-3 text-ink shadow-pop">
          <b className="text-[13px]">Intro and outro for this clip</b>
          <BumperSelects value={v} onChange={setV} projectIntroId={projectIntroId} projectOutroId={projectOutroId} />
          <div className="flex justify-end gap-2">
            <button className="btn-ghost px-2.5 py-1 text-xs" disabled={!dirty || update.isPending} onClick={() => save(false)}>
              Save
            </button>
            <button className="btn-ink px-2.5 py-1 text-xs" disabled={!dirty || update.isPending || !rendered} title={rendered ? undefined : "This clip isn't rendered yet"} onClick={() => save(true)}>
              Save & re-render
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Applies an intro and/or outro to every selected clip (project page). Slots left on "Leave as it is" are untouched. */
export function BulkBumpersBar({ projectId, clipIds, rerenderable, projectIntroId, projectOutroId, onDone }: { projectId: string; clipIds: string[]; rerenderable: number; projectIntroId?: string | null; projectOutroId?: string | null; onDone: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState<SlotChoices>({ intro: "keep", outro: "keep" });
  const many = useMutation(trpc.clips.setBumpersMany.mutationOptions());
  const nothing = v.intro === "keep" && v.outro === "keep";
  const apply = (rerender: boolean) =>
    many.mutate(
      {
        projectId,
        clipIds,
        rerender,
        ...(v.intro !== "keep" ? { intro: v.intro } : {}),
        ...(v.outro !== "keep" ? { outro: v.outro } : {}),
        ...(v.intro !== "keep" && isAssetChoice(v.intro) && v.introSec ? { introSec: clampSec(v.introSec) } : {}),
        ...(v.outro !== "keep" && isAssetChoice(v.outro) && v.outroSec ? { outroSec: clampSec(v.outroSec) } : {}),
      },
      {
        onSuccess: (r) => {
          void qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: projectId }) });
          const what = [v.intro !== "keep" ? "intro" : "", v.outro !== "keep" ? "outro" : ""].filter(Boolean).join(" and ");
          toast(`Updated the ${what} on ${r.updated} clip${r.updated === 1 ? "" : "s"}${r.rerendered ? ` · re-rendering ${r.rerendered}` : ""}`);
          setV({ intro: "keep", outro: "keep" });
          onDone();
        },
        onError: (e) => toast(e.message),
      },
    );
  return (
    <div className="sticky bottom-0 z-10 flex flex-col gap-2 border-t border-line bg-panel p-3 shadow-pop">
      <b className="text-[13px]">
        {clipIds.length} clip{clipIds.length === 1 ? "" : "s"} selected
      </b>
      <BumperSelects keep value={v} onChange={setV} projectIntroId={projectIntroId} projectOutroId={projectOutroId} className="max-w-[28rem]" />
      <div className="flex flex-wrap justify-end gap-2">
        <button className="btn-ghost px-2.5 py-1 text-xs" disabled={nothing || many.isPending} onClick={() => apply(false)}>
          Apply
        </button>
        <button className="btn-ink min-w-[9rem] px-2.5 py-1 text-xs" disabled={nothing || many.isPending || !rerenderable} onClick={() => apply(true)}>
          {many.isPending ? "Applying…" : `Apply & re-render ${rerenderable}`}
        </button>
      </div>
    </div>
  );
}

type Choice = string; // "default" | "none" | library asset id

/**
 * This project's intro and outro: Default (what your Settings say now), None, or a specific one from the
 * library, with a seconds field for an image. Saving asks whether to re-render the clips, like other project-wide changes.
 */
export function ProjectBumpersModal({
  open,
  onOpenChange,
  projectId,
  clipCount,
  introId,
  outroId,
  introSec,
  outroSec,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  clipCount: number;
  introId: string | null | undefined;
  outroId: string | null | undefined;
  introSec?: number;
  outroSec?: number;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const library = useBumperLibrary();
  const defaults = useMe().data?.projectDefaults;
  const save = useMutation(trpc.projects.setBumpers.mutationOptions());
  const assets = library.data?.assets ?? [];
  const known = [...assets, ...(library.data?.deleted ?? [])];
  const known1 = (id: string | null | undefined, slotDefault: string | undefined): Choice => (id === null ? "none" : id ? (id === slotDefault ? "default" : id) : slotDefault ? "none" : "default");
  const initial = { intro: known1(introId, defaults?.introAssetId), outro: known1(outroId, defaults?.outroAssetId) };
  const [pick, setPick] = useState<{ intro?: Choice; outro?: Choice; introSec?: number | null; outroSec?: number | null }>({});
  const intro = pick.intro ?? initial.intro;
  const outro = pick.outro ?? initial.outro;
  const iSec = pick.introSec === undefined ? introSec : (pick.introSec ?? undefined);
  const oSec = pick.outroSec === undefined ? outroSec : (pick.outroSec ?? undefined);
  const dirty = intro !== initial.intro || outro !== initial.outro || iSec !== introSec || oSec !== outroSec;
  const name = (id: string | undefined | null) => (id ? (known.find((a) => a.id === id)?.name ?? "removed") : "none");
  const fixed = (slotDefault: string | undefined): FixedOption[] => [
    { value: "default", label: `Default (${name(slotDefault)})`, hint: "What Settings say now", icon: <Star className="h-4 w-4" /> },
    { value: "none", label: "None", hint: "Nothing here", icon: <Ban className="h-4 w-4" /> },
  ];
  // a project may still use an asset that was removed since; keep it selectable as itself
  const row = (slot: "intro" | "outro", label: string, choice: Choice, sec: number | undefined, slotDefault: string | undefined) => (
    <SlotRow
      slot={slot}
      label={label}
      choice={choice}
      sec={sec}
      onChange={(c, s) => setPick((p) => ({ ...p, [slot]: c, [`${slot}Sec`]: s ?? null }))}
      fixed={fixed(slotDefault)}
      assets={assets}
      known={known}
      defaultId={slotDefault}
      inheritedId={slotDefault}
      secOnInherit
    />
  );
  const apply = (rerender: boolean) =>
    save.mutate(
      { id: projectId, intro, outro, ...(iSec && intro !== "none" ? { introSec: clampSec(iSec) } : {}), ...(oSec && outro !== "none" ? { outroSec: clampSec(oSec) } : {}), rerender },
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
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
        {row("intro", "Intro", intro, iSec, defaults?.introAssetId)}
        {row("outro", "Outro", outro, oSec, defaults?.outroAssetId)}
      </div>
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
