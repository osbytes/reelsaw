import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layers, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  DELETED_PATH,
  isTemplateSortKey,
  layerTemplateNameSchema,
  listSortFirstDir,
  type TemplateBumpers,
  type TemplateLayer,
  type TemplateSortKey,
} from "@reelsaw/shared";
import { templateSummary } from "../components/TemplatePicker";
import { useTRPC } from "../lib/trpc";
import { useDeletedToast } from "../lib/deletedToast";
import { useRestoreWindow } from "../lib/retention";
import { readHash, useHashParams, writeHash } from "../lib/hash";
import { useDebounced } from "../lib/useDebounced";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { plural } from "@lingui/core/macro";
import { ListLoadMore, ListSearch, ListToolbar, listSortToggle, type SortChoice, type SortOption, SortMenu } from "../components/ListToolbar";
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
import { pageTitle, useDocumentTitle } from "../lib/title";

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

const PAGE = 100;
const readSort = (h: URLSearchParams): SortChoice<TemplateSortKey> => {
  const key = h.get("sort");
  if (!isTemplateSortKey(key)) return null;
  const d = h.get("dir");
  const dir = d === "asc" || d === "desc" ? d : listSortFirstDir(key);
  // last change, newest first, is the default order: null, so the query and the hash carry nothing for it
  return key === "updated" && dir === "desc" ? null : { key, dir };
};

/**
 * Layer templates (docs/specs/layer-templates.md): sets of layers that fit any clip length. New template opens the
 * template editor; rows offer Edit / Rename / Duplicate / Delete; deleted ones are restorable from Deleted.
 * Deep link: `#template=<id>` highlights a row.
 */
export function TemplatesPage() {
  const { t } = useLingui();
  useDocumentTitle(pageTitle(t`Templates`));
  const SORT_OPTIONS: SortOption<TemplateSortKey>[] = [
    { value: "name", label: t`Name`, firstDir: "asc", asc: t`A to Z`, desc: t`Z to A` },
    { value: "created", label: t`Date made`, firstDir: "desc", asc: t`Oldest first`, desc: t`Newest first` },
    { value: "updated", label: t`Last changed`, firstDir: "desc", asc: t`Oldest first`, desc: t`Newest first` },
  ];
  const trpc = useTRPC();
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const hash = useHashParams();
  const highlighted = hash.get("template");
  // search and sort run on the server and live in the hash (#q=logo&sort=name&dir=asc)
  const [search, setSearch] = useState(() => readHash().get("q") ?? "");
  const [sort, setSort] = useState<SortChoice<TemplateSortKey>>(() => readSort(readHash()));
  const hashKey = hash.toString();
  useEffect(() => {
    const h = new URLSearchParams(hashKey);
    setSearch(h.get("q") ?? "");
    setSort(readSort(h));
  }, [hashKey]);
  const term = useDebounced(search.trim(), 200);
  useEffect(() => writeHash({ q: term || null, sort: sort?.key ?? null, dir: sort?.dir ?? null }), [term, sort]);
  const list = useInfiniteQuery(
    trpc.layerTemplates.list.infiniteQueryOptions(
      { limit: PAGE, q: term || undefined, ...(sort ? { sort: sort.key, dir: sort.dir } : {}) },
      { getNextPageParam: (last) => last.nextCursor ?? undefined, placeholderData: keepPreviousData },
    ),
  );
  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.layerTemplates.list.pathKey() });
  const create = useMutation(trpc.layerTemplates.create.mutationOptions());
  const update = useMutation(trpc.layerTemplates.update.mutationOptions({ onSuccess: () => invalidate() }));
  const remove = useMutation(trpc.layerTemplates.delete.mutationOptions({ onSuccess: () => invalidate() }));
  const restoreWindow = useRestoreWindow("template");
  const notifyDeleted = useDeletedToast();
  const [renaming, setRenaming] = useState<TemplateRow | null>(null);
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState<TemplateRow | null>(null);

  const templates = useMemo(() => list.data?.pages.flatMap((pg) => pg.items) ?? [], [list.data]);
  const totalTemplates = list.data?.pages[0]?.total ?? templates.length;
  const deleted = list.data?.pages[0]?.deleted ?? [];
  // the highlight joins the hash, so the search and sort in it stay
  const highlight = (id: string) => {
    const h = readHash();
    h.set("template", id);
    nav({ pathname: loc.pathname, search: loc.search, hash: `#${h.toString()}` }, { replace: true });
  };
  const noun = (n: number) => (term ? plural(n, { one: "# match", other: "# matches" }) : plural(n, { one: "# template", other: "# templates" }));
  const showing = (shown: number, total: number) =>
    shown < total
      ? term
        ? plural(total, { one: `Showing ${shown} of # match`, other: `Showing ${shown} of # matches` })
        : plural(total, { one: `Showing ${shown} of # template`, other: `Showing ${shown} of # templates` })
      : noun(total);
  // name | what it holds (layers, intro / outro) | updated | actions; Name and Updated sort the server query
  // null is last change, newest first: the Updated header shows it, and its toggle starts from it
  const shownSort = sort ?? { key: "updated" as const, dir: "desc" as const };
  const sortable = (k: TemplateSortKey, firstDir: "asc" | "desc"): NonNullable<ListColumn["sort"]> => ({
    dir: shownSort.key === k ? (shownSort.dir === "asc" ? 1 : -1) : null,
    onToggle: () => {
      const next = listSortToggle<TemplateSortKey>(shownSort, k, firstDir);
      setSort(next?.key === "updated" && next.dir === "desc" ? null : next);
    },
  });
  const columns: ListColumn[] = [
    { label: t`Name`, sort: sortable("name", "asc") },
    { label: t`Layers`, width: "min-[1040px]:w-52", full: true, right: true },
    { label: t`Updated`, width: "min-[1040px]:w-[6.5rem]", full: true, sort: sortable("updated", "desc") },
    { label: null, srLabel: t`Actions`, width: LIST_ACTIONS_WIDTH },
  ];

  // a deep-linked row scrolls into view once it is on the page
  useEffect(() => {
    if (!highlighted) return;
    document.getElementById(`template-${highlighted}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlighted, templates.length]);

  const newTemplate = () =>
    create.mutate(
      { name: t`Untitled template`, layers: [] },
      {
        onSuccess: (made) => {
          void invalidate();
          nav(`/templates/${made.id}`);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  const duplicate = (tpl: TemplateRow) => {
    const copyName = tpl.name;
    const name = layerTemplateNameSchema.safeParse(t`${copyName} (copy)`);
    create.mutate(
      { name: name.success ? name.data : tpl.name, layers: tpl.layers },
      {
        onSuccess: (c) => {
          void invalidate();
          highlight(c.id);
          const copied = c.name;
          toast(t`Duplicated as “${copied}”`);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };
  const openRename = (tpl: TemplateRow) => {
    setDraft(tpl.name);
    setRenaming(tpl);
  };
  const nameOk = layerTemplateNameSchema.safeParse(draft).success;
  const saveRename = () => {
    if (!renaming || !nameOk) return;
    update.mutate(
      { id: renaming.id, name: draft.trim() },
      {
        onSuccess: () => {
          setRenaming(null);
          toast(t`Renamed`);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  const row = (tpl: TemplateRow) => {
    const rowName = tpl.name;
    const summary = templateSummary(tpl);
    const updated = ago(tpl.updatedAt);
    return (
      <ListRow key={tpl.id} id={`template-${tpl.id}`} active={highlighted === tpl.id}>
        <ListCell>
          <Link to={`/templates/${tpl.id}`} className={`block no-underline hover:underline ${LIST_TITLE}`}>
            {tpl.name}
          </Link>
          {/* below the fold width the layer count and the time go on a second line inside the name cell */}
          <div className={`${LIST_SUB} min-[1040px]:hidden`}>
            <Trans>
              {summary} · updated {updated}
            </Trans>
          </div>
        </ListCell>
        <ListCell full variant="num" className="truncate" title={templateSummary(tpl)}>
          {templateSummary(tpl)}
        </ListCell>
        <ListCell full variant="muted">
          {ago(tpl.updatedAt)}
        </ListCell>
        <ListCell variant="actions">
          <div className="flex items-center justify-end gap-1.5">
            <Link to={`/templates/${tpl.id}`} className={`btn-ghost w-[5.5rem] ${LIST_ACTION}`}>
              <Trans>Edit</Trans>
            </Link>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <MoreButton aria-label={t`More actions for ${rowName}`} />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className={LIST_MENU}>
                  <DropdownMenu.Item className={LIST_MENU_ITEM_FOLDED} onSelect={() => nav(`/templates/${tpl.id}`)}>
                    <Trans>Edit</Trans>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" onSelect={() => openRename(tpl)}>
                    <Trans>Rename…</Trans>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" disabled={create.isPending} onSelect={() => duplicate(tpl)}>
                    <Trans>Duplicate</Trans>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item-danger" onSelect={() => setConfirm(tpl)}>
                    <Trans>Delete…</Trans>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </ListCell>
      </ListRow>
    );
  };

  const newButton = (
    <button className="btn-primary min-w-[9.5rem] justify-center" disabled={create.isPending} onClick={newTemplate}>
      {create.isPending && !create.variables?.layers.length ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}{" "}
      <Trans>New template</Trans>
    </button>
  );
  const restoreSuffix = restoreWindow.restorable ? ` ${restoreWindow.restorable}` : "";
  const confirmName = confirm?.name;
  const none = !!list.data && !list.isPlaceholderData && templates.length === 0;
  // no templates at all (the call to action) vs none matching the search
  const empty = none && !term;
  const noMatch = none && !!term;
  return (
    <ListPage
      title={t`Templates`}
      subtitle={t`Logos, stickers, text and sounds placed once, fitted to any clip length`}
      actions={empty ? undefined : newButton}
    >
      {!empty && (
        <ListToolbar
          label={t`Search templates`}
          search={<ListSearch value={search} onChange={setSearch} placeholder={t`Search template names`} label={t`Search templates`} />}
          controls={<SortMenu options={SORT_OPTIONS} value={sort} onChange={setSort} defaultKey="updated" />}
          count={list.isPending ? <Skeleton className="h-3 w-24" /> : noun(totalTemplates)}
        />
      )}
      {list.error && <ListError message={list.error.message} />}
      {noMatch && <ListEmpty icon={Layers} title={t`No templates match “${term}”`} />}
      {empty && (
        <ListEmpty icon={Layers} title={t`No templates yet`} action={newButton}>
          <Trans>
            A template is a set of layers (a logo in the first seconds, a call to action at the end, a music bed) that fits any clip. Make one here, or save a
            clip’s layers as a template from the clip editor.
          </Trans>
        </ListEmpty>
      )}
      {(templates.length > 0 || (list.isPending && !list.error)) && (
        <section className="flex flex-col gap-2">
          <ListTable caption={t`Your layer templates`} columns={columns} loading={list.isPending} loadingLabel={t`Loading templates…`}>
            {list.isPending &&
              Array.from({ length: LIST_SKELETON_ROWS }, (_, i) => (
                <ListRow key={i} skeleton>
                  <ListCell>
                    <Skeleton className={`h-4 ${["w-1/3", "w-1/4", "w-2/5", "w-1/2", "w-1/3"][i]}`} />
                    <Skeleton className="mt-1.5 h-3 w-3/5 min-[1040px]:hidden" />
                  </ListCell>
                  <ListCell full>
                    <Skeleton className="ms-auto h-3.5 w-14" />
                  </ListCell>
                  <ListCell full>
                    <Skeleton className="h-3.5 w-14" />
                  </ListCell>
                  <ListCell>
                    <Skeleton className="ms-auto h-8 w-8 rounded-[8px] min-[1040px]:w-full" />
                  </ListCell>
                </ListRow>
              ))}
            {templates.map((tpl) => row(tpl))}
          </ListTable>
          <ListFooter
            action={
              <ListLoadMore
                hasMore={!!list.hasNextPage}
                loading={list.isFetchingNextPage}
                busy={(list.isFetching && !list.isFetchingNextPage) || list.isPlaceholderData}
                onMore={() => void list.fetchNextPage()}
                left={Math.min(PAGE, totalTemplates - templates.length)}
              />
            }
          >
            {list.isPending ? <Skeleton className="h-3 w-40" /> : showing(templates.length, totalTemplates)}
          </ListFooter>
        </section>
      )}

      {deleted.length > 0 && (
        <p className="text-xs text-ink3">
          <Trans>
            <Plural value={deleted.length} one="# deleted template" other="# deleted templates" /> restorable from{" "}
            <Link to={DELETED_PATH} className="text-acc-text no-underline hover:underline">
              Deleted
            </Link>
            {restoreSuffix}.
          </Trans>
        </p>
      )}

      <Modal open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)} title={t`Rename template`}>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            saveRename();
          }}
        >
          <input className="input" autoFocus value={draft} maxLength={120} aria-label={t`Template name`} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setRenaming(null)}>
              <Trans>Cancel</Trans>
            </button>
            <button type="submit" className="btn-primary min-w-[5.5rem] justify-center" disabled={!nameOk || update.isPending}>
              {update.isPending && <Loader2 className="h-4 w-4 animate-spin" />} <Trans>Save</Trans>
            </button>
          </div>
        </form>
      </Modal>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t`Delete this template?`}
        body={
          <>
            <Trans>“{confirmName}” is deleted from your templates and from your project defaults. Clips that already have its layers keep them.</Trans>{" "}
            {restoreWindow.hint()}
          </>
        }
        confirm={t`Delete`}
        danger
        onConfirm={() => {
          const tpl = confirm;
          if (!tpl) return Promise.resolve();
          const gone = tpl.name;
          return remove.mutateAsync({ id: tpl.id }).then((r) => {
            if (r.clearedDefault) toast(t`“${gone}” is no longer the default for new projects`);
            notifyDeleted({ items: [{ kind: "template", id: tpl.id, title: tpl.name }], restorable: restoreWindow.restorable });
          });
        }}
      />
    </ListPage>
  );
}
