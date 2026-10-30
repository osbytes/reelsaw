import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import { useTRPC } from "../lib/trpc";
import { clipsText } from "../lib/clipMeta";
import { useDeletedToast } from "../lib/deletedToast";
import { useRestoreWindow } from "../lib/retention";
import { BulkBumpersPopover } from "./BumperField";
import { SelectionBar } from "./SelectionBar";
import { BulkTemplateButton } from "./TemplatePicker";
import { ConfirmDialog, MoreButton } from "./ui";

interface BatchClip {
  id: string;
  title: string;
  caption: string;
  hashtags: string[];
  status: "preparing" | "pending" | "rendering" | "done" | "failed";
  /** the clip's layers (only the count matters here: the template dialog asks Replace / Keep when some clip has any) */
  layers?: unknown[] | null;
}

/**
 * The selection's actions, one compact row at the bottom of the clips list. Re-render and Export stay
 * on the row; copy, intro/outro, template, retry and delete live in ⋯. Sticky inside the clips ScrollArea.
 */
export function BatchBar({
  projectId,
  selected,
  introId,
  outroId,
  onClear,
  onChanged,
}: {
  projectId: string;
  selected: BatchClip[];
  introId?: string | null | undefined;
  outroId?: string | null | undefined;
  onClear: () => void;
  onChanged: () => void;
}) {
  const trpc = useTRPC();
  const many = useMutation(trpc.clips.rerenderMany.mutationOptions());
  const delMany = useMutation(trpc.clips.deleteMany.mutationOptions());
  const notifyDeleted = useDeletedToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const keepWindow = useRestoreWindow("clip", confirmDelete);
  const [bumpersOpen, setBumpersOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const done = selected.filter((c) => c.status === "done");
  const failed = selected.filter((c) => c.status === "failed");
  const renderable = selected.filter((c) => c.status === "done" || c.status === "failed");
  const run = (clips: BatchClip[], what: string) =>
    many.mutate(
      { projectId, clipIds: clips.map((c) => c.id) },
      {
        onSuccess: (r) => {
          onChanged();
          toast(`${what} ${r.rerendered} clip${r.rerendered === 1 ? "" : "s"}${r.skipped ? ` · ${r.skipped} skipped (still rendering)` : ""}`);
        },
        onError: (e) => toast.error(e.message),
      },
    );
  const copyAll = () =>
    navigator.clipboard
      .writeText(clipsText(selected))
      .then(() => toast(`Title, caption + hashtags of ${selected.length} clip${selected.length === 1 ? "" : "s"} copied`))
      .catch(() => toast.error("Couldn’t copy"));
  const n = (k: number) => `${k} clip${k === 1 ? "" : "s"}`;
  const exportHref = `/api/projects/${projectId}/export.zip?clips=${done.map((c) => c.id).join(",")}`;
  const later = (fn: () => void) => window.setTimeout(fn, 0);

  return (
    <SelectionBar label="Selected clips" count={selected.length} onClear={onClear}>
      <button
        className="btn-ghost"
        disabled={!renderable.length || many.isPending}
        title={renderable.length ? `Re-render ${n(renderable.length)}` : "None of the selected clips is rendered or failed"}
        onClick={() => run(renderable, "Re-rendering")}
      >
        Re-render
      </button>
      {done.length ? (
        <a className="btn-ghost" href={exportHref} title={`Download a zip of ${n(done.length)} with YouTube and TikTok metadata`}>
          Export
        </a>
      ) : (
        <button className="btn-ghost" disabled title="None of the selected clips is rendered yet">
          Export
        </button>
      )}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <MoreButton aria-label="More actions for the selection" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content side="top" align="end" sideOffset={8} className="menu w-[220px]">
            <DropdownMenu.Item className="menu-item" onSelect={() => void copyAll()}>
              Copy text
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => later(() => setBumpersOpen(true))}>
              Intro / outro…
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => later(() => setTemplateOpen(true))}>
              Layer template…
            </DropdownMenu.Item>
            {failed.length > 0 && (
              <DropdownMenu.Item className="menu-item" disabled={many.isPending} onSelect={() => run(failed, "Retrying")}>
                Retry failed ({failed.length})
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Separator className="mx-1.5 my-1 h-px bg-line" />
            <DropdownMenu.Item className="menu-item-danger" disabled={delMany.isPending} onSelect={() => later(() => setConfirmDelete(true))}>
              Delete…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <BulkBumpersPopover
        projectId={projectId}
        clipIds={selected.map((c) => c.id)}
        rerenderable={renderable.length}
        projectIntroId={introId}
        projectOutroId={outroId}
        onDone={onChanged}
        open={bumpersOpen}
        onOpenChange={setBumpersOpen}
      />
      <BulkTemplateButton
        projectId={projectId}
        clips={selected}
        rerenderable={renderable.length}
        onDone={onChanged}
        open={templateOpen}
        onOpenChange={setTemplateOpen}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={selected.length === 1 ? "Delete this clip?" : `Delete ${selected.length} clips?`}
        body={`${selected.length === 1 ? `“${selected[0]?.title || "Untitled clip"}” is` : `${selected.length} clips are`} hidden from the project. ${keepWindow.hint(selected.length > 1)} Storage still counts until you delete ${selected.length === 1 ? "it" : "them"} forever.`}
        confirm={selected.length === 1 ? "Delete clip" : "Delete clips"}
        danger
        onConfirm={() => {
          const clips = selected;
          delMany.mutate(
            { projectId, clipIds: clips.map((c) => c.id) },
            {
              onSuccess: (r) => {
                onClear();
                onChanged();
                if (!r.deleted) {
                  toast(r.skipped ? "Those clips were already deleted" : "Nothing deleted");
                  return;
                }
                notifyDeleted({
                  items: clips.map((c) => ({ kind: "clip", id: c.id, title: c.title })),
                  restorable: r.restorable,
                  storedBytes: r.storedBytes,
                });
              },
              onError: (e) => toast.error(e.message),
            },
          );
        }}
      />
    </SelectionBar>
  );
}
