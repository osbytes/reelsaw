import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { DELETED_PATH, layerTemplateNameSchema, type TemplateBumpers, type TemplateLayer } from "@reelsaw/shared";
import { templateSummary } from "../components/TemplatePicker";
import { useTRPC } from "../lib/trpc";
import { useDeletedToast } from "../lib/deletedToast";
import { useRestoreWindow } from "../lib/retention";
import { useHashParams } from "../lib/hash";
import { ago } from "../lib/time";
import {
  LIST_ACTION,
  LIST_ACTIONS_WIDTH,
  LIST_MENU,
  LIST_MENU_ITEM_FOLDED,
  LIST_SKELETON_ROWS,
  LIST_SUB,
  LIST_TITLE,
  ListCell,
  type ListColumn,
  ListEmpty,
  ListError,
  ListFooter,
  ListPage,
  ListRow,
  ListTable,
} from "../components/ListPage";
import { ConfirmDialog, Modal, MoreButton, Skeleton } from "../components/ui";

/** One row of the list (live or deleted), as `layerTemplates.list` returns it. */
interface TemplateRow {
  id: string;
  name: string;
  layers: TemplateLayer[];
  layerCount: number;
  bumpers: TemplateBumpers | null;
  updatedAt: string;
  deletedAt: string | null;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** name | what it holds (layers, intro / outro) | updated | actions */
const COLUMNS: ListColumn[] = [
  { label: "Name" },
  { label: "Layers", width: "min-[1040px]:w-52", full: true, right: true },
  { label: "Updated", width: "min-[1040px]:w-[6.5rem]", full: true },
  { label: null, srLabel: "Actions", width: LIST_ACTIONS_WIDTH },
];

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
  const list = useQuery(trpc.layerTemplates.list.queryOptions({ limit: 500 }));
  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.layerTemplates.list.queryKey() });
  const create = useMutation(trpc.layerTemplates.create.mutationOptions());
  const update = useMutation(trpc.layerTemplates.update.mutationOptions({ onSuccess: () => invalidate() }));
  const remove = useMutation(trpc.layerTemplates.delete.mutationOptions({ onSuccess: () => invalidate() }));
  const restoreWindow = useRestoreWindow("template");
  const notifyDeleted = useDeletedToast();
  const [renaming, setRenaming] = useState<TemplateRow | null>(null);
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState<TemplateRow | null>(null);

  const templates = list.data?.items ?? [];
  const totalTemplates = list.data?.total ?? templates.length;
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

  const row = (t: TemplateRow) => (
    <ListRow key={t.id} id={`template-${t.id}`} active={highlighted === t.id}>
      <ListCell>
        <Link to={`/templates/${t.id}`} className={`block no-underline hover:underline ${LIST_TITLE}`}>
          {t.name}
        </Link>
        {/* below the fold width the layer count and the time go on a second line inside the name cell */}
        <div className={`${LIST_SUB} min-[1040px]:hidden`}>
          {templateSummary(t)} · updated {ago(t.updatedAt)}
        </div>
      </ListCell>
      <ListCell full variant="num" className="truncate" title={templateSummary(t)}>
        {templateSummary(t)}
      </ListCell>
      <ListCell full variant="muted">
        {ago(t.updatedAt)}
      </ListCell>
      <ListCell variant="actions">
        <div className="flex items-center justify-end gap-1.5">
          <Link to={`/templates/${t.id}`} className={`btn-ghost w-[5.5rem] ${LIST_ACTION}`}>
            Edit
          </Link>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <MoreButton aria-label={`More actions for ${t.name}`} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className={LIST_MENU}>
                <DropdownMenu.Item className={LIST_MENU_ITEM_FOLDED} onSelect={() => nav(`/templates/${t.id}`)}>
                  Edit
                </DropdownMenu.Item>
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
        </div>
      </ListCell>
    </ListRow>
  );

  return (
    <ListPage
      title="Templates"
      subtitle="Logos, stickers, text and sounds placed once, fitted to any clip length"
      actions={
        <button className="btn-primary min-w-[9.5rem] justify-center" disabled={create.isPending} onClick={newTemplate}>
          {create.isPending && !create.variables?.layers.length ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} New template
        </button>
      }
    >
      {list.error && <ListError message={list.error.message} />}
      {list.data && templates.length === 0 && (
        <ListEmpty icon={Layers} title="No templates yet">
          A template is a set of layers (a logo in the first seconds, a call to action at the end, a music bed) that fits any clip. Make one here, or save a
          clip’s layers as a template from the clip editor.
        </ListEmpty>
      )}
      {(templates.length > 0 || (list.isPending && !list.error)) && (
        <section className="flex flex-col gap-2">
          <ListTable caption="Your layer templates" columns={COLUMNS} loading={list.isPending} loadingLabel="Loading templates…">
            {list.isPending &&
              Array.from({ length: LIST_SKELETON_ROWS }, (_, i) => (
                <ListRow key={i} skeleton>
                  <ListCell>
                    <Skeleton className={`h-4 ${["w-1/3", "w-1/4", "w-2/5", "w-1/2", "w-1/3"][i]}`} />
                    <Skeleton className="mt-1.5 h-3 w-3/5 min-[1040px]:hidden" />
                  </ListCell>
                  <ListCell full>
                    <Skeleton className="ml-auto h-3.5 w-14" />
                  </ListCell>
                  <ListCell full>
                    <Skeleton className="h-3.5 w-14" />
                  </ListCell>
                  <ListCell>
                    <Skeleton className="ml-auto h-8 w-8 rounded-[8px] min-[1040px]:w-full" />
                  </ListCell>
                </ListRow>
              ))}
            {templates.map((t) => row(t))}
          </ListTable>
          <ListFooter>
            {list.isPending ? (
              <Skeleton className="h-3 w-40" />
            ) : (
              `Showing ${templates.length.toLocaleString()} of ${totalTemplates.toLocaleString()} template${totalTemplates === 1 ? "" : "s"}`
            )}
          </ListFooter>
        </section>
      )}

      {deleted.length > 0 && (
        <p className="text-xs text-ink3">
          {plural(deleted.length, "deleted template")} restorable from{" "}
          <Link to={DELETED_PATH} className="text-acc-text no-underline hover:underline">
            Deleted
          </Link>
          {restoreWindow.restorable ? ` ${restoreWindow.restorable}` : ""}.
        </p>
      )}

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
        body={
          <>
            “{confirm?.name}” is deleted from your templates and from your project defaults. Clips that already have its layers keep them.{" "}
            {restoreWindow.hint()}
          </>
        }
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
    </ListPage>
  );
}
