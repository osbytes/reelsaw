import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { AudioLines, Ban, Equal, Film, Image as ImageIcon, Loader2, Pause, Pencil, Play, Plus, Star, Trash2, X } from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@reelsaw/server";
import { formatTag, licenseText } from "../lib/library";
import { useTRPC } from "../lib/trpc";
import { toast } from "sonner";
import { useDeletedToast } from "../lib/deletedToast";
import { uploadFile } from "../lib/uploads";
import { useMe } from "../lib/account";
import { Modal, Skeleton, SkeletonRegion } from "./ui";
import { ScrollArea } from "./scroll-area";
import { BumperCombobox, clockText, type FixedOption } from "./BumperCombobox";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import type { ClipBumpers } from "@reelsaw/shared";

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;
const ACCEPT = ".mp4,.mov,.webm,.png,.jpg,.jpeg,.webp,.gif,.svg,.mp3,.m4a,.aac,.wav,.ogg,.flac,video/mp4,video/quicktime,video/webm,image/png,image/jpeg,image/webp,image/gif,image/svg+xml,audio/mpeg,audio/mp4,audio/aac,audio/wav,audio/ogg,audio/flac";
const isImageFile = (f: File) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg)$/i.test(f.name);
const isAudioFile = (f: File) => f.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(f.name);
const clampSec = (n: number) => Math.min(10, Math.max(1, Math.round(n * 10) / 10));

/** One `library.list` row: kind, facts, usage, plus category, tags, provenance and whether it is a catalog item. */
export type LibraryAsset = inferRouterOutputs<AppRouter>["library"]["list"]["assets"][number];

/** The user's library (live assets and recently removed ones). */
export function useBumperLibrary() {
  const trpc = useTRPC();
  return useQuery(trpc.library.list.queryOptions());
}

export const lengthText = (a: Pick<LibraryAsset, "durationSec">) => (a.durationSec >= 60 ? clockText(a.durationSec) : `${a.durationSec.toFixed(a.durationSec % 1 ? 1 : 0)} s`);
export const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
/** "video · 4 s · 1080×1920", "audio · 2:31" (images are drawn separately: their length is a control). */
export const metaText = (a: LibraryAsset) => (a.kind === "audio" ? `audio · ${lengthText(a)}` : `${a.kind}${a.kind === "video" ? ` · ${lengthText(a)}` : ""} · ${a.width}×${a.height}${a.kind === "video" && !a.hasAudio ? " · silent" : ""}`);

export interface UploadJob {
  key: string;
  name: string;
  pct: number;
  state: "queued" | "uploading" | "saving" | "done" | "failed";
  error?: string;
  /** shown instead of "added" when the file was already in the library */
  note?: string;
}

/** Upload (several at once, two at a time), default and remove/restore actions for the library. */
export function useBumperActions({ onDuplicate }: { onDuplicate?: (id: string) => void } = {}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const queue = useRef<Array<{ key: string; file: File }>>([]);
  const running = useRef(0);
  const finished = useRef({ ok: 0, failed: 0 });
  const dupRef = useRef(onDuplicate);
  dupRef.current = onDuplicate;
  const fail = (e: unknown) => toast.error((e instanceof Error ? e.message : String(e)).slice(0, 200));
  const notifyDeleted = useDeletedToast();
  const create = useMutation(trpc.library.add.mutationOptions());
  const setDefaultM = useMutation(trpc.library.setDefault.mutationOptions());
  const removeM = useMutation(trpc.library.remove.mutationOptions());
  const restoreM = useMutation(trpc.library.restore.mutationOptions());
  const updateM = useMutation(trpc.library.update.mutationOptions());
  const busy = setDefaultM.isPending || removeM.isPending || restoreM.isPending || updateM.isPending;
  const uploading = jobs.some((j) => j.state === "queued" || j.state === "uploading" || j.state === "saving");
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: trpc.me.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.library.pathKey() });
  };
  const patch = (key: string, p: Partial<UploadJob>) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...p } : j)));

  const work = async () => {
    running.current++;
    for (let next = queue.current.shift(); next; next = queue.current.shift()) {
      toast.loading(`Adding ${queue.current.length + 1} file${queue.current.length ? "s" : ""} to your library…`, { id: "bumper-batch" });
      const { key, file } = next;
      try {
        patch(key, { state: "uploading" });
        const uploadId = await uploadFile(file, (pct) => patch(key, { pct }));
        patch(key, { state: "saving", pct: 1 });
        const r = await create.mutateAsync({ uploadId });
        if (r.duplicate) {
          // nothing new was stored: say so, and point at the card that already has it
          patch(key, { state: "done", note: r.restored ? "restored" : "already added" });
          toast(r.restored ? `Already in your library, restored: ${r.name}` : `Already in your library: ${r.name}`, { id: `bumper-dup-${r.id}` });
          dupRef.current?.(r.id);
        } else {
          patch(key, { state: "done" });
          finished.current.ok++;
        }
        refresh();
      } catch (e) {
        patch(key, { state: "failed", error: (e as Error).message.replace(/^"|"$/g, "").slice(0, 200) });
        finished.current.failed++;
      }
    }
    if (--running.current === 0) {
      const { ok, failed } = finished.current;
      finished.current = { ok: 0, failed: 0 };
      if (failed) toast.error(`Added ${ok} to your library · ${failed} failed`, { id: "bumper-batch" });
      else if (ok === 0) toast.dismiss("bumper-batch"); // only duplicates: their own toasts said it
      else toast.success(ok === 1 ? "Added to your library" : `Added ${ok} to your library`, { id: "bumper-batch" });
    }
  };
  /** Checks sizes, then uploads and adds each file to the library, two at a time. */
  const uploadMany = (files: File[]) => {
    if (!files.length) return;
    const fresh: UploadJob[] = [];
    for (const file of files) {
      const key = `${file.name}:${file.size}:${Date.now()}:${Math.random()}`;
      const image = isImageFile(file);
      const max = image ? MAX_IMAGE_BYTES : isAudioFile(file) ? MAX_AUDIO_BYTES : MAX_VIDEO_BYTES;
      if (file.size > max) {
        fresh.push({ key, name: file.name, pct: 0, state: "failed", error: `This file is ${Math.ceil(file.size / 1024 / 1024)} MB. ${image ? "Images" : "Videos"} can be at most ${max / 1024 / 1024} MB.` });
        continue;
      }
      fresh.push({ key, name: file.name, pct: 0, state: "queued" });
      queue.current.push({ key, file });
    }
    setJobs((js) => [...js, ...fresh]);
    // each worker takes its first file synchronously, so this starts at most two and never an idle one
    while (running.current < 2 && queue.current.length > 0) void work();
  };
  const dismiss = (key?: string) => setJobs((js) => js.filter((j) => (key ? j.key !== key : j.state === "queued" || j.state === "uploading" || j.state === "saving")));

  const setDefault = (slot: "intro" | "outro", a: LibraryAsset, current: string | undefined) => {
    setDefaultM.mutate({ slot, assetId: current === a.id ? null : a.id }, { onSuccess: () => (refresh(), toast(current === a.id ? `No default ${slot}` : `New projects start with this ${slot}`)), onError: fail });
  };
  const restore = (a: Pick<LibraryAsset, "id" | "name">) =>
    restoreM.mutateAsync({ id: a.id }).then(
      () => (refresh(), toast(`Restored ${a.name}`), true),
      (e) => (fail(e), false),
    );
  /** Soft delete with Undo / Delete forever / See deletions (the server keeps the file, so projects using it keep rendering). */
  const remove = (a: LibraryAsset) =>
    removeM.mutateAsync({ id: a.id }).then(
      () => (
        refresh(),
        notifyDeleted({
          items: [{ kind: "asset", id: a.id, title: a.name }],
          restorable: "for 30 days",
          storedBytes: a.sizeBytes,
          canPurge: !a.usedBy && !a.usedByClips && !a.usedByTemplates,
        }),
        true
      ),
      (e) => (fail(e), false),
    );
  /** Image length; resolves true when saved. */
  const setSeconds = (a: LibraryAsset, sec: number) =>
    updateM.mutateAsync({ id: a.id, imageSeconds: clampSec(sec) }).then(
      () => (refresh(), true),
      (e) => (fail(e), false),
    );
  /** New label; only the name changes, nothing re-renders. Resolves true when saved. */
  const rename = (a: LibraryAsset, name: string) => {
    const next = name.trim();
    if (!next || next === a.name) return Promise.resolve(false);
    return updateM.mutateAsync({ id: a.id, name: next }).then(
      () => (refresh(), toast(`Renamed to ${next}`), true),
      (e) => (fail(e), false),
    );
  };
  /** Tags change in place; the list refetches and keeps showing the old rows meanwhile. */
  const setTags = (a: Pick<LibraryAsset, "id" | "name">, tags: string[]) =>
    updateM.mutateAsync({ id: a.id, tags }).then(
      () => (refresh(), true),
      (e) => (fail(e), false),
    );
  return { jobs, uploading, busy, uploadMany, dismiss, setDefault, remove, restore, setSeconds, rename, setTags };
}

/** The library's audio file as an element the cards and the viewer share; at most one plays at a time. */
let playingAudio: HTMLAudioElement | null = null;
export const playOnly = (el: HTMLAudioElement) => {
  if (playingAudio && playingAudio !== el) playingAudio.pause();
  playingAudio = el;
  void el.play().catch(() => {});
};

/** A pencil that opens a small popover with the name field; Enter or Save renames. */
function RenamePopover({ asset: a, busy, onRename, className = "" }: { asset: Pick<LibraryAsset, "name">; busy: boolean; onRename: (name: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(a.name);
  const save = () => {
    const next = v.trim();
    if (next && next !== a.name) onRename(next);
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={(o) => (o && setV(a.name), setOpen(o))}>
      <Popover.Trigger asChild>
        <button type="button" className={`grid h-5 w-5 shrink-0 place-items-center rounded-[4px] text-ink3 hover:bg-sunk hover:text-ink ${className}`} aria-label={`Rename ${a.name}`} title="Rename">
          <Pencil className="h-3 w-3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} collisionPadding={12} className="z-[80] flex w-[min(300px,calc(100vw-24px))] flex-col gap-2 rounded-[12px] border border-line bg-panel p-3 text-xs text-ink shadow-pop">
          <label className="flex flex-col gap-1 text-ink2">
            Name
            <input className="input h-8 px-2 py-0 text-xs" type="text" maxLength={120} value={v} disabled={busy} autoFocus aria-label="New name" onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
          </label>
          <div className="flex justify-end gap-1.5">
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn-ink px-2 py-1 text-xs" disabled={busy || !v.trim() || v.trim() === a.name} onClick={save}>
              Save
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The hidden file input behind the Library page's Upload button (the page-wide drop overlay handles drops). */
export function UploadInput({ inputRef, actions }: { inputRef: React.RefObject<HTMLInputElement | null>; actions: ReturnType<typeof useBumperActions> }) {
  return (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept={ACCEPT}
      className="hidden"
      onChange={(e) => {
        const files = [...(e.target.files ?? [])];
        e.target.value = "";
        actions.uploadMany(files);
      }}
      aria-label="Choose files for your library"
    />
  );
}

/** Per-file progress for the current batch as a compact row; render it only while there are jobs. */
export function UploadJobs({ jobs, onDismiss }: { jobs: UploadJob[]; onDismiss: (key?: string) => void }) {
  const finished = jobs.filter((j) => j.state === "done" || j.state === "failed").length;
  return (
    <div className="rounded-[10px] border border-line bg-sunk" aria-live="polite">
      {jobs.length > 0 && (
        <ul className="flex max-h-28 flex-col gap-1.5 overflow-y-auto p-2 text-xs">
          {jobs.map((j) => (
            <li key={j.key} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                {j.state === "done" ? <span className="font-mono text-ok">●</span> : j.state === "failed" ? <span className="font-mono text-err">▲</span> : <Loader2 className="h-3 w-3 shrink-0 animate-spin text-acc-text" />}
                <span className="min-w-0 flex-1 truncate">{j.name}</span>
                <span className="shrink-0 font-mono text-ink3">{j.state === "queued" ? "waiting" : j.state === "uploading" ? `${Math.round(j.pct * 100)}%` : j.state === "saving" ? "adding" : j.state === "done" ? (j.note ?? "added") : "failed"}</span>
                {(j.state === "done" || j.state === "failed") && (
                  <button type="button" className="text-ink3 hover:text-ink" aria-label={`Dismiss ${j.name}`} onClick={() => onDismiss(j.key)}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {j.state === "uploading" && (
                <div className="h-1 overflow-hidden rounded-full bg-line">
                  <div className="h-full bg-acc transition-all" style={{ width: `${j.pct * 100}%` }} />
                </div>
              )}
              {j.error && <span className="text-err">{j.error}</span>}
            </li>
          ))}
        </ul>
      )}
      {finished > 0 && (
        <div className="flex items-center justify-end gap-2 border-t border-line px-2 py-1 text-xs first:border-t-0">
          <button type="button" className="shrink-0 font-semibold text-ink2 hover:text-ink" onClick={() => onDismiss()}>
            Dismiss finished
          </button>
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
export function SlotRow({
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
  loading = false,
  reserveSec = false,
}: {
  loading?: boolean;
  /** lay out as label | picker (capped) | seconds slot, keeping the slot's width when no image is chosen */
  reserveSec?: boolean;
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
  if (reserveSec)
    return (
      <>
        <span className="text-xs text-ink2 max-sm:col-span-full max-sm:-mb-1">{label}</span>
        <BumperCombobox className="min-w-0" slot={slot} label={`${label} choice`} value={choice} onChange={(c) => onChange(c, undefined)} fixed={fixed} assets={assets} known={known} defaultId={defaultId} loading={loading} />
        <div className="flex w-[5rem] justify-end">{image && <SecField value={sec} onChange={(v) => onChange(choice, v)} placeholder={image.durationSec} label={`Seconds the ${slot} is shown`} />}</div>
      </>
    );
  return (
    <>
      <span className="text-xs text-ink2">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        <BumperCombobox className="min-w-0 flex-1" slot={slot} label={`${label} choice`} value={choice} onChange={(c) => onChange(c, undefined)} fixed={fixed} assets={assets} known={known} defaultId={defaultId} loading={loading} />
        {image && <SecField value={sec} onChange={(v) => onChange(choice, v)} placeholder={image.durationSec} label={`Seconds the ${slot} is shown`} />}
      </div>
    </>
  );
}

/** "CC0 · Freesound · author"; a link to the source page when there is one. Renders nothing for the user's own uploads. */
export function LicenseBadge({ provenance: p, className = "", wrap = false }: { provenance: LibraryAsset["provenance"]; className?: string; wrap?: boolean }) {
  if (!p) return null;
  const text = licenseText(p);
  const cls = `rounded-[5px] bg-sunk px-1 py-px text-[10px] font-semibold text-ink2 ${wrap ? "" : "block truncate"} ${className}`;
  return p.url ? (
    <a href={p.url} target="_blank" rel="noreferrer noopener" className={`${cls} hover:text-ink hover:underline`} title={`${text} (opens the source)`}>
      {text}
    </a>
  ) : (
    <span className={cls} title={text}>
      {text}
    </span>
  );
}

/** Tags as removable chips with an add field (Enter or comma); each change saves right away. */
function TagEditor({ asset: a, busy, onTags }: { asset: Pick<LibraryAsset, "name" | "tags">; busy: boolean; onTags: (tags: string[]) => void }) {
  const [v, setV] = useState("");
  const add = () => {
    const next = v.split(",").map((t) => t.trim().toLowerCase().slice(0, 40)).filter((t) => t && !a.tags.includes(t));
    setV("");
    if (next.length) onTags([...a.tags, ...next].slice(0, 30));
  };
  return (
    <div className="flex min-h-[3.25rem] flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1" aria-label="Tags">
        {a.tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-0.5 rounded-full bg-sunk py-0.5 pl-2 pr-1 text-[11px] text-ink2">
            {t}
            <button type="button" className="grid h-4 w-4 place-items-center rounded-full hover:bg-line" disabled={busy} aria-label={`Remove tag ${t}`} onClick={() => onTags(a.tags.filter((x) => x !== t))}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {a.tags.length === 0 && <span className="text-[11px] text-ink3">No tags yet</span>}
      </div>
      <div className="flex items-center gap-1.5">
        <input className="input h-7 min-w-0 flex-1 px-2 py-0 text-xs" type="text" maxLength={40} value={v} disabled={busy} placeholder="Add a tag…" aria-label={`Add a tag to ${a.name}`} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => (e.key === "Enter" || e.key === ",") && (e.preventDefault(), add())} />
        <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy || !v.trim()} onClick={add} aria-label="Add tag">
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Intro / outro / remove, in the same order on the card and in the viewer. */
function AssetActions({ asset: a, introId, outroId, busy, onUse, onRemove, withLabels = false }: { asset: LibraryAsset; introId?: string; outroId?: string; busy: boolean; onUse: (slot: "intro" | "outro") => void; onRemove: () => void; withLabels?: boolean }) {
  const slotBtn = (slot: "intro" | "outro", on: boolean) => (
    <button type="button" className={`btn-ghost justify-center px-1 py-1 text-xs ${on ? "!bg-acc-soft !text-acc-text" : ""}`} disabled={busy || a.kind === "audio"} aria-pressed={on} aria-label={on ? `Stop using ${a.name} as the default ${slot}` : `Use ${a.name} as the default ${slot}`} title={a.kind === "audio" ? "Music goes under a clip (editor → Overlays → Music), not before or after it" : on ? `Not the default ${slot}` : `Use as ${slot}`} onClick={() => onUse(slot)}>
      {on ? "● " : ""}
      {withLabels ? (on ? `Not ${slot}` : `Use as ${slot}`) : slot === "intro" ? "Intro" : "Outro"}
    </button>
  );
  return (
    <div className="grid grid-cols-3 gap-1">
      {slotBtn("intro", introId === a.id)}
      {slotBtn("outro", outroId === a.id)}
      <button type="button" className="btn-ghost justify-center px-1 py-1 text-xs" disabled={busy} aria-label={`Remove ${a.name}`} title="Remove" onClick={onRemove}>
        <Trash2 className="h-3.5 w-3.5" />
        {withLabels && "Remove"}
      </button>
    </div>
  );
}

/** "3 s" with a pencil for an image: a tiny popover with the seconds field. */
export function LengthPopover({ asset: a, busy, onSeconds }: { asset: LibraryAsset; busy: boolean; onSeconds: (sec: number) => void }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(String(a.durationSec));
  const save = () => {
    const n = Number(v);
    if (v !== "" && Number.isFinite(n) && clampSec(n) !== a.durationSec) onSeconds(n);
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={(o) => (o && setV(String(a.durationSec)), setOpen(o))}>
      <Popover.Trigger asChild>
        <button type="button" className="inline-flex shrink-0 items-center gap-0.5 rounded-[4px] text-ink2 underline decoration-dotted underline-offset-2 hover:text-ink" aria-label={`Shown for ${lengthText(a)}. Change how long ${a.name} is shown`} title="Change how long it is shown">
          {lengthText(a)}
          <Pencil className="h-3 w-3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} collisionPadding={12} className="z-[80] flex w-[min(220px,calc(100vw-24px))] flex-col gap-2 rounded-[12px] border border-line bg-panel p-3 text-xs text-ink shadow-pop">
          <label className="flex items-center gap-1.5 text-ink2">
            Shown for
            <input className="input h-7 w-16 px-1.5 py-0 text-xs" type="number" min={1} max={10} step={0.5} value={v} disabled={busy} autoFocus aria-label={`Seconds ${a.name} is shown`} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />s
          </label>
          <div className="flex justify-end gap-1.5">
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn-ink px-2 py-1 text-xs" disabled={busy} onClick={save}>
              Save
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Always one line: default intro / outro, and where it is used (a popover with the projects), or "Empty". */
export function StatusLine({ asset: a, isIntro, isOutro, applied }: { asset: LibraryAsset; isIntro: boolean; isOutro: boolean; applied: boolean }) {
  const defaults = [isIntro && "intro", isOutro && "outro"].filter(Boolean).join(" + ");
  const fix = applied ? ", re-render to apply" : "";
  const used = [a.usedBy ? `${a.usedBy} project${a.usedBy === 1 ? "" : "s"}` : "", a.usedByClips ? `${a.usedByClips} clip${a.usedByClips === 1 ? "" : "s"}` : "", a.usedByTemplates ? `${a.usedByTemplates} template${a.usedByTemplates === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  return (
    <div className="flex h-5 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px]">
      {defaults && <span className="shrink-0 font-semibold text-acc-text">● Default {defaults}</span>}
      {a.usedBy || a.usedByClips || a.usedByTemplates ? (
        <Popover.Root>
          <Popover.Trigger asChild>
            <button type="button" className="min-w-0 truncate text-left font-semibold text-acc-text hover:underline" title="Where it’s used" aria-label={`Where ${a.name} is used`}>
              {defaults ? `· used by ${used}${fix}` : `Used by ${used}${fix}`}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content align="start" sideOffset={6} collisionPadding={12} className="z-[80] w-[min(380px,calc(100vw-24px))] rounded-[12px] border border-line bg-panel p-3 text-ink shadow-pop">
              <b className="text-[13px]">Where “{a.name}” is used</b>
              <UsageList id={a.id} className="mt-2 max-h-[min(280px,50dvh)]" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : (
        !defaults && <span className="text-ink3">{applied ? "Saved" : "○ Not used yet"}</span>
      )}
    </div>
  );
}

/** Click a thumbnail: the item at full size (a video plays with sound), its facts and the card's actions. Esc or a click outside closes. */
export function AssetLightbox({ asset: a, introId, outroId, busy, onClose, onUse, onRemove, onRename, onTags }: { onTags: (tags: string[]) => void; asset: LibraryAsset | null; introId?: string; outroId?: string; busy: boolean; onClose: () => void; onUse: (slot: "intro" | "outro") => void; onRemove: () => void; onRename: (name: string) => void }) {
  return (
    <Dialog.Root open={!!a} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/70" />
        <Dialog.Content aria-describedby={undefined} className="fixed left-1/2 top-1/2 z-[71] flex max-h-[calc(100dvh-24px)] w-[min(460px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-[18px] border border-line bg-panel p-3 text-ink shadow-pop outline-none sm:p-4">
          {a && (
            <>
              <div className="flex items-center gap-2">
                <Dialog.Title className="min-w-0 flex-1 truncate font-bold">{a.name}</Dialog.Title>
                <RenamePopover asset={a} busy={busy} onRename={onRename} />
                <Dialog.Close className="text-ink2 hover:text-ink" aria-label="Close">
                  <X className="h-4 w-4" />
                </Dialog.Close>
              </div>
              {a.kind === "audio" ? (
                <div className="flex flex-col items-center gap-4 rounded-[12px] bg-sunk px-4 py-8">
                  <AudioLines className="h-12 w-12 text-ink3" aria-hidden />
                  <audio key={a.id} src={`/media/assets/${a.id}`} controls autoPlay preload="metadata" className="w-full" aria-label={`Play ${a.name}`} onPlay={(e) => playOnly(e.currentTarget)} />
                </div>
              ) : (
                <div className="flex h-[min(62dvh,640px)] min-h-[160px] items-center justify-center overflow-hidden rounded-[12px] bg-black">
                  {a.kind === "video" ? (
                    <video key={a.id} src={`/media/assets/${a.id}`} poster={a.thumbnailUrl} controls autoPlay playsInline className="max-h-full max-w-full object-contain" />
                  ) : (
                    <img key={a.id} src={`/media/assets/${a.id}`} alt={a.name} className="max-h-full max-w-full object-contain" />
                  )}
                </div>
              )}
              <p className="truncate font-mono text-xs text-ink3">
                {formatTag(a.mime) ? `${formatTag(a.mime)} · ` : ""}
                {a.kind === "audio" ? `audio · ${lengthText(a)} · ${sizeText(a.sizeBytes)}` : `${a.kind} · ${lengthText(a)} · ${a.width}×${a.height} · ${sizeText(a.sizeBytes)}`}
                {a.kind === "video" && !a.hasAudio ? " · silent" : ""}
              </p>
              <TagEditor asset={a} busy={busy} onTags={onTags} />
              {a.provenance && (
                <div className="flex items-center gap-2">
                  <LicenseBadge provenance={a.provenance} wrap className="min-w-0 flex-1 whitespace-normal" />
                </div>
              )}
              {(a.usedBy > 0 || a.usedByClips > 0 || a.usedByTemplates > 0) && (
                <div className="rounded-[12px] border border-line p-3">
                  <b className="text-xs">Where it’s used</b>
                  <UsageList id={a.id} className="mt-2 max-h-[min(200px,30dvh)]" />
                </div>
              )}
              <AssetActions asset={a} introId={introId} outroId={outroId} busy={busy} onUse={onUse} onRemove={onRemove} withLabels />
              <p className="text-center text-xs text-ink3">
                New project with it as the{" "}
                <Link to={`/new?intro=${a.id}`} className="text-ink2 hover:text-ink">
                  intro
                </Link>{" "}
                ·{" "}
                <Link to={`/new?outro=${a.id}`} className="text-ink2 hover:text-ink">
                  outro
                </Link>
              </p>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Projects that use an asset (default or override) with the clips under each, and where each use comes from. */
export function UsageList({ id, className = "" }: { id: string; className?: string }) {
  const trpc = useTRPC();
  const q = useQuery(trpc.library.usage.queryOptions({ id }));
  const projects = q.data?.projects ?? [];
  const templates = q.data?.templates ?? [];
  return (
    <ScrollArea className={className}>
      <div className="flex min-h-[3rem] flex-col gap-2.5 pr-2 text-xs">
        {q.isPending && !q.error && (
          <SkeletonRegion label="Loading usage…" className="flex flex-col gap-2.5">
            {["w-2/3", "w-1/2", "w-3/5"].map((w, i) => (
              <div key={i} className="flex flex-col gap-1">
                <Skeleton className={`h-4 ${w}`} />
                <Skeleton className="h-3 w-4/5" />
              </div>
            ))}
          </SkeletonRegion>
        )}
        {q.error && <span className="text-err">{q.error.message}</span>}
        {q.data && projects.length === 0 && templates.length === 0 && <span className="text-ink3">Nothing uses it right now.</span>}
        {templates.map((t) => (
          <div key={t.id} className="flex items-baseline gap-2">
            <Link to={`/templates/${t.id}`} className="min-w-0 flex-1 truncate font-semibold text-ink">
              {t.name}
            </Link>
            <span className="shrink-0 text-ink3">{t.layers > 1 ? `layer ×${t.layers}` : "layer"} · template</span>
          </div>
        ))}
        {projects.map((p) => (
          <div key={p.id} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2">
              <Link to={`/p/${p.id}`} className="min-w-0 flex-1 truncate font-semibold text-ink">
                {p.title}
              </Link>
              {p.slots.length > 0 && <span className="shrink-0 text-ink3">{p.slots.join(" + ")} · project</span>}
            </div>
            {p.clips.map((c) => (
              <div key={c.id} className="flex items-baseline gap-2 pl-3">
                <Link to={`/p/${p.id}#clip=${c.id}`} className="min-w-0 flex-1 truncate text-ink2">
                  <span className="font-mono text-ink3">#{c.index + 1}</span> {c.title || "Untitled moment"}
                </Link>
                <span className="shrink-0 text-ink3">
                  {c.slots.map((s) => (s === "overlay" && c.overlays > 1 ? `overlay ×${c.overlays}` : s === "music" && c.music > 1 ? `music ×${c.music}` : s)).join(" + ")} · {c.via === "clip" ? "on the clip" : "from project"}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

/** Confirm before removing an asset; lists what still uses it. */
export function RemoveDialog({ asset, onClose, onConfirm }: { asset: LibraryAsset | null; onClose: () => void; onConfirm: (a: LibraryAsset) => void }) {
  return (
    <Modal open={!!asset} onOpenChange={(o) => !o && onClose()} title="Remove from your library?" width={460}>
      {asset && (
        <>
          <p className="text-sm leading-relaxed text-ink2">
            {asset.usedBy
              ? `Removing it: ${asset.usedBy === 1 ? "this project keeps" : `these ${asset.usedBy} projects keep`} rendering with it (as intro, outro, overlay or music) until ${asset.usedBy === 1 ? "it picks" : "they pick"} another.${asset.usedByTemplates ? ` ${asset.usedByTemplates === 1 ? "A template" : `${asset.usedByTemplates} templates`} also use${asset.usedByTemplates === 1 ? "s" : ""} it: that layer is skipped when the template is applied.` : ""} You can restore it for 30 days.`
              : asset.usedByTemplates
                ? `${asset.usedByTemplates === 1 ? "A template uses" : `${asset.usedByTemplates} templates use`} “${asset.name}”: that layer is skipped when the template is applied until you restore the file or pick another. You can restore it for 30 days.`
                : `“${asset.name}” will be removed. You can restore it for 30 days.`}
          </p>
          {(asset.usedBy > 0 || asset.usedByTemplates > 0) && <UsageList id={asset.id} className="max-h-[min(220px,35dvh)]" />}
          <div className="mt-1 flex justify-end gap-2">
            <button className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn bg-err font-semibold text-white hover:brightness-110"
              onClick={() => {
                onConfirm(asset);
                onClose();
              }}
            >
              Remove
            </button>
          </div>
        </>
      )}
    </Modal>
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
export function BumperSelects({ value, onChange, projectIntroId, projectOutroId, className = "", keep = false, reserveSec = false }: { value: SlotChoices; onChange: (v: SlotChoices) => void; projectIntroId?: string | null; projectOutroId?: string | null; className?: string; keep?: boolean; reserveSec?: boolean }) {
  const library = useBumperLibrary();
  const defaults = useMe().data?.projectDefaults;
  // music is for the audio lane, never a slot
  const assets = (library.data?.assets ?? []).filter((a) => a.kind !== "audio");
  const known = [...assets, ...(library.data?.deleted ?? [])];
  const name = (id: string | null | undefined) => (id ? (known.find((a) => a.id === id)?.name ?? (library.isPending ? "…" : "removed")) : "none");
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
      loading={library.isPending}
      reserveSec={reserveSec}
    />
  );
  return (
    <div className={`grid ${reserveSec ? "grid-cols-[4.5rem_minmax(0,22rem)_5rem] max-sm:grid-cols-[minmax(0,1fr)_5rem]" : "grid-cols-[4.5rem_minmax(0,1fr)]"} items-center gap-x-3 gap-y-2 ${className}`}>
      {row("intro", "Intro", projectIntroId, defaults?.introAssetId)}
      {row("outro", "Outro", projectOutroId, defaults?.outroAssetId)}
    </div>
  );
}

/** "Intro / outro…" from a clip card's ⋯ menu: this clip's own choice without opening the editor. */
export function ClipBumpersDialog({ open, onOpenChange, clipId, projectId, bumpers, rendered, projectIntroId, projectOutroId }: { open: boolean; onOpenChange: (o: boolean) => void; clipId: string; projectId: string; bumpers: ClipBumpers | null | undefined; rendered: boolean; projectIntroId?: string | null; projectOutroId?: string | null }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [v, setV] = useState<SlotChoices>(choicesFrom(bumpers));
  const update = useMutation(trpc.clips.update.mutationOptions());
  // start from what the clip has each time the dialog opens
  useEffect(() => {
    if (open) setV(choicesFrom(bumpers));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const dirty = JSON.stringify(clipBumpersFrom(v)) !== JSON.stringify(clipBumpersFrom(choicesFrom(bumpers)));
  const save = (rerender: boolean) =>
    update.mutate(
      { id: clipId, bumpers: clipBumpersFrom(v), rerender },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: projectId }) });
          toast(rerender ? "Saved · re-rendering this clip" : "Saved for this clip");
          onOpenChange(false);
        },
        onError: (e) => toast.error(e.message),
      },
    );
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Intro and outro for this clip" width={400}>
      <Dialog.Description className="sr-only">Choose an intro and outro for just this clip.</Dialog.Description>
      <BumperSelects value={v} onChange={setV} projectIntroId={projectIntroId} projectOutroId={projectOutroId} />
      <div className="flex justify-end gap-2">
        <button className="btn-ghost px-2.5 py-1 text-xs" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
        <button className="btn-ghost px-2.5 py-1 text-xs" disabled={!dirty || update.isPending} onClick={() => save(false)}>
          Save
        </button>
        <button className="btn-ink px-2.5 py-1 text-xs" disabled={!dirty || update.isPending || !rendered} title={rendered ? undefined : "This clip isn't rendered yet"} onClick={() => save(true)}>
          Save & re-render
        </button>
      </div>
    </Modal>
  );
}

/** Applies an intro and/or outro to every selected clip (the selection bar's ⋯ menu). Slots left on "Leave as it is" are untouched. Pass `open` to drive it from that menu; otherwise it renders its own button. */
export function BulkBumpersPopover({ projectId, clipIds, rerenderable, projectIntroId, projectOutroId, onDone, className, open: openProp, onOpenChange }: { projectId: string; clipIds: string[]; rerenderable: number; projectIntroId?: string | null; projectOutroId?: string | null; onDone: () => void; className?: string; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [inner, setInner] = useState(false);
  const open = openProp ?? inner;
  const setOpen = (next: boolean) => {
    onOpenChange?.(next);
    if (openProp === undefined) setInner(next);
  };
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
          setOpen(false);
          onDone();
        },
        onError: (e) => toast.error(e.message),
      },
    );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {openProp === undefined ? (
        <Popover.Trigger asChild>
          <button className={className} title={`Set the intro and outro of ${clipIds.length} clip${clipIds.length === 1 ? "" : "s"}`}>
            Intro/outro…
          </button>
        </Popover.Trigger>
      ) : (
        <Popover.Anchor className="pointer-events-none absolute right-8 bottom-0 h-px w-px" />
      )}
      <Popover.Portal>
        <Popover.Content side="top" align="end" sideOffset={8} collisionPadding={12} className="z-[80] flex w-[min(360px,calc(100vw-24px))] flex-col gap-3 rounded-[12px] border border-line bg-panel p-3 text-ink shadow-pop">
          <b className="text-[13px]">
            Intro and outro for {clipIds.length} clip{clipIds.length === 1 ? "" : "s"}
          </b>
          <BumperSelects keep value={v} onChange={setV} projectIntroId={projectIntroId} projectOutroId={projectOutroId} />
          <div className="flex justify-end gap-2">
            <button className="btn-ghost px-2.5 py-1 text-xs" disabled={nothing || many.isPending} onClick={() => apply(false)}>
              Apply
            </button>
            <button className="btn-ink min-w-[9rem] px-2.5 py-1 text-xs" disabled={nothing || many.isPending || !rerenderable} title={rerenderable ? undefined : "None of the selected clips is rendered yet"} onClick={() => apply(true)}>
              {many.isPending ? "Applying…" : `Apply & re-render ${rerenderable}`}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
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
  const name = (id: string | undefined | null) => (id ? (known.find((a) => a.id === id)?.name ?? (library.isPending ? "…" : "removed")) : "none");
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
      loading={library.isPending}
    />
  );
  const apply = (rerender: boolean) =>
    save.mutate(
      { id: projectId, intro, outro, ...(iSec && intro !== "none" ? { introSec: clampSec(iSec) } : {}), ...(oSec && outro !== "none" ? { outroSec: clampSec(oSec) } : {}), rerender },
      {
        onSuccess: (r) => {
          void qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: projectId }) });
          void qc.invalidateQueries({ queryKey: trpc.library.pathKey() });
          toast(r.rerendered ? `Saved · re-rendering ${r.rerendered} clip${r.rerendered === 1 ? "" : "s"}` : "Saved");
          setPick({});
          onOpenChange(false);
        },
        onError: (e) => toast.error(e.message),
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
