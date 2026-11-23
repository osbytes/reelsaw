import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { AudioLines, Ban, Equal, Loader2, Pencil, Star, Trash2, X } from "lucide-react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@reelsaw/server";
import { formatTag, licenseText } from "../lib/library";
import { useTRPC } from "../lib/trpc";
import { toast } from "sonner";
import { useDeletedToast } from "../lib/deletedToast";
import { useRestoreWindow } from "../lib/retention";
import { uploadFile } from "../lib/uploads";
import { useMe } from "../lib/account";
import { ConfirmDialog, Modal, Skeleton, SkeletonRegion } from "./ui";
import { MultiCombobox } from "./MultiCombobox";
import { ScrollArea } from "./scroll-area";
import { BumperCombobox, clockText, type FixedOption } from "./BumperCombobox";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import type { ClipBumpers } from "@reelsaw/shared";
import { formatNumber } from "@reelsaw/shared";
import { plural, select, t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;
const ACCEPT =
  ".mp4,.mov,.webm,.png,.jpg,.jpeg,.webp,.gif,.svg,.mp3,.m4a,.aac,.wav,.ogg,.flac,video/mp4,video/quicktime,video/webm,image/png,image/jpeg,image/webp,image/gif,image/svg+xml,audio/mpeg,audio/mp4,audio/aac,audio/wav,audio/ogg,audio/flac";
const isImageFile = (f: File) => f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg)$/i.test(f.name);
const isAudioFile = (f: File) => f.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(f.name);
const clampSec = (n: number) => Math.min(10, Math.max(1, Math.round(n * 10) / 10));

/** One `library.list` row: kind, facts, usage, plus category, tags, provenance and whether it is a catalog item. */
export type LibraryAsset = inferRouterOutputs<AppRouter>["library"]["list"]["items"][number];

/** The user's library (live assets and recently deleted ones). */
export function useBumperLibrary() {
  const trpc = useTRPC();
  // the newest 500 uploads (the server pages; `total` says how many there are in all)
  return useQuery(
    trpc.library.list.queryOptions({ limit: 500 }, { select: (d) => ({ assets: d.items, deleted: d.deleted, total: d.total, nextCursor: d.nextCursor }) }),
  );
}

export const lengthText = (a: Pick<LibraryAsset, "durationSec">) =>
  a.durationSec >= 60 ? clockText(a.durationSec) : `${formatNumber(Number(a.durationSec.toFixed(a.durationSec % 1 ? 1 : 0)))} s`;
export const sizeText = (n: number) =>
  n >= 1024 * 1024 ? `${formatNumber(Number((n / 1024 / 1024).toFixed(1)))} MB` : `${formatNumber(Math.max(1, Math.round(n / 1024)))} KB`;
/** An asset's kind as a word: "video", "image", "audio". */
const kindWord = (kind: LibraryAsset["kind"]) => select(kind, { video: "video", image: "image", audio: "audio", other: "file" });
/** A slot or use as a word: "intro", "outro", "overlay", "music", "layer". */
const slotWord = (slot: string) => select(slot, { intro: "intro", outro: "outro", overlay: "overlay", music: "music", layer: "layer", other: slot });
/** "video · 4 s · 1080×1920", "audio · 2:31" (images are drawn separately: their length is a control). */
export const metaText = (a: LibraryAsset) => {
  if (a.kind === "audio") return `${kindWord(a.kind)} · ${lengthText(a)}`;
  const base = `${kindWord(a.kind)}${a.kind === "video" ? ` · ${lengthText(a)}` : ""} · ${a.width}×${a.height}`;
  return a.kind === "video" && !a.hasAudio ? t`${base} · silent` : base;
};

export interface UploadJob {
  key: string;
  name: string;
  pct: number;
  state: "queued" | "uploading" | "saving" | "done" | "failed";
  error?: string;
  /** shown instead of "added" when the file was already in the library */
  note?: string;
}

/** Upload (several at once, two at a time), default and delete/restore actions for the library. */
export function useBumperActions({ onDuplicate }: { onDuplicate?: (id: string) => void } = {}) {
  const { t } = useLingui();
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
  const removeM = useMutation(trpc.library.delete.mutationOptions());
  // the window the library page (or the delete confirm) already fetched; no fetch of its own
  const restoreWindow = useRestoreWindow("asset", false);
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
      const pendingFiles = queue.current.length + 1;
      toast.loading(plural(pendingFiles, { one: "Adding # file to your library…", other: "Adding # files to your library…" }), { id: "bumper-batch" });
      const { key, file } = next;
      try {
        patch(key, { state: "uploading" });
        const uploadId = await uploadFile(file, (pct) => patch(key, { pct }));
        patch(key, { state: "saving", pct: 1 });
        const r = await create.mutateAsync({ uploadId });
        if (r.duplicate) {
          // nothing new was stored: say so, and point at the card that already has it
          patch(key, { state: "done", note: r.restored ? t`restored` : t`already added` });
          const dupName = r.name;
          toast(r.restored ? t`Already in your library, restored “${dupName}”` : t`Already in your library: “${dupName}”`, { id: `bumper-dup-${r.id}` });
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
      if (failed) toast.error(t`Added ${ok} to your library · ${failed} failed`, { id: "bumper-batch" });
      else if (ok === 0)
        toast.dismiss("bumper-batch"); // only duplicates: their own toasts said it
      else toast.success(ok === 1 ? t`Added to your library` : t`Added ${ok} to your library`, { id: "bumper-batch" });
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
        fresh.push({
          key,
          name: file.name,
          pct: 0,
          state: "failed",
          error: (() => {
            const size = formatNumber(Math.ceil(file.size / 1024 / 1024));
            const most = formatNumber(max / 1024 / 1024);
            return image ? t`This file is ${size} MB. Images can be at most ${most} MB.` : t`This file is ${size} MB. Videos can be at most ${most} MB.`;
          })(),
        });
        continue;
      }
      fresh.push({ key, name: file.name, pct: 0, state: "queued" });
      queue.current.push({ key, file });
    }
    setJobs((js) => [...js, ...fresh]);
    // each worker takes its first file synchronously, so this starts at most two and never an idle one
    while (running.current < 2 && queue.current.length > 0) void work();
  };
  const dismiss = (key?: string) =>
    setJobs((js) => js.filter((j) => (key ? j.key !== key : j.state === "queued" || j.state === "uploading" || j.state === "saving")));

  const setDefault = (slot: "intro" | "outro", a: LibraryAsset, current: string | undefined) => {
    setDefaultM.mutate(
      { slot, assetId: current === a.id ? null : a.id },
      {
        onSuccess: () => {
          refresh();
          if (current === a.id) toast(slot === "intro" ? t`No default intro` : t`No default outro`);
          else toast(slot === "intro" ? t`New projects start with this intro` : t`New projects start with this outro`);
        },
        onError: fail,
      },
    );
  };
  const restore = (a: Pick<LibraryAsset, "id" | "name">) =>
    restoreM.mutateAsync({ id: a.id }).then(
      () => {
        refresh();
        const restoredName = a.name;
        toast(t`Restored “${restoredName}”`);
        return true;
      },
      (e) => (fail(e), false),
    );
  /** Soft delete with Undo / Delete forever / See deletions (the server keeps the file, so projects using it keep rendering). */
  const deleteAsset = (a: LibraryAsset) =>
    removeM.mutateAsync({ id: a.id }).then(
      () => (
        refresh(),
        notifyDeleted({
          items: [{ kind: "asset", id: a.id, title: a.name }],
          restorable: restoreWindow.restorable,
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
      () => (refresh(), toast(t`Renamed to “${next}”`), true),
      (e) => (fail(e), false),
    );
  };
  /** Tags change in place; the list refetches and keeps showing the old rows meanwhile. */
  const setTags = (a: Pick<LibraryAsset, "id" | "name">, tags: string[]) =>
    updateM.mutateAsync({ id: a.id, tags }).then(
      () => (refresh(), true),
      (e) => (fail(e), false),
    );
  return { jobs, uploading, busy, uploadMany, dismiss, setDefault, deleteAsset, restore, setSeconds, rename, setTags };
}

/** The library's audio file as an element the cards and the viewer share; at most one plays at a time. */
let playingAudio: HTMLAudioElement | null = null;
export const playOnly = (el: HTMLAudioElement) => {
  if (playingAudio && playingAudio !== el) playingAudio.pause();
  playingAudio = el;
  void el.play().catch(() => {});
};

/** A pencil that opens a small popover with the name field; Enter or Save renames. */
function RenamePopover({
  asset: a,
  busy,
  onRename,
  className = "",
}: {
  asset: Pick<LibraryAsset, "name">;
  busy: boolean;
  onRename: (name: string) => void;
  className?: string;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(a.name);
  const assetName = a.name;
  const save = () => {
    const next = v.trim();
    if (next && next !== a.name) onRename(next);
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={(o) => (o && setV(a.name), setOpen(o))}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`grid h-5 w-5 shrink-0 place-items-center rounded-[4px] text-ink3 hover:bg-sunk hover:text-ink ${className}`}
          aria-label={t`Rename ${assetName}`}
          title={t`Rename`}
        >
          <Pencil className="h-3 w-3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-[80] flex w-[min(300px,calc(100vw-24px))] flex-col gap-2 rounded-[12px] border border-line bg-panel p-3 text-xs text-ink shadow-pop"
        >
          <label className="flex flex-col gap-1 text-ink2">
            <Trans>Name</Trans>
            <input
              className="input h-8 px-2 py-0 text-xs"
              type="text"
              maxLength={120}
              value={v}
              disabled={busy}
              autoFocus
              aria-label={t`New name`}
              onChange={(e) => setV(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
            />
          </label>
          <div className="flex justify-end gap-1.5">
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setOpen(false)}>
              <Trans>Cancel</Trans>
            </button>
            <button type="button" className="btn-ink px-2 py-1 text-xs" disabled={busy || !v.trim() || v.trim() === a.name} onClick={save}>
              <Trans>Save</Trans>
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The hidden file input behind the Library page's Upload button (the page-wide drop overlay handles drops). */
export function UploadInput({ inputRef, actions }: { inputRef: React.RefObject<HTMLInputElement | null>; actions: ReturnType<typeof useBumperActions> }) {
  const { t } = useLingui();
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
      aria-label={t`Choose files for your library`}
    />
  );
}

/** Per-file progress for the current batch as a compact row; render it only while there are jobs. */
export function UploadJobs({ jobs, onDismiss }: { jobs: UploadJob[]; onDismiss: (key?: string) => void }) {
  const { t } = useLingui();
  const finished = jobs.filter((j) => j.state === "done" || j.state === "failed").length;
  return (
    <div className="rounded-[10px] border border-line bg-sunk" aria-live="polite">
      {jobs.length > 0 && (
        <ul className="flex max-h-28 flex-col gap-1.5 overflow-y-auto p-2 text-xs">
          {jobs.map((j) => (
            <li key={j.key} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                {j.state === "done" ? (
                  <span className="font-mono text-ok">●</span>
                ) : j.state === "failed" ? (
                  <span className="font-mono text-err">▲</span>
                ) : (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-acc-text" />
                )}
                <span className="min-w-0 flex-1 truncate">{j.name}</span>
                <span className="shrink-0 font-mono text-ink3">
                  {j.state === "queued"
                    ? t`waiting`
                    : j.state === "uploading"
                      ? `${Math.round(j.pct * 100)}%`
                      : j.state === "saving"
                        ? t`adding`
                        : j.state === "done"
                          ? (j.note ?? t`added`)
                          : t`failed`}
                </span>
                {(j.state === "done" || j.state === "failed") && (
                  <button type="button" className="text-ink3 hover:text-ink" aria-label={t`Dismiss ${j.name}`} onClick={() => onDismiss(j.key)}>
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
            <Trans>Dismiss finished</Trans>
          </button>
        </div>
      )}
    </div>
  );
}

/** Seconds field for an image; empty means the library item's own length. */
function SecField({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  placeholder: number;
  label: string;
}) {
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
  defaultId?: string | null | undefined;
  /** the asset a "follow the project / default" choice ends up using */
  inheritedId?: string | null | undefined;
  /** seconds may be set even when the choice is "default" (the project modal) */
  secOnInherit?: boolean;
}) {
  const { t } = useLingui();
  const choiceLabel = t`${label} choice`;
  const secLabel = slot === "intro" ? t`Seconds the intro is shown` : t`Seconds the outro is shown`;
  const effective = fixed.some((f) => f.value === choice) ? (secOnInherit && (choice === "default" || choice === "inherit") ? inheritedId : null) : choice;
  const image = effective ? known.find((a) => a.id === effective && a.kind === "image") : undefined;
  if (reserveSec)
    return (
      <>
        <span className="text-xs text-ink2 max-sm:col-span-full max-sm:-mb-1">{label}</span>
        <BumperCombobox
          className="min-w-0"
          slot={slot}
          label={choiceLabel}
          value={choice}
          onChange={(c) => onChange(c, undefined)}
          fixed={fixed}
          assets={assets}
          known={known}
          defaultId={defaultId}
          loading={loading}
        />
        <div className="flex w-[5rem] justify-end">
          {image && <SecField value={sec} onChange={(v) => onChange(choice, v)} placeholder={image.durationSec} label={secLabel} />}
        </div>
      </>
    );
  return (
    <>
      <span className="text-xs text-ink2">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        <BumperCombobox
          className="min-w-0 flex-1"
          slot={slot}
          label={choiceLabel}
          value={choice}
          onChange={(c) => onChange(c, undefined)}
          fixed={fixed}
          assets={assets}
          known={known}
          defaultId={defaultId}
          loading={loading}
        />
        {image && <SecField value={sec} onChange={(v) => onChange(choice, v)} placeholder={image.durationSec} label={secLabel} />}
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
    <a href={p.url} target="_blank" rel="noreferrer noopener" className={`${cls} hover:text-ink hover:underline`} title={t`${text} (opens the source)`}>
      {text}
    </a>
  ) : (
    <span className={cls} title={text}>
      {text}
    </span>
  );
}

/** Tags: pick from the ones already in your library or create one (Enter); each change saves right away. */
function TagEditor({ asset: a, busy, onTags }: { asset: Pick<LibraryAsset, "name" | "tags">; busy: boolean; onTags: (tags: string[]) => void }) {
  const library = useBumperLibrary();
  const { t } = useLingui();
  const known = [...new Set([...(library.data?.assets ?? []).flatMap((x) => x.tags), ...a.tags])].sort((x, y) => x.localeCompare(y)); // sort-ok: tag suggestions A-Z, not list rows
  const assetName = a.name;
  return (
    <MultiCombobox
      label={t`Tags on ${assetName}`}
      placeholder={t`Add tags…`}
      searchPlaceholder={t`Find or create a tag…`}
      empty={t`No tags yet. Type one to create it.`}
      footerHint={t`Tags make an item easy to find`}
      options={known.map((tag) => ({ value: tag, label: tag }))}
      value={a.tags}
      disabled={busy}
      onChange={(tags) => onTags(tags.slice(0, 30))}
      creatable={{ noun: t`tag`, normalize: (q) => q.trim().toLowerCase().slice(0, 40) || null }}
    />
  );
}

/** Intro / outro / delete, in the same order on the card and in the viewer. */
function AssetActions({
  asset: a,
  introId,
  outroId,
  busy,
  onUse,
  onDelete,
  withLabels = false,
}: {
  asset: LibraryAsset;
  introId?: string | undefined;
  outroId?: string | undefined;
  busy: boolean;
  onUse: (slot: "intro" | "outro") => void;
  onDelete: () => void;
  withLabels?: boolean;
}) {
  const { t } = useLingui();
  const assetName = a.name;
  const slotTexts = (slot: "intro" | "outro") =>
    slot === "intro"
      ? {
          stop: t`Stop using ${assetName} as the default intro`,
          use: t`Use ${assetName} as the default intro`,
          notDefault: t`Not the default intro`,
          useAs: t`Use as intro`,
          not: t`Not intro`,
          short: t`Intro`,
        }
      : {
          stop: t`Stop using ${assetName} as the default outro`,
          use: t`Use ${assetName} as the default outro`,
          notDefault: t`Not the default outro`,
          useAs: t`Use as outro`,
          not: t`Not outro`,
          short: t`Outro`,
        };
  const slotBtn = (slot: "intro" | "outro", on: boolean, x = slotTexts(slot)) => (
    <button
      type="button"
      className={`btn-ghost justify-center px-1 py-1 text-xs ${on ? "!bg-acc-soft !text-acc-text" : ""}`}
      disabled={busy || a.kind === "audio"}
      aria-pressed={on}
      aria-label={on ? x.stop : x.use}
      title={a.kind === "audio" ? t`Music goes under a clip (editor → Overlays → Music), not before or after it` : on ? x.notDefault : x.useAs}
      onClick={() => onUse(slot)}
    >
      {on ? "● " : ""}
      {withLabels ? (on ? x.not : x.useAs) : x.short}
    </button>
  );
  return (
    <div className="grid grid-cols-3 gap-1">
      {slotBtn("intro", introId === a.id)}
      {slotBtn("outro", outroId === a.id)}
      <button
        type="button"
        className="btn-ghost justify-center px-1 py-1 text-xs"
        disabled={busy}
        aria-label={t`Delete ${assetName}`}
        title={t`Delete`}
        onClick={onDelete}
      >
        <Trash2 className="h-3.5 w-3.5" />
        {withLabels && t`Delete`}
      </button>
    </div>
  );
}

/** "3 s" with a pencil for an image: a tiny popover with the seconds field. */
export function LengthPopover({ asset: a, busy, onSeconds }: { asset: LibraryAsset; busy: boolean; onSeconds: (sec: number) => void }) {
  const { t } = useLingui();
  const length = lengthText(a);
  const assetName = a.name;
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
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-0.5 rounded-[4px] text-ink2 underline decoration-dotted underline-offset-2 hover:text-ink"
          aria-label={t`Shown for ${length}. Change how long ${assetName} is shown`}
          title={t`Change how long it is shown`}
        >
          {lengthText(a)}
          <Pencil className="h-3 w-3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-[80] flex w-[min(220px,calc(100vw-24px))] flex-col gap-2 rounded-[12px] border border-line bg-panel p-3 text-xs text-ink shadow-pop"
        >
          <label className="flex items-center gap-1.5 text-ink2">
            <Trans>Shown for</Trans>
            <input
              className="input h-7 w-16 px-1.5 py-0 text-xs"
              type="number"
              min={1}
              max={10}
              step={0.5}
              value={v}
              disabled={busy}
              autoFocus
              aria-label={t`Seconds ${assetName} is shown`}
              onChange={(e) => setV(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
            />
            s
          </label>
          <div className="flex justify-end gap-1.5">
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setOpen(false)}>
              <Trans>Cancel</Trans>
            </button>
            <button type="button" className="btn-ink px-2 py-1 text-xs" disabled={busy} onClick={save}>
              <Trans>Save</Trans>
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Always one line: default intro / outro, and where it is used (a popover with the projects), or "Empty". */
export function StatusLine({ asset: a, isIntro, isOutro, applied }: { asset: LibraryAsset; isIntro: boolean; isOutro: boolean; applied: boolean }) {
  const { t } = useLingui();
  const defaults = isIntro && isOutro ? t`● Default intro + outro` : isIntro ? t`● Default intro` : isOutro ? t`● Default outro` : "";
  const used = [
    a.usedBy ? plural(a.usedBy, { one: "# project", other: "# projects" }) : "",
    a.usedByClips ? plural(a.usedByClips, { one: "# clip", other: "# clips" }) : "",
    a.usedByTemplates ? plural(a.usedByTemplates, { one: "# template", other: "# templates" }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const usedText = defaults
    ? applied
      ? t`· used by ${used}, re-render to apply`
      : t`· used by ${used}`
    : applied
      ? t`Used by ${used}, re-render to apply`
      : t`Used by ${used}`;
  const assetName = a.name;
  return (
    <div className="flex h-5 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px]">
      {defaults && <span className="shrink-0 font-semibold text-acc-text">{defaults}</span>}
      {a.usedBy || a.usedByClips || a.usedByTemplates ? (
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              type="button"
              className="min-w-0 truncate text-start font-semibold text-acc-text hover:underline"
              title={t`Where it’s used`}
              aria-label={t`Where ${assetName} is used`}
            >
              {usedText}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="start"
              sideOffset={6}
              collisionPadding={12}
              className="z-[80] w-[min(380px,calc(100vw-24px))] rounded-[12px] border border-line bg-panel p-3 text-ink shadow-pop"
            >
              <b className="text-[13px]">
                <Trans>Where “{assetName}” is used</Trans>
              </b>
              <UsageList id={a.id} className="mt-2 max-h-[min(280px,50dvh)]" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : (
        !defaults && <span className="text-ink3">{applied ? t`Saved` : t`○ Not used yet`}</span>
      )}
    </div>
  );
}

/** Click a thumbnail: the item at full size (a video plays with sound), its facts and the card's actions. Esc or a click outside closes. */
export function AssetLightbox({
  asset: a,
  introId,
  outroId,
  busy,
  onClose,
  onUse,
  onDelete,
  onRename,
  onTags,
}: {
  onTags: (tags: string[]) => void;
  asset: LibraryAsset | null;
  introId?: string | undefined;
  outroId?: string | undefined;
  busy: boolean;
  onClose: () => void;
  onUse: (slot: "intro" | "outro") => void;
  onDelete: () => void;
  onRename: (name: string) => void;
}) {
  const { t } = useLingui();
  const assetName = a?.name ?? "";
  const lightboxFacts = a
    ? (() => {
        const facts =
          a.kind === "audio"
            ? `${kindWord(a.kind)} · ${lengthText(a)} · ${sizeText(a.sizeBytes)}`
            : `${kindWord(a.kind)} · ${lengthText(a)} · ${a.width}×${a.height} · ${sizeText(a.sizeBytes)}`;
        return a.kind === "video" && !a.hasAudio ? t`${facts} · silent` : facts;
      })()
    : "";
  return (
    <Dialog.Root open={!!a} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/70" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed start-1/2 top-1/2 z-[71] flex max-h-[calc(100dvh-24px)] w-[min(460px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-[18px] border border-line bg-panel p-3 text-ink shadow-pop outline-none sm:p-4"
        >
          {a && (
            <>
              <div className="flex items-center gap-2">
                <Dialog.Title className="min-w-0 flex-1 truncate font-bold">{a.name}</Dialog.Title>
                <RenamePopover asset={a} busy={busy} onRename={onRename} />
                <Dialog.Close className="text-ink2 hover:text-ink" aria-label={t`Close`}>
                  <X className="h-4 w-4" />
                </Dialog.Close>
              </div>
              {a.kind === "audio" ? (
                <div className="flex flex-col items-center gap-4 rounded-[12px] bg-sunk px-4 py-8">
                  <AudioLines className="h-12 w-12 text-ink3" aria-hidden />
                  <audio
                    key={a.id}
                    src={`/media/assets/${a.id}`}
                    controls
                    autoPlay
                    preload="metadata"
                    className="w-full"
                    aria-label={t`Play ${assetName}`}
                    onPlay={(e) => playOnly(e.currentTarget)}
                  />
                </div>
              ) : (
                <div className="flex h-[min(62dvh,640px)] min-h-[160px] items-center justify-center overflow-hidden rounded-[12px] bg-black">
                  {a.kind === "video" ? (
                    <video
                      key={a.id}
                      src={`/media/assets/${a.id}`}
                      poster={a.thumbnailUrl}
                      controls
                      autoPlay
                      playsInline
                      className="max-h-full max-w-full object-contain"
                    />
                  ) : (
                    <img key={a.id} src={`/media/assets/${a.id}`} alt={a.name} className="max-h-full max-w-full object-contain" />
                  )}
                </div>
              )}
              <p className="truncate font-mono text-xs text-ink3">
                {formatTag(a.mime) ? `${formatTag(a.mime)} · ` : ""}
                {lightboxFacts}
              </p>
              <TagEditor asset={a} busy={busy} onTags={onTags} />
              {a.provenance && (
                <div className="flex items-center gap-2">
                  <LicenseBadge provenance={a.provenance} wrap className="min-w-0 flex-1 whitespace-normal" />
                </div>
              )}
              {(a.usedBy > 0 || a.usedByClips > 0 || a.usedByTemplates > 0) && (
                <div className="rounded-[12px] border border-line p-3">
                  <b className="text-xs">
                    <Trans>Where it’s used</Trans>
                  </b>
                  <UsageList id={a.id} className="mt-2 max-h-[min(200px,30dvh)]" />
                </div>
              )}
              <AssetActions asset={a} introId={introId} outroId={outroId} busy={busy} onUse={onUse} onDelete={onDelete} withLabels />
              <p className="text-center text-xs text-ink3">
                <Trans>
                  New project with it as the{" "}
                  <Link to={`/new?intro=${a.id}`} className="text-ink2 hover:text-ink">
                    intro
                  </Link>{" "}
                  ·{" "}
                  <Link to={`/new?outro=${a.id}`} className="text-ink2 hover:text-ink">
                    outro
                  </Link>
                </Trans>
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
  const { t } = useLingui();
  const trpc = useTRPC();
  const q = useQuery(trpc.library.usage.queryOptions({ id }));
  const projects = q.data?.projects ?? [];
  const templates = q.data?.templates ?? [];
  return (
    <ScrollArea className={className}>
      <div className="flex min-h-[3rem] flex-col gap-2.5 pe-2 text-xs">
        {q.isPending && !q.error && (
          <SkeletonRegion label={t`Loading usage…`} className="flex flex-col gap-2.5">
            {["w-2/3", "w-1/2", "w-3/5"].map((w, i) => (
              <div key={i} className="flex flex-col gap-1">
                <Skeleton className={`h-4 ${w}`} />
                <Skeleton className="h-3 w-4/5" />
              </div>
            ))}
          </SkeletonRegion>
        )}
        {q.error && <span className="text-err">{q.error.message}</span>}
        {q.data && projects.length === 0 && templates.length === 0 && (
          <span className="text-ink3">
            <Trans>Nothing uses it right now.</Trans>
          </span>
        )}
        {templates.map((tpl) => {
          const uses = [...tpl.slots.map(slotWord), ...(tpl.layers ? [tpl.layers > 1 ? `${slotWord("layer")} ×${tpl.layers}` : slotWord("layer")] : [])].join(
            " + ",
          );
          return (
            <div key={tpl.id} className="flex items-baseline gap-2">
              <Link to={`/templates/${tpl.id}`} className="min-w-0 flex-1 truncate font-semibold text-ink">
                {tpl.name}
              </Link>
              <span className="shrink-0 text-ink3">{t`${uses} · template`}</span>
            </div>
          );
        })}
        {projects.map((p) => (
          <div key={p.id} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2">
              <Link to={`/p/${p.id}`} className="min-w-0 flex-1 truncate font-semibold text-ink">
                {p.title}
              </Link>
              {p.slots.length > 0 && <span className="shrink-0 text-ink3">{t`${p.slots.map(slotWord).join(" + ")} · project`}</span>}
            </div>
            {p.clips.map((c) => (
              <div key={c.id} className="flex items-baseline gap-2 ps-3">
                <Link to={`/p/${p.id}#clip=${c.id}`} className="min-w-0 flex-1 truncate text-ink2">
                  <span className="font-mono text-ink3">#{c.index + 1}</span> {c.title || t`Untitled clip`}
                </Link>
                <span className="shrink-0 text-ink3">
                  {(() => {
                    const uses = c.slots
                      .map((s) =>
                        s === "overlay" && c.overlays > 1
                          ? `${slotWord(s)} ×${c.overlays}`
                          : s === "music" && c.music > 1
                            ? `${slotWord(s)} ×${c.music}`
                            : slotWord(s),
                      )
                      .join(" + ");
                    return c.via === "clip" ? t`${uses} · on the clip` : t`${uses} · from project`;
                  })()}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

/** Confirm before deleting a library item (library page and command palette); lists what still uses it. */
export function DeleteAssetDialog({
  asset,
  onClose,
  onConfirm,
}: {
  asset: Pick<LibraryAsset, "id" | "name" | "usedBy" | "usedByTemplates"> | null;
  onClose: () => void;
  onConfirm: () => Promise<unknown>;
}) {
  const { t } = useLingui();
  const { hint } = useRestoreWindow("asset", !!asset);
  const used = asset ? asset.usedBy > 0 || asset.usedByTemplates > 0 : false;
  const body = (() => {
    if (!asset) return "";
    const name = asset.name;
    const after = hint();
    if (asset.usedBy) {
      const projects = plural(asset.usedBy, {
        one: "The project using it keeps rendering with it (as intro, outro, overlay or music) until it picks another.",
        other: "The # projects using it keep rendering with it (as intro, outro, overlay or music) until they pick another.",
      });
      const templates = asset.usedByTemplates
        ? plural(asset.usedByTemplates, {
            one: "A template also uses it: that layer is skipped when the template is applied.",
            other: "# templates also use it: that layer is skipped when the template is applied.",
          })
        : "";
      return [projects, templates, after].filter(Boolean).join(" ");
    }
    if (asset.usedByTemplates) {
      const templates = plural(asset.usedByTemplates, {
        one: `A template uses “${name}”: that layer is skipped when the template is applied until you restore the file or pick another.`,
        other: `# templates use “${name}”: that layer is skipped when the template is applied until you restore the file or pick another.`,
      });
      return `${templates} ${after}`;
    }
    return t`“${name}” is hidden from pickers and defaults. ${after}`;
  })();
  return (
    <ConfirmDialog
      open={!!asset}
      onOpenChange={(o) => !o && onClose()}
      title={t`Delete from your library?`}
      width={460}
      body={body}
      confirm={t`Delete`}
      danger
      onConfirm={onConfirm}
    >
      {asset && used && <UsageList id={asset.id} className="max-h-[min(220px,35dvh)]" />}
    </ConfirmDialog>
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
export const choicesFrom = (b: ClipBumpers | null | undefined): SlotChoices => ({
  intro: toChoice(b?.intro),
  outro: toChoice(b?.outro),
  ...(b?.introSec ? { introSec: b.introSec } : {}),
  ...(b?.outroSec ? { outroSec: b.outroSec } : {}),
});
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
export const effectiveSeconds = (
  clipSec: number | undefined,
  ownChoice: string | null | undefined,
  projectSec: number | undefined,
  assetSec: number | undefined,
) => (ownChoice !== undefined && ownChoice !== null ? (clipSec ?? assetSec) : (projectSec ?? assetSec));

/**
 * Intro and Outro rows for one clip or a selection of clips: Project default (name) / None / each library asset.
 * `template`: a layer template's slots instead (Clip's own / None / each asset; there is no project to follow).
 */
export function BumperSelects({
  value,
  onChange,
  projectIntroId,
  projectOutroId,
  className = "",
  keep = false,
  reserveSec = false,
  template = false,
}: {
  value: SlotChoices;
  onChange: (v: SlotChoices) => void;
  projectIntroId?: string | null | undefined;
  projectOutroId?: string | null | undefined;
  className?: string;
  keep?: boolean;
  reserveSec?: boolean;
  template?: boolean;
}) {
  const { t } = useLingui();
  const library = useBumperLibrary();
  const defaults = useMe().data?.projectDefaults;
  // music is for the audio lane, never a slot
  const assets = (library.data?.assets ?? []).filter((a) => a.kind !== "audio");
  const known = [...assets, ...(library.data?.deleted ?? [])];
  const name = (id: string | null | undefined) => (id ? (known.find((a) => a.id === id)?.name ?? (library.isPending ? "…" : t`deleted`)) : t`none`);
  const fixed = (projectId: string | null | undefined): FixedOption[] => {
    const inherited = name(projectId);
    return template
      ? [
          { value: "keep", label: t`Clip’s own`, hint: t`Clips keep the one they have`, icon: <Equal className="h-4 w-4" /> },
          { value: "none", label: t`None`, hint: t`Takes it off the clips`, icon: <Ban className="h-4 w-4" /> },
        ]
      : [
          ...(keep ? [{ value: "keep", label: t`Leave as it is`, hint: t`Don’t change this slot`, icon: <Equal className="h-4 w-4" /> }] : []),
          { value: "inherit", label: t`Project default (${inherited})`, hint: t`Follow the project`, icon: <Star className="h-4 w-4" /> },
          { value: "none", label: t`None`, hint: t`Nothing here`, icon: <Ban className="h-4 w-4" /> },
        ];
  };
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
    <div
      className={`grid ${reserveSec ? "grid-cols-[4.5rem_minmax(0,22rem)_5rem] max-sm:grid-cols-[minmax(0,1fr)_5rem]" : "grid-cols-[4.5rem_minmax(0,1fr)]"} items-center gap-x-3 gap-y-2 ${className}`}
    >
      {row("intro", t`Intro`, projectIntroId, defaults?.introAssetId)}
      {row("outro", t`Outro`, projectOutroId, defaults?.outroAssetId)}
    </div>
  );
}

/** "Intro / outro…" from a clip card's ⋯ menu: this clip's own choice without opening the editor. */
export function ClipBumpersDialog({
  open,
  onOpenChange,
  clipId,
  projectId,
  bumpers,
  rendered,
  projectIntroId,
  projectOutroId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  clipId: string;
  projectId: string;
  bumpers: ClipBumpers | null | undefined;
  rendered: boolean;
  projectIntroId?: string | null | undefined;
  projectOutroId?: string | null | undefined;
}) {
  const { t } = useLingui();
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
          toast(rerender ? t`Saved · re-rendering this clip` : t`Saved for this clip`);
          onOpenChange(false);
        },
        onError: (e) => toast.error(e.message),
      },
    );
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t`Intro and outro for this clip`} width={400}>
      <Dialog.Description className="sr-only">
        <Trans>Choose an intro and outro for just this clip.</Trans>
      </Dialog.Description>
      <BumperSelects value={v} onChange={setV} projectIntroId={projectIntroId} projectOutroId={projectOutroId} />
      <div className="flex justify-end gap-2">
        <button className="btn-ghost px-2.5 py-1 text-xs" onClick={() => onOpenChange(false)}>
          <Trans>Cancel</Trans>
        </button>
        <button className="btn-ghost px-2.5 py-1 text-xs" disabled={!dirty || update.isPending} onClick={() => save(false)}>
          <Trans>Save</Trans>
        </button>
        <button
          className="btn-ink px-2.5 py-1 text-xs"
          disabled={!dirty || update.isPending || !rendered}
          title={rendered ? undefined : t`This clip isn't rendered yet`}
          onClick={() => save(true)}
        >
          <Trans>Save & re-render</Trans>
        </button>
      </div>
    </Modal>
  );
}

/** Applies an intro and/or outro to every selected clip (the selection bar's ⋯ menu). Slots left on "Leave as it is" are untouched. Pass `open` to drive it from that menu; otherwise it renders its own button. */
export function BulkBumpersPopover({
  projectId,
  clipIds,
  rerenderable,
  projectIntroId,
  projectOutroId,
  onDone,
  className,
  open: openProp,
  onOpenChange,
}: {
  projectId: string;
  clipIds: string[];
  rerenderable: number;
  projectIntroId?: string | null | undefined;
  projectOutroId?: string | null | undefined;
  onDone: () => void;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useLingui();
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
          const clips = plural(r.updated, { one: "# clip", other: "# clips" });
          const head =
            v.intro !== "keep" && v.outro !== "keep"
              ? t`Updated the intro and outro on ${clips}`
              : v.intro !== "keep"
                ? t`Updated the intro on ${clips}`
                : t`Updated the outro on ${clips}`;
          const rerendered = r.rerendered;
          toast(rerendered ? t`${head} · re-rendering ${rerendered}` : head);
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
          <button
            className={className}
            title={plural(clipIds.length, { one: "Set the intro and outro of # clip", other: "Set the intro and outro of # clips" })}
          >
            <Trans>Intro/outro…</Trans>
          </button>
        </Popover.Trigger>
      ) : (
        <Popover.Anchor className="pointer-events-none absolute end-8 bottom-0 h-px w-px" />
      )}
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="z-[80] flex w-[min(360px,calc(100vw-24px))] flex-col gap-3 rounded-[12px] border border-line bg-panel p-3 text-ink shadow-pop"
        >
          <b className="text-[13px]">{plural(clipIds.length, { one: "Intro and outro for # clip", other: "Intro and outro for # clips" })}</b>
          <BumperSelects keep value={v} onChange={setV} projectIntroId={projectIntroId} projectOutroId={projectOutroId} />
          <div className="flex justify-end gap-2">
            <button className="btn-ghost px-2.5 py-1 text-xs" disabled={nothing || many.isPending} onClick={() => apply(false)}>
              <Trans>Apply</Trans>
            </button>
            <button
              className="btn-ink min-w-[9rem] px-2.5 py-1 text-xs"
              disabled={nothing || many.isPending || !rerenderable}
              title={rerenderable ? undefined : t`None of the selected clips is rendered yet`}
              onClick={() => apply(true)}
            >
              {many.isPending ? t`Applying…` : t`Apply & re-render ${rerenderable}`}
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
  introSec?: number | undefined;
  outroSec?: number | undefined;
}) {
  const { t } = useLingui();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const library = useBumperLibrary();
  const defaults = useMe().data?.projectDefaults;
  const save = useMutation(trpc.projects.setBumpers.mutationOptions());
  const assets = library.data?.assets ?? [];
  const known = [...assets, ...(library.data?.deleted ?? [])];
  const known1 = (id: string | null | undefined, slotDefault: string | undefined): Choice =>
    id === null ? "none" : id ? (id === slotDefault ? "default" : id) : slotDefault ? "none" : "default";
  const initial = { intro: known1(introId, defaults?.introAssetId), outro: known1(outroId, defaults?.outroAssetId) };
  const [pick, setPick] = useState<{ intro?: Choice; outro?: Choice; introSec?: number | null; outroSec?: number | null }>({});
  const intro = pick.intro ?? initial.intro;
  const outro = pick.outro ?? initial.outro;
  const iSec = pick.introSec === undefined ? introSec : (pick.introSec ?? undefined);
  const oSec = pick.outroSec === undefined ? outroSec : (pick.outroSec ?? undefined);
  const dirty = intro !== initial.intro || outro !== initial.outro || iSec !== introSec || oSec !== outroSec;
  const name = (id: string | undefined | null) => (id ? (known.find((a) => a.id === id)?.name ?? (library.isPending ? "…" : t`deleted`)) : t`none`);
  const fixed = (slotDefault: string | undefined): FixedOption[] => {
    const current = name(slotDefault);
    return [
      { value: "default", label: t`Default (${current})`, hint: t`What Settings say now`, icon: <Star className="h-4 w-4" /> },
      { value: "none", label: t`None`, hint: t`Nothing here`, icon: <Ban className="h-4 w-4" /> },
    ];
  };
  // a project may still use an asset that was deleted since; keep it selectable as itself
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
      {
        id: projectId,
        intro,
        outro,
        ...(iSec && intro !== "none" ? { introSec: clampSec(iSec) } : {}),
        ...(oSec && outro !== "none" ? { outroSec: clampSec(oSec) } : {}),
        rerender,
      },
      {
        onSuccess: (r) => {
          void qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: projectId }) });
          void qc.invalidateQueries({ queryKey: trpc.library.pathKey() });
          toast(r.rerendered ? plural(r.rerendered, { one: "Saved · re-rendering # clip", other: "Saved · re-rendering # clips" }) : t`Saved`);
          setPick({});
          onOpenChange(false);
        },
        onError: (e) => toast.error(e.message),
      },
    );
  return (
    <Modal open={open} onOpenChange={(o) => (setPick({}), onOpenChange(o))} title={t`Intro and outro for this project`} width={460}>
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
        {row("intro", t`Intro`, intro, iSec, defaults?.introAssetId)}
        {row("outro", t`Outro`, outro, oSec, defaults?.outroAssetId)}
      </div>
      <p className="min-h-8 text-xs text-ink3">
        {dirty
          ? plural(clipCount, { one: "Re-render # clip now, or save and re-render later.", other: "Re-render # clips now, or save and re-render later." })
          : t`Manage the library on the Library page.`}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <button className="btn-ghost" onClick={() => onOpenChange(false)}>
          <Trans>Cancel</Trans>
        </button>
        <button className="btn-ghost" disabled={!dirty || save.isPending} onClick={() => apply(false)}>
          <Trans>Save</Trans>
        </button>
        <button className="btn-ink min-w-[10rem]" disabled={!dirty || save.isPending} onClick={() => apply(true)}>
          {save.isPending ? t`Saving…` : t`Save & re-render ${clipCount}`}
        </button>
      </div>
    </Modal>
  );
}
