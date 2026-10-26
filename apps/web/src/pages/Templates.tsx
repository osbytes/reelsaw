import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { DELETED_PATH, layerTemplateNameSchema, type TemplateLayer } from "@reelsaw/shared";
import { useTRPC } from "../lib/trpc";
import { useDeletedToast } from "../lib/deletedToast";
import { useRestoreWindow } from "../lib/retention";
import { useHashParams } from "../lib/hash";
import { ago } from "../lib/time";
import { ScrollArea } from "../components/scroll-area";
import { ConfirmDialog, Modal, MoreButton, Skeleton, SkeletonRegion } from "../components/ui";

/** One row of the list (live or deleted), as `layerTemplates.list` returns it. */
interface TemplateRow {
  id: string;
  name: string;
  layers: TemplateLayer[];
  layerCount: number;
  updatedAt: string;
  deletedAt: string | null;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** one column grid: name | layers | updated | actions */
const GRID = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_6rem_8.5rem_8.5rem]";

/**
 * Layer templates (docs/specs/layer-templates.md): sets of layers that fit any clip length. New template opens the
 * template editor; rows offer Edit / Rename / Duplicate / Delete; deleted ones are restorable from Deleted.
 * Deep link: `#template=<id>` highlights a row.
 */
export function TemplatesPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const highlighted = useHashParams().get("template");
  const list = useQuery(trpc.layerTemplates.list.queryOptions());
  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.layerTemplates.list.queryKey() });
  const create = useMutation(trpc.layerTemplates.create.mutationOptions());
  const update = useMutation(trpc.layerTemplates.update.mutationOptions({ onSuccess: () => invalidate() }));
  const remove = useMutation(trpc.layerTemplates.delete.mutationOptions({ onSuccess: () => invalidate() }));
  const restoreWindow = useRestoreWindow("template");
  const notifyDeleted = useDeletedToast();
  const [renaming, setRenaming] = useState<TemplateRow | null>(null);
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState<TemplateRow | null>(null);

  const templates = list.data?.templates ?? [];
  const deleted = list.data?.deleted ?? [];
  const highlight = (id: string) => nav({ pathname: loc.pathname, hash: `#template=${id}` }, { replace: true });

  // a deep-linked row scrolls into view once it is on the page
  useEffect(() => {
    if (!highlighted) return;
    document.getElementById(`template-${highlighted}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlighted, templates.length]);

  const newTemplate = () =>
    create.mutate(
      { name: "Untitled template", layers: [] },
      {
        onSuccess: (t) => {
          void invalidate();
          nav(`/templates/${t.id}`);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  const duplicate = (t: TemplateRow) => {
    const name = layerTemplateNameSchema.safeParse(`${t.name} (copy)`);
    create.mutate(
      { name: name.success ? name.data : t.name, layers: t.layers },
      {
        onSuccess: (c) => {
          void invalidate();
          highlight(c.id);
          toast(`Duplicated as “${c.name}”`);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };
  const openRename = (t: TemplateRow) => {
    setDraft(t.name);
    setRenaming(t);
  };
  const nameOk = layerTemplateNameSchema.safeParse(draft).success;
  const saveRename = () => {
    if (!renaming || !nameOk) return;
    update.mutate(
      { id: renaming.id, name: draft.trim() },
      {
        onSuccess: () => {
          setRenaming(null);
          toast("Renamed");
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  const row = (t: TemplateRow) => {
    const on = highlighted === t.id;
    return (
      <li key={t.id} id={`template-${t.id}`} className={`${GRID} min-h-[3.5rem] rounded-[10px] px-3 py-2 ${on ? "bg-acc-soft" : ""}`}>
        <span className="min-w-0">
          <Link to={`/templates/${t.id}`} className="block truncate text-[14px] font-semibold text-ink no-underline hover:underline">
            {t.name}
          </Link>
          {/* narrow screens fold the layer count and the time into a second line inside the name cell */}
          <span className="block truncate text-xs text-ink3 sm:hidden">
            {plural(t.layerCount, "layer")} · updated {ago(t.updatedAt)}
          </span>
        </span>
        <span className="hidden text-right font-mono text-xs tabular-nums text-ink2 sm:block">{plural(t.layerCount, "layer")}</span>
        <span className="hidden text-xs text-ink3 sm:block">updated {ago(t.updatedAt)}</span>
        <span className="flex items-center justify-end gap-1.5">
          <Link to={`/templates/${t.id}`} className="btn-ghost w-[4.5rem] justify-center text-xs no-underline">
            Edit
          </Link>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <MoreButton aria-label={`Actions for ${t.name}`} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className="menu w-[220px]">
                <DropdownMenu.Item className="menu-item" onSelect={() => openRename(t)}>
                  Rename…
                </DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" disabled={create.isPending} onSelect={() => duplicate(t)}>
                  Duplicate
                </DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item-danger" onSelect={() => setConfirm(t)}>
                  Delete…
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </span>
      </li>
    );
  };

  const header = (
    <li aria-hidden className={`${GRID} hidden px-3 pb-1 text-xs text-ink3 sm:grid`}>
      <span>Name</span>
      <span className="text-right">Layers</span>
      <span>Updated</span>
      <span />
    </li>
  );

  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex max-w-[1180px] flex-col gap-6 px-4 py-7 sm:px-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-[28px] font-bold tracking-tight">Templates</h1>
            <p className="mt-1 min-h-5 text-sm text-ink2">Logos, stickers, text and sounds placed once, fitted to any clip length</p>
          </div>
          <button className="btn-primary min-w-[9.5rem] justify-center" disabled={create.isPending} onClick={newTemplate}>
            {create.isPending && !create.variables?.layers.length ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} New template
          </button>
        </div>

        <section className="flex flex-col gap-1 text-[13px]">
          {list.isPending && !list.error && (
            <SkeletonRegion label="Loading templates…" className="flex flex-col gap-1">
              {["w-1/3", "w-1/4", "w-2/5"].map((w, i) => (
                <div key={i} className={`${GRID} min-h-[3.5rem] px-3 py-2`}>
                  <Skeleton className={`h-4 ${w}`} />
                  <Skeleton className="hidden h-3.5 w-14 justify-self-end sm:block" />
                  <Skeleton className="hidden h-3.5 w-24 sm:block" />
                  <span className="flex justify-end gap-1.5">
                    <Skeleton className="h-8 w-[4.5rem] rounded-[10px]" />
                    <Skeleton className="h-8 w-8 rounded-[10px]" />
                  </span>
                </div>
              ))}
            </SkeletonRegion>
          )}
          {list.error && <p className="text-err">✕ {list.error.message}</p>}
          {list.data && templates.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-[16px] border border-dashed border-line2 px-5 py-10 text-center">
              <Layers className="h-6 w-6 text-ink3" aria-hidden />
              <b className="text-[15px]">No templates yet</b>
              <p className="max-w-[440px] text-[13px] leading-relaxed text-ink2">
                A template is a set of layers (a logo in the first seconds, a call to action at the end, a music bed) that fits any clip. Make one here, or save a clip’s layers as a template from the clip editor.
              </p>
            </div>
          )}
          {templates.length > 0 && (
            <ul className="flex flex-col gap-1">
              {header}
              {templates.map((t) => row(t))}
            </ul>
          )}
        </section>

        {deleted.length > 0 && (
          <p className="text-xs text-ink3">
            {plural(deleted.length, "deleted template")} restorable from{" "}
            <Link to={DELETED_PATH} className="text-acc-text no-underline hover:underline">
              Deleted
            </Link>
            {restoreWindow.restorable ? ` ${restoreWindow.restorable}` : ""}.
          </p>
        )}
      </main>

      <Modal open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)} title="Rename template">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            saveRename();
          }}
        >
          <input className="input" autoFocus value={draft} maxLength={120} aria-label="Template name" onChange={(e) => setDraft(e.target.value)} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setRenaming(null)}>
              Cancel
            </button>
            <button type="submit" className="btn-primary min-w-[5.5rem] justify-center" disabled={!nameOk || update.isPending}>
              {update.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Save
            </button>
          </div>
        </form>
      </Modal>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete this template?"
        body={<>“{confirm?.name}” is deleted from your templates and from your project defaults. Clips that already have its layers keep them. {restoreWindow.hint()}</>}
        confirm="Delete"
        danger
        onConfirm={() => {
          const t = confirm;
          if (!t) return;
          remove.mutate(
            { id: t.id },
            {
              onSuccess: (r) => {
                if (r.clearedDefault) toast(`“${t.name}” is no longer the default for new projects`);
                notifyDeleted({ items: [{ kind: "template", id: t.id, title: t.name }], restorable: restoreWindow.restorable });
              },
              onError: (err) => toast.error(err.message),
            },
          );
        }}
      />
    </ScrollArea>
  );
}
