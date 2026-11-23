import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { plural } from "@lingui/core/macro";
import { toast } from "sonner";
import { useTRPC } from "../lib/trpc";
import { clipsText } from "../lib/clipMeta";
import { useDeletedToast } from "../lib/deletedToast";
import { BulkBumpersPopover } from "./BumperField";
import { SelectionBar } from "./SelectionBar";
import { BulkTemplateButton } from "./TemplatePicker";
import { MoreButton } from "./ui";
import { useCopyShareLink } from "./ShareLinks";
import { Trans, useLingui } from "@lingui/react/macro";

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
  const { t } = useLingui();
  const trpc = useTRPC();
  const many = useMutation(trpc.clips.rerenderMany.mutationOptions());
  const delMany = useMutation(trpc.clips.deleteMany.mutationOptions());
  const notifyDeleted = useDeletedToast();
  // a soft delete of the selection: done at once, and the toast's Undo brings every one back (no dialog first)
  const deleteSelected = () => {
    const clips = selected;
    delMany.mutateAsync({ projectId, clipIds: clips.map((c) => c.id) }).then(
      (r) => {
        onClear();
        onChanged();
        if (!r.deleted) {
          toast(r.skipped ? t`Those clips were already deleted` : t`Nothing deleted`);
          return;
        }
        notifyDeleted({
          items: clips.map((c) => ({ kind: "clip", id: c.id, title: c.title })),
          restorable: r.restorable,
          storedBytes: r.storedBytes,
        });
      },
      (err: Error) => {
        const reason = err.message.slice(0, 120);
        toast.error(t`Couldn’t delete: ${reason}`);
      },
    );
  };
  const [bumpersOpen, setBumpersOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const done = selected.filter((c) => c.status === "done");
  const failed = selected.filter((c) => c.status === "failed");
  const renderable = selected.filter((c) => c.status === "done" || c.status === "failed");
  const run = (clips: BatchClip[], what: "rerender" | "retry") =>
    many.mutate(
      { projectId, clipIds: clips.map((c) => c.id) },
      {
        onSuccess: (r) => {
          onChanged();
          const count = r.rerendered;
          const skipped = r.skipped;
          const head =
            what === "retry"
              ? t`Retrying ${plural(count, { one: "# clip", other: "# clips" })}`
              : t`Re-rendering ${plural(count, { one: "# clip", other: "# clips" })}`;
          toast(skipped ? t`${head} · ${skipped} skipped (still rendering)` : head);
        },
        onError: (e) => toast.error(e.message),
      },
    );
  const copyAll = () =>
    navigator.clipboard
      .writeText(clipsText(selected))
      .then(() => toast(plural(selected.length, { one: "Title, caption + hashtags of # clip copied", other: "Title, caption + hashtags of # clips copied" })))
      .catch(() => toast.error(t`Couldn’t copy`));
  const copyShareLink = useCopyShareLink();
  const exportHref = `/api/projects/${projectId}/export.zip?clips=${done.map((c) => c.id).join(",")}`;
  const later = (fn: () => void) => window.setTimeout(fn, 0);

  return (
    <SelectionBar label={t`Selected clips`} count={selected.length} busy={many.isPending || delMany.isPending} onClear={onClear}>
      <button
        className="btn-ghost"
        disabled={!renderable.length || many.isPending}
        title={
          renderable.length
            ? plural(renderable.length, { one: "Re-render # clip", other: "Re-render # clips" })
            : t`None of the selected clips is rendered or failed`
        }
        onClick={() => run(renderable, "rerender")}
      >
        <Trans>Re-render</Trans>
      </button>
      {done.length ? (
        <a
          className="btn-ghost"
          href={exportHref}
          title={plural(done.length, {
            one: "Download a zip of # clip with YouTube and TikTok metadata",
            other: "Download a zip of # clips with YouTube and TikTok metadata",
          })}
        >
          <Trans>Export</Trans>
        </a>
      ) : (
        <button className="btn-ghost" disabled title={t`None of the selected clips is rendered yet`}>
          <Trans>Export</Trans>
        </button>
      )}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <MoreButton aria-label={t`More actions for the selection`} />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content side="top" align="end" sideOffset={8} className="menu w-[220px]">
            <DropdownMenu.Item className="menu-item" onSelect={() => void copyAll()}>
              <Trans>Copy text</Trans>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="menu-item"
              disabled={!done.length}
              title={
                done.length ? t`A link anyone can download the zip of these clips from, without signing in` : t`None of the selected clips is rendered yet`
              }
              onSelect={() =>
                copyShareLink(
                  { kind: "export", projectId, clipIds: done.map((c) => c.id) },
                  plural(done.length, { one: "a zip of # clip", other: "a zip of # clips" }),
                )
              }
            >
              <Trans>Copy link to zip</Trans>
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => later(() => setBumpersOpen(true))}>
              <Trans>Intro / outro…</Trans>
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item" onSelect={() => later(() => setTemplateOpen(true))}>
              <Trans>Layer template…</Trans>
            </DropdownMenu.Item>
            {failed.length > 0 && (
              <DropdownMenu.Item className="menu-item" disabled={many.isPending} onSelect={() => run(failed, "retry")}>
                <Trans>Retry failed ({failed.length})</Trans>
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Separator className="mx-1.5 my-1 h-px bg-line" />
            <DropdownMenu.Item className="menu-item-danger" disabled={delMany.isPending} onSelect={() => later(deleteSelected)}>
              <Trans>Delete</Trans>
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
    </SelectionBar>
  );
}
