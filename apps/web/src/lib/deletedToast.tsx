/**
 * The standard delete toast: Undo, Delete forever, See deletions. Every soft-delete path
 * (project, clip, library, template, bulk) calls `useDeletedToast` so the affordances stay the same.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { toast } from "sonner";
import { DELETED_PATH, deletedItemPath, formatBytes, type DeletedKind } from "@reelsaw/shared";
import { useTRPC } from "./trpc";
import { QuotaNotice, quotaFromError } from "../components/QuotaNotice";

export type DeletedToastItem = { kind: DeletedKind; id: string; title: string };

const TOAST_MS = 10_000;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function heading(items: DeletedToastItem[]) {
  if (items.length === 1) return `Deleted “${items[0]!.title}”`;
  const kinds = new Set(items.map((i) => i.kind));
  if (kinds.size === 1) {
    const k = items[0]!.kind;
    const word = k === "project" ? "project" : k === "clip" ? "clip" : k === "asset" ? "library item" : "template";
    return `Deleted ${plural(items.length, word)}`;
  }
  return `Deleted ${items.length} items`;
}

function seePath(items: DeletedToastItem[]) {
  if (items.length === 1) return deletedItemPath(items[0]!.kind, items[0]!.id);
  return DELETED_PATH;
}

function failToast(err: { message: string }) {
  const quota = quotaFromError(err);
  toast.error(quota ? <QuotaNotice message={err.message} quota={quota} /> : err.message.slice(0, 200));
}

export function showDeletedToast(opts: {
  items: DeletedToastItem[];
  restorable?: string | undefined;
  storedBytes?: number | undefined;
  canPurge?: boolean | undefined;
  onUndo: () => Promise<unknown>;
  onPurge: () => Promise<unknown>;
}) {
  const { items, restorable, storedBytes, canPurge = true } = opts;
  if (!items.length) return;
  const bits: string[] = [];
  if (storedBytes) bits.push(`Still using ${formatBytes(storedBytes)} until you delete it forever.`);
  if (restorable) bits.push(`Restorable ${restorable}.`);
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
              void opts.onUndo().then(() => toast(items.length === 1 ? `Restored “${items[0]!.title}”` : `Restored ${items.length} items`), failToast);
            }}
          >
            Undo
          </button>
          {canPurge ? (
            <button
              type="button"
              className="text-err hover:underline"
              onClick={() => {
                toast.dismiss(id);
                void opts.onPurge().then((r) => {
                  const msg = r && typeof r === "object" && "message" in r && typeof r.message === "string" ? r.message : items.length === 1 ? `Deleted “${items[0]!.title}” forever` : `Deleted ${items.length} items forever`;
                  toast(msg);
                }, failToast);
              }}
            >
              Delete forever
            </button>
          ) : null}
          <Link to={seePath(items)} className="text-ink2 no-underline hover:underline" onClick={() => toast.dismiss(id)}>
            See deletions
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
