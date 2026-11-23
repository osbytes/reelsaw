import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { formatBytes, formatDay, type DeletedKind } from "@reelsaw/shared";
import { plural, t } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
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
  showingCount,
} from "../components/ListPage";
import { SelectionBar } from "../components/SelectionBar";
import { ConfirmDialog, MoreButton, Skeleton } from "../components/ui";
import { QuotaNotice, quotaFromError } from "../components/QuotaNotice";
import { ForgetDecisionsOption } from "../components/ForgetDecisionsOption";
import { pageTitle, useDocumentTitle } from "../lib/title";

function kindLabel(kind: DeletedKind): string {
  return { project: t`Project`, clip: t`Clip`, asset: t`Library item`, template: t`Template` }[kind];
}
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
  if (!purgeAt) return t`when you choose`;
  const days = Math.ceil((new Date(purgeAt).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return t`within the hour`;
  return days === 1 ? t`within a day` : t`in ${days} days`;
}

function foreverDate(purgeAt: string | null) {
  if (!purgeAt) return undefined;
  const day = formatDay(purgeAt, { month: "short" });
  return t`Deleted forever on ${day}`;
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

/** " (12 MB freed)" after a sentence about deleting forever; nothing when no files are stored. */
function freed(bytes: number) {
  if (!bytes) return "";
  const size = formatBytes(bytes);
  return t` (${size} freed)`;
}

function whyHeld(r: Row) {
  if (r.canPurge) return undefined;
  if (r.usedByTemplates) return t`A layer template still names this item`;
  return t`A project or clip still names this item`;
}

const sizeOf = (r: Row) =>
  r.storedBytes ? formatBytes(r.storedBytes) : r.kind === "template" ? plural(r.layerCount ?? 0, { one: "# layer", other: "# layers" }) : t`no files`;

/** The line under the title: what the columns have no place for. */
function noteOf(r: Row) {
  const extra = r.kind === "clip" ? r.projectTitle : r.kind === "asset" ? r.assetKind : undefined;
  return [extra, whyHeld(r), r.forgetDecisions ? t`forgets what Reelsaw learned from it` : undefined].filter(Boolean).join(" · ");
}

/** Below the fold width the columns go on that line too. */
function foldedLine(r: Row) {
  const when = foreverWhen(r.purgeAt);
  const forever = r.purgeAt ? t`deleted forever ${when}` : t`kept until you delete it forever`;
  const deletedAgo = ago(r.deletedAt);
  return [kindLabel(r.kind), noteOf(r), sizeOf(r), t`deleted ${deletedAgo}`, forever].filter(Boolean).join(" · ");
}

/**
 * Restorable deletes in one selectable list: projects, clips of live projects, library items and
 * templates. Each row says when it was deleted and when it is deleted forever. The header checkbox stays
 * visible. A row's checkbox appears on hover (always on a coarse pointer); a checked row keeps its
 * checkbox, and its hit target fills the whole cell. Deep links: `#project=id` (also clip, asset, template).
 */
export function DeletedPage() {
  const { t } = useLingui();
  useDocumentTitle(pageTitle(t`Deleted`));
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
          const why = firstError(r.results);
          const title = rows[0]!.title;
          const count = rows.length;
          toast(
            r.failed
              ? t`Restored ${r.restored} · ${r.failed} couldn’t be restored${why}`
              : rows.length === 1
                ? t`Restored “${title}”`
                : t`Restored ${count} items`,
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
            aria-label={allOn ? t`Clear selection` : t`Select all`}
          />
        </label>
      ),
      width: "w-11",
    },
    { label: t`Name` },
    { label: t`Kind`, width: "min-[1040px]:w-[6.5rem]", full: true },
    { label: t`Size`, width: "min-[1040px]:w-[5.5rem]", full: true, right: true },
    { label: t`Deleted`, width: "min-[1040px]:w-[6.5rem]", full: true },
    { label: t`Deleted forever`, width: "min-[1040px]:w-32", full: true },
    { label: null, srLabel: t`Actions`, width: LIST_ACTIONS_WIDTH },
  ];
  const total = data?.total ?? items.length;

  return (
    <ListPage
      title={t`Deleted`}
      subtitle={
        data && data.keepDays > 0 ? (
          <Trans>
            Restore something, or delete it forever to free storage. Each row says when it was deleted and when it is deleted forever (projects and clips after{" "}
            <Plural value={data.keepDays} one="# day" other="# days" />, library and templates after{" "}
            <Plural value={data.libraryDays} one="# day" other="# days" />
            ).
          </Trans>
        ) : (
          <Trans>Restore something, or delete it forever to free storage. Each row says when it was deleted and when it is deleted forever.</Trans>
        )
      }
    >
      {list.error && <ListError message={list.error.message} />}

      {data && empty && (
        <ListEmpty icon={Trash2} title={t`Nothing waiting`}>
          <Trans>Deleted projects, clips, library items and templates show up here until you restore them or delete them forever.</Trans>
        </ListEmpty>
      )}

      {(items.length > 0 || (list.isPending && !list.error)) && (
        <section className="flex flex-col gap-2">
          <ListTable caption={t`Deleted items you can restore`} columns={columns} loading={list.isPending} loadingLabel={t`Loading deleted items…`}>
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
                    <Skeleton className="ms-auto h-3.5 w-10" />
                  </ListCell>
                  <ListCell full>
                    <Skeleton className="h-3.5 w-14" />
                  </ListCell>
                  <ListCell full>
                    <Skeleton className="h-3.5 w-16" />
                  </ListCell>
                  <ListCell>
                    <Skeleton className="ms-auto h-8 w-8 rounded-[8px] min-[1040px]:w-full" />
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
                        aria-label={t`Select ${r.title}`}
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
                    {kindLabel(r.kind)}
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
                        <Trans>Restore</Trans>
                      </button>
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <MoreButton aria-label={t`More actions for ${r.title}`} />
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className={LIST_MENU}>
                            <DropdownMenu.Item className={LIST_MENU_ITEM_FOLDED} disabled={busy} onSelect={() => onRestore([r])}>
                              <Trans>Restore</Trans>
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              className="menu-item-danger"
                              disabled={!r.canPurge || busy}
                              title={whyHeld(r)}
                              onSelect={() => r.canPurge && setPending([r])}
                            >
                              <Trans>Delete forever…</Trans>
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
            {list.isPending ? <Skeleton className="h-3 w-40" /> : showingCount(items.length, total, (n) => plural(n, { one: "item", other: "items" }))}
          </ListFooter>
          {selected.length > 0 && (
            <SelectionBar label={t`Selected deletions`} count={selected.length} busy={busy} onClear={() => setSel([])}>
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => onRestore(selected)}>
                <Trans>Restore</Trans>
              </button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <MoreButton aria-label={t`More actions for the selection`} />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content side="top" align="end" sideOffset={8} className={LIST_MENU}>
                    <DropdownMenu.Item
                      className="menu-item-danger"
                      disabled={busy || held.length === selected.length}
                      title={
                        held.length === selected.length
                          ? t`None of the selected items can be deleted forever yet`
                          : held.length
                            ? plural(held.length, { one: "# item still in use will be skipped", other: "# items still in use will be skipped" })
                            : undefined
                      }
                      onSelect={() => setPending(selected.filter((r) => r.canPurge))}
                    >
                      <Trans>Delete forever…</Trans>
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
        title={pending && pending.length > 1 ? t`Delete ${pending.length} items forever?` : t`Delete forever?`}
        body={
          pending && pending.length > 1 ? (
            <Trans>
              <Plural value={pending.length} one="# item" other="# items" /> and their files are deleted permanently
              {freed(pending.reduce((n, r) => n + r.storedBytes, 0))}. This cannot be undone.
            </Trans>
          ) : pending?.[0]?.kind === "project" ? (
            <Trans>
              “{pending[0].title}” and its files are deleted permanently
              {freed(pending[0].storedBytes)}. Minutes already used stay counted. This cannot be undone.
            </Trans>
          ) : pending?.[0]?.kind === "clip" ? (
            <Trans>
              “{pending[0].title}” and its rendered file are deleted permanently
              {freed(pending[0].storedBytes)}. This cannot be undone.
            </Trans>
          ) : pending?.[0]?.kind === "asset" ? (
            <Trans>
              “{pending[0].title}” and its files are deleted permanently
              {freed(pending[0].storedBytes)}. This cannot be undone.
            </Trans>
          ) : (
            <Trans>“{pending?.[0]?.title}” is deleted permanently. Clips that already have its layers keep them. This cannot be undone.</Trans>
          )
        }
        confirm={t`Delete forever`}
        danger
        onConfirm={() => {
          const rows = pending;
          if (!rows?.length) return Promise.resolve();
          return purge
            .mutateAsync({
              items: rows.map((r) => ({ kind: r.kind, id: r.id })),
              forgetDecisions: forgetDecisions && rows.some((r) => r.kind === "project"),
            })
            .then((r) => {
              setPending(null);
              setSel([]);
              refresh();
              const why = firstError(r.results);
              const size = formatBytes(r.storedBytes);
              const title = rows[0]!.title;
              const count = rows.length;
              toast(
                r.failed
                  ? t`Deleted ${r.purged} forever · ${r.failed} couldn’t be deleted${why}`
                  : r.storedBytes
                    ? t`Deleted forever · ${size} freed`
                    : rows.length === 1
                      ? t`Deleted “${title}” forever`
                      : t`Deleted ${count} items forever`,
              );
            });
        }}
      >
        {/* projects deleted with "forget" already go with their decisions; offer it only for the others */}
        {pending?.some((r) => r.kind === "project" && !r.forgetDecisions) && <ForgetDecisionsOption checked={forgetDecisions} onChange={setForgetDecisions} />}
      </ConfirmDialog>
    </ListPage>
  );
}
