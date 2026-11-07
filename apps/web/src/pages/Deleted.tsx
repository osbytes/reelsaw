import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { formatBytes, type DeletedKind } from "@reelsaw/shared";
import { useTRPC } from "../lib/trpc";
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
  LIST_REVEAL_ROW,
  ListTable,
} from "../components/ListPage";
import { SelectionBar } from "../components/SelectionBar";
import { ConfirmDialog, MoreButton, Skeleton } from "../components/ui";
import { QuotaNotice, quotaFromError } from "../components/QuotaNotice";
import { ForgetDecisionsOption } from "../components/ForgetDecisionsOption";

const KIND_LABEL: Record<DeletedKind, string> = { project: "Project", clip: "Clip", asset: "Library item", template: "Template" };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const dateFmt: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
const keyOf = (kind: DeletedKind, id: string) => `${kind}:${id}`;
/** The first per-item reason of a partly failed bulk restore / delete forever, so the toast says why. */
const firstError = (results: Array<{ ok: boolean; error?: string }>) => {
  const e = results.find((x) => !x.ok && x.error)?.error;
  return e ? `: ${e.slice(0, 160)}` : "";
};

/**
 * When the row is deleted forever, as a countdown (GitLab's "pending deletion", Immich's days left):
 * "in 3 days" reads faster than a date. The date itself is the cell's tooltip (`foreverDate`).
 */
function foreverWhen(purgeAt: string | null) {
  if (!purgeAt) return "when you choose";
  const days = Math.ceil((new Date(purgeAt).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return "within the hour";
  return days === 1 ? "within a day" : `in ${days} days`;
}

function foreverDate(purgeAt: string | null) {
  return purgeAt ? `Deleted forever on ${new Date(purgeAt).toLocaleDateString(undefined, dateFmt)}` : undefined;
}

type Row = {
  kind: DeletedKind;
  id: string;
  title: string;
  deletedAt: string;
  purgeAt: string | null;
  storedBytes: number;
  canPurge: boolean;
  projectTitle?: string;
  assetKind?: string;
  usedBy?: number;
  usedByClips?: number;
  usedByTemplates?: number;
  layerCount?: number;
  forgetDecisions?: boolean;
};

function whyHeld(r: Row) {
  if (r.canPurge) return undefined;
  if (r.usedByTemplates) return "A layer template still names this item";
  return "A project or clip still names this item";
}

const sizeOf = (r: Row) => (r.storedBytes ? formatBytes(r.storedBytes) : r.kind === "template" ? plural(r.layerCount ?? 0, "layer") : "no files");

/** The line under the title: what the columns have no place for. */
function noteOf(r: Row) {
  const extra = r.kind === "clip" ? r.projectTitle : r.kind === "asset" ? r.assetKind : undefined;
  return [extra, whyHeld(r), r.forgetDecisions ? "forgets what Reelsaw learned from it" : undefined].filter(Boolean).join(" · ");
}

/** Below the fold width the columns go on that line too. */
function foldedLine(r: Row) {
  const forever = r.purgeAt ? `deleted forever ${foreverWhen(r.purgeAt)}` : "kept until you delete it forever";
  return [KIND_LABEL[r.kind], noteOf(r), sizeOf(r), `deleted ${ago(r.deletedAt)}`, forever].filter(Boolean).join(" · ");
}

/**
 * Restorable deletes in one selectable list: projects, clips of live projects, library items and
 * templates. Each row says when it was deleted and when it is deleted forever. The header checkbox stays
 * visible. A row's checkbox appears on hover (always on a coarse pointer); a checked row keeps its
 * checkbox, and its hit target fills the whole cell. Deep links: `#project=id` (also clip, asset, template).
 */
export function DeletedPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const hash = useHashParams();
  const list = useQuery({ ...trpc.deleted.list.queryOptions(), retry: false });
  const restore = useMutation(trpc.deleted.restore.mutationOptions());
  const purge = useMutation(trpc.deleted.purge.mutationOptions());
  const [sel, setSel] = useState<string[]>([]);
  const [pending, setPending] = useState<Row[] | null>(null);
  const [forgetDecisions, setForgetDecisions] = useState(false);

  const highlightedKind = (["project", "clip", "asset", "template"] as const).find((k) => hash.get(k));
  const highlightedId = highlightedKind ? hash.get(highlightedKind) : "";
  const highlighted = highlightedKind && highlightedId ? keyOf(highlightedKind, highlightedId) : "";

  const items = list.data?.items ?? [];
  const selected = useMemo(() => items.filter((r) => sel.includes(keyOf(r.kind, r.id))), [items, sel]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: trpc.deleted.list.queryKey() });
    void qc.invalidateQueries({ queryKey: trpc.projects.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.library.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.layerTemplates.pathKey() });
  };
  useEffect(() => {
    if (!highlightedId) return;
    document.getElementById(`deleted-${highlightedId}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlightedId, list.data]);
  useEffect(() => {
    const live = new Set(items.map((r) => keyOf(r.kind, r.id)));
    setSel((cur) => (cur.every((x) => live.has(x)) ? cur : cur.filter((x) => live.has(x))));
  }, [items]);

  const toggle = (r: Row) => {
    const k = keyOf(r.kind, r.id);
    setSel((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  };

  const onRestore = (rows: Row[]) => {
    restore.mutate(
      { items: rows.map((r) => ({ kind: r.kind, id: r.id })) },
      {
        onSuccess: (r) => {
          refresh();
          setSel([]);
          toast(
            r.failed
              ? `Restored ${r.restored} · ${r.failed} couldn’t be restored${firstError(r.results)}`
              : rows.length === 1
                ? `Restored “${rows[0]!.title}”`
                : `Restored ${rows.length} items`,
          );
        },
        onError: (err) => {
          const quota = quotaFromError(err);
          toast.error(quota ? <QuotaNotice message={err.message} quota={quota} /> : err.message);
        },
      },
    );
  };

  const data = list.data;
  const empty = !!data && items.length === 0;
  const allKeys = items.map((r) => keyOf(r.kind, r.id));
  const allOn = allKeys.length > 0 && allKeys.every((k) => sel.includes(k));
  const held = selected.filter((r) => !r.canPurge);
  const busy = restore.isPending || purge.isPending;

  const columns: ListColumn[] = [
    {
      label: (
        <label className="absolute inset-0 flex cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--acc)]"
            checked={allOn}
            disabled={!allKeys.length}
            onChange={() => setSel(allOn ? [] : allKeys)}
            aria-label={allOn ? "Clear selection" : "Select all"}
          />
        </label>
      ),
      width: "w-11",
    },
    { label: "Name" },
    { label: "Kind", width: "min-[1040px]:w-[6.5rem]", full: true },
    { label: "Size", width: "min-[1040px]:w-[5.5rem]", full: true, right: true },
    { label: "Deleted", width: "min-[1040px]:w-[6.5rem]", full: true },
    { label: "Deleted forever", width: "min-[1040px]:w-32", full: true },
    { label: null, srLabel: "Actions", width: LIST_ACTIONS_WIDTH },
  ];
  const total = data?.total ?? items.length;

  return (
    <ListPage
      title="Deleted"
      subtitle={
        <>
          Restore something, or delete it forever to free storage. Each row says when it was deleted and when it is deleted forever
          {data && data.keepDays > 0
            ? ` (projects and clips after ${plural(data.keepDays, "day")}, library and templates after ${plural(data.libraryDays, "day")})`
            : ""}
          .
        </>
      }
    >
      {list.error && <ListError message={list.error.message} />}

      {data && empty && (
        <ListEmpty icon={Trash2} title="Nothing waiting">
          Deleted projects, clips, library items and templates show up here until you restore them or delete them forever.
        </ListEmpty>
      )}

      {(items.length > 0 || (list.isPending && !list.error)) && (
        <section className="flex flex-col gap-2">
          <ListTable caption="Deleted items you can restore" columns={columns} loading={list.isPending} loadingLabel="Loading deleted items…">
            {list.isPending &&
              Array.from({ length: LIST_SKELETON_ROWS }, (_, i) => (
                <ListRow key={i} skeleton>
                  <ListCell>
                    <Skeleton className="mx-auto h-4 w-4 rounded" />
                  </ListCell>
                  <ListCell>
                    <Skeleton className={`h-4 ${["w-1/3", "w-2/5", "w-1/4", "w-1/2", "w-1/3"][i]}`} />
                    <Skeleton className="mt-1.5 h-3 w-3/5 min-[1040px]:hidden" />
                  </ListCell>
                  <ListCell full>
                    <Skeleton className="h-3.5 w-14" />
                  </ListCell>
                  <ListCell full>
                    <Skeleton className="ml-auto h-3.5 w-10" />
                  </ListCell>
                  <ListCell full>
                    <Skeleton className="h-3.5 w-14" />
                  </ListCell>
                  <ListCell full>
                    <Skeleton className="h-3.5 w-16" />
                  </ListCell>
                  <ListCell>
                    <Skeleton className="ml-auto h-8 w-8 rounded-[8px] min-[1040px]:w-full" />
                  </ListCell>
                </ListRow>
              ))}
            {items.map((r) => {
              const k = keyOf(r.kind, r.id);
              const checked = sel.includes(k);
              const note = noteOf(r);
              return (
                <ListRow key={k} id={`deleted-${r.id}`} active={highlighted === k || checked}>
                  <ListCell className="relative !p-0">
                    <label
                      className={`absolute inset-0 flex cursor-pointer items-center justify-center ${checked ? "opacity-100" : "opacity-0"} ${LIST_REVEAL_ROW}`}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--acc)]"
                        checked={checked}
                        onChange={() => toggle(r)}
                        aria-label={`Select ${r.title}`}
                      />
                    </label>
                  </ListCell>
                  <ListCell>
                    <div className={LIST_TITLE}>{r.title}</div>
                    {note && <div className={`${LIST_SUB} hidden min-[1040px]:block`}>{note}</div>}
                    <div className={`${LIST_SUB} min-[1040px]:hidden`} title={foreverDate(r.purgeAt)}>
                      {foldedLine(r)}
                    </div>
                  </ListCell>
                  <ListCell full variant="muted">
                    {KIND_LABEL[r.kind]}
                  </ListCell>
                  <ListCell full variant="num">
                    {sizeOf(r)}
                  </ListCell>
                  <ListCell full variant="muted">
                    {ago(r.deletedAt)}
                  </ListCell>
                  <ListCell full variant="muted" title={foreverDate(r.purgeAt)}>
                    {foreverWhen(r.purgeAt)}
                  </ListCell>
                  <ListCell variant="actions">
                    <div className="flex items-center justify-end gap-1.5">
                      <button type="button" className={`btn-ghost w-[5.5rem] ${LIST_ACTION}`} disabled={busy} onClick={() => onRestore([r])}>
                        Restore
                      </button>
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <MoreButton aria-label={`More actions for ${r.title}`} />
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className={LIST_MENU}>
                            <DropdownMenu.Item className={LIST_MENU_ITEM_FOLDED} disabled={busy} onSelect={() => onRestore([r])}>
                              Restore
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              className="menu-item-danger"
                              disabled={!r.canPurge || busy}
                              title={whyHeld(r)}
                              onSelect={() => r.canPurge && setPending([r])}
                            >
                              Delete forever…
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    </div>
                  </ListCell>
                </ListRow>
              );
            })}
          </ListTable>
          <ListFooter>
            {list.isPending ? (
              <Skeleton className="h-3 w-40" />
            ) : (
              `Showing ${items.length.toLocaleString()} of ${total.toLocaleString()} item${total === 1 ? "" : "s"}`
            )}
          </ListFooter>
          {selected.length > 0 && (
            <SelectionBar label="Selected deletions" count={selected.length} onClear={() => setSel([])}>
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => onRestore(selected)}>
                Restore
              </button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <MoreButton aria-label="More actions for the selection" />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content side="top" align="end" sideOffset={8} className={LIST_MENU}>
                    <DropdownMenu.Item
                      className="menu-item-danger"
                      disabled={busy || held.length === selected.length}
                      title={
                        held.length === selected.length
                          ? "None of the selected items can be deleted forever yet"
                          : held.length
                            ? `${plural(held.length, "item")} still in use will be skipped`
                            : undefined
                      }
                      onSelect={() => setPending(selected.filter((r) => r.canPurge))}
                    >
                      Delete forever…
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </SelectionBar>
          )}
        </section>
      )}
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => {
          if (!o) setPending(null);
          setForgetDecisions(false);
        }}
        title={pending && pending.length > 1 ? `Delete ${pending.length} items forever?` : "Delete forever?"}
        body={
          pending && pending.length > 1 ? (
            <>
              {plural(pending.length, "item")} and their files are deleted permanently
              {pending.reduce((n, r) => n + r.storedBytes, 0) ? ` (${formatBytes(pending.reduce((n, r) => n + r.storedBytes, 0))} freed)` : ""}. This cannot be
              undone.
            </>
          ) : pending?.[0]?.kind === "project" ? (
            <>
              “{pending[0].title}” and its files are deleted permanently
              {pending[0].storedBytes ? ` (${formatBytes(pending[0].storedBytes)} freed)` : ""}. Minutes already used stay counted. This cannot be undone.
            </>
          ) : pending?.[0]?.kind === "clip" ? (
            <>
              “{pending[0].title}” and its rendered file are deleted permanently
              {pending[0].storedBytes ? ` (${formatBytes(pending[0].storedBytes)} freed)` : ""}. This cannot be undone.
            </>
          ) : pending?.[0]?.kind === "asset" ? (
            <>
              “{pending[0].title}” and its files are deleted permanently
              {pending[0].storedBytes ? ` (${formatBytes(pending[0].storedBytes)} freed)` : ""}. This cannot be undone.
            </>
          ) : (
            <>“{pending?.[0]?.title}” is deleted permanently. Clips that already have its layers keep them. This cannot be undone.</>
          )
        }
        confirm="Delete forever"
        danger
        onConfirm={() => {
          const rows = pending;
          if (!rows?.length) return;
          purge.mutate(
            { items: rows.map((r) => ({ kind: r.kind, id: r.id })), forgetDecisions: forgetDecisions && rows.some((r) => r.kind === "project") },
            {
              onSuccess: (r) => {
                setPending(null);
                setSel([]);
                refresh();
                toast(
                  r.failed
                    ? `Deleted ${r.purged} forever · ${r.failed} couldn’t be deleted${firstError(r.results)}`
                    : r.storedBytes
                      ? `Deleted forever · ${formatBytes(r.storedBytes)} freed`
                      : rows.length === 1
                        ? `Deleted “${rows[0]!.title}” forever`
                        : `Deleted ${rows.length} items forever`,
                );
              },
              onError: (err) => toast.error(err.message),
            },
          );
        }}
      >
        {/* projects deleted with "forget" already go with their decisions; offer it only for the others */}
        {pending?.some((r) => r.kind === "project" && !r.forgetDecisions) && <ForgetDecisionsOption checked={forgetDecisions} onChange={setForgetDecisions} />}
      </ConfirmDialog>
    </ListPage>
  );
}
