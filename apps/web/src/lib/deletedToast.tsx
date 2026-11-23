/**
 * The standard delete toast: Undo, Delete forever, See deletions. Every soft-delete path
 * (project, clip, library, template, bulk) calls `useDeletedToast` so the affordances stay the same.
 */
import { useSyncExternalStore } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { toast } from "sonner";
import { DELETED_PATH, deletedItemPath, formatBytes, type DeletedKind } from "@reelsaw/shared";
import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useTRPC } from "./trpc";
import { QuotaNotice, quotaFromError } from "../components/QuotaNotice";
import { ConfirmDialog } from "../components/ui";

export type DeletedToastItem = { kind: DeletedKind; id: string; title: string };

const TOAST_MS = 10_000;

function heading(items: DeletedToastItem[]) {
  const n = items.length;
  if (n === 1) {
    const title = items[0]!.title;
    return t`Deleted “${title}”`;
  }
  const kinds = new Set(items.map((i) => i.kind));
  if (kinds.size === 1) {
    const k = items[0]!.kind;
    if (k === "project") return plural(n, { one: "Deleted # project", other: "Deleted # projects" });
    if (k === "clip") return plural(n, { one: "Deleted # clip", other: "Deleted # clips" });
    if (k === "asset") return plural(n, { one: "Deleted # library item", other: "Deleted # library items" });
    return plural(n, { one: "Deleted # template", other: "Deleted # templates" });
  }
  return t`Deleted ${n} items`;
}

function seePath(items: DeletedToastItem[]) {
  if (items.length === 1) return deletedItemPath(items[0]!.kind, items[0]!.id);
  return DELETED_PATH;
}

function failToast(err: { message: string }) {
  const quota = quotaFromError(err);
  toast.error(quota ? <QuotaNotice message={err.message} quota={quota} /> : err.message.slice(0, 200));
}

type ToastOpts = {
  items: DeletedToastItem[];
  restorable?: string | undefined;
  storedBytes?: number | undefined;
  canPurge?: boolean | undefined;
  onUndo: () => Promise<unknown>;
  onPurge: () => Promise<unknown>;
};

// The toast unmounts when it times out, so the question about purging lives outside it, mounted once.
let asking: ToastOpts | null = null;
const listeners = new Set<() => void>();
function setAsking(next: ToastOpts | null) {
  asking = next;
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The confirm behind the toast's "Delete forever". Cancelling brings the toast back, so Undo is not lost. */
export function DeletedToastConfirm() {
  const ask = useSyncExternalStore(subscribe, () => asking);
  const items = ask?.items ?? [];
  const firstTitle = items[0]?.title ?? "";
  const count = items.length;
  const freed = formatBytes(ask?.storedBytes ?? 0);
  return (
    <ConfirmDialog
      open={!!ask}
      onOpenChange={(o) => {
        if (o || !asking) return;
        const back = asking;
        setAsking(null);
        showDeletedToast(back);
      }}
      title={items.length === 1 ? t`Delete “${firstTitle}” forever?` : t`Delete ${count} items forever?`}
      body={
        ask?.storedBytes
          ? t`Stored files are deleted permanently (${freed} freed). This cannot be undone.`
          : t`Stored files are deleted permanently. This cannot be undone.`
      }
      confirm={t`Delete forever`}
      danger
      onConfirm={() => {
        if (!ask) return Promise.resolve();
        // the dialog stays open with its spinner until the purge settles; a failure shows in it (Cancel brings the toast back)
        return ask.onPurge().then((r) => {
          setAsking(null);
          const msg =
            r && typeof r === "object" && "message" in r && typeof r.message === "string"
              ? r.message
              : items.length === 1
                ? t`Deleted “${firstTitle}” forever`
                : t`Deleted ${count} items forever`;
          toast(msg);
        });
      }}
    />
  );
}

export function showDeletedToast(opts: ToastOpts) {
  const { items, restorable, storedBytes, canPurge = true } = opts;
  if (!items.length) return;
  const bits: string[] = [];
  const size = formatBytes(storedBytes ?? 0);
  if (storedBytes) bits.push(t`Still using ${size} until you delete it forever.`);
  if (restorable) bits.push(t`Restorable ${restorable}.`);
  const firstTitle = items[0]!.title;
  const count = items.length;
  const description = bits.join(" ");

  toast.custom(
    (id) => (
      <div className="flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 rounded-[14px] border border-line bg-panel p-3.5 text-[13px] font-semibold text-ink shadow-pop">
        <p className="leading-snug">{heading(items)}</p>
        {description ? <p className="text-xs font-normal leading-snug text-ink2">{description}</p> : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold">
          <button
            type="button"
            className="text-acc-text hover:underline"
            onClick={() => {
              toast.dismiss(id);
              void opts.onUndo().then(() => toast(items.length === 1 ? t`Restored “${firstTitle}”` : t`Restored ${count} items`), failToast);
            }}
          >
            <Trans>Undo</Trans>
          </button>
          {canPurge ? (
            <button
              type="button"
              className="text-err hover:underline"
              onClick={() => {
                toast.dismiss(id);
                setAsking(opts);
              }}
            >
              <Trans>Delete forever…</Trans>
            </button>
          ) : null}
          <Link to={seePath(items)} className="text-ink2 no-underline hover:underline" onClick={() => toast.dismiss(id)}>
            <Trans>See deletions</Trans>
          </Link>
        </div>
      </div>
    ),
    { duration: TOAST_MS },
  );
}

/** Wire Undo / Delete forever to `deleted.restore` / `deleted.purge` and refresh the lists those pages read. */
export function useDeletedToast() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const restore = useMutation(trpc.deleted.restore.mutationOptions());
  const purge = useMutation(trpc.deleted.purge.mutationOptions());
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: trpc.deleted.list.queryKey() });
    void qc.invalidateQueries({ queryKey: trpc.projects.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.library.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.layerTemplates.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.searchIndex.queryKey() });
    void qc.invalidateQueries({ queryKey: trpc.search.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.me.pathKey() });
  };
  return (opts: { items: DeletedToastItem[]; restorable?: string | undefined; storedBytes?: number; canPurge?: boolean; afterUndo?: () => void }) => {
    const refs = opts.items.map((i) => ({ kind: i.kind, id: i.id }));
    showDeletedToast({
      items: opts.items,
      restorable: opts.restorable,
      storedBytes: opts.storedBytes,
      canPurge: opts.canPurge,
      onUndo: () =>
        restore.mutateAsync({ items: refs }).then(() => {
          refresh();
          opts.afterUndo?.();
        }),
      onPurge: () => purge.mutateAsync({ items: refs }).then((r) => (refresh(), r)),
    });
  };
}
