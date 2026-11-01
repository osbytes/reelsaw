import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { formatBytes, type DeletedKind } from "@reelsaw/shared";
import { useTRPC } from "../lib/trpc";
import { useHashParams } from "../lib/hash";
import { ago } from "../lib/time";
import { ScrollArea } from "../components/scroll-area";
import { SelectionBar } from "../components/SelectionBar";
import { ConfirmDialog, MoreButton, Skeleton, SkeletonRegion } from "../components/ui";
import { QuotaNotice, quotaFromError } from "../components/QuotaNotice";
import { ForgetDecisionsOption } from "../components/ForgetDecisionsOption";

const KIND_LABEL: Record<DeletedKind, string> = { project: "Project", clip: "Clip", asset: "Library item", template: "Template" };
const GRID = "grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-x-3 sm:grid-cols-[2rem_5.5rem_minmax(0,1fr)_minmax(14rem,1.4fr)_2rem]";
/**
 * Hidden until that row is hovered (or a coarse pointer, or keyboard focus). The full class
 * string stays literal so Tailwind emits it. `!` beats the resting `opacity-0` (source order
 * inside one layer does not). A checked row keeps its own checkbox via `opacity-100`.
 */
const REVEAL_ROW = "transition-opacity group-hover/row:!opacity-100 focus-within:!opacity-100 pointer-coarse:!opacity-100 data-[state=open]:!opacity-100";
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
 * "in 3 days" reads faster than a date. The date itself is the row's tooltip (`foreverDate`).
 */
function foreverLabel(purgeAt: string | null) {
  if (!purgeAt) return "kept until you delete it forever";
  const days = Math.ceil((new Date(purgeAt).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return "deleted forever within the hour";
  return days === 1 ? "deleted forever within a day" : `deleted forever in ${days} days`;
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

function detailOf(r: Row) {
  const size = r.storedBytes ? formatBytes(r.storedBytes) : r.kind === "template" ? plural(r.layerCount ?? 0, "layer") : "no files";
  const extra = r.kind === "clip" ? r.projectTitle : r.kind === "asset" ? r.assetKind : undefined;
  const held = whyHeld(r);
  const forget = r.forgetDecisions ? "forgets what Reelsaw learned from it" : undefined;
  return [extra, size, `deleted ${ago(r.deletedAt)}`, held, foreverLabel(r.purgeAt), forget].filter(Boolean).join(" · ");
}

/**
 * Restorable deletes in one selectable list: projects, clips of live projects, library items and
 * templates. Each row says when it was deleted and when it is deleted forever. The header checkbox stays
 * visible. A row's checkbox and ⋯ appear on hover (always on a coarse pointer); a checked row
 * keeps its checkbox. The checkbox hit target fills the row from its top and bottom to the left
 * edge. Deep links: `#project=id` (also clip, asset, template).
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

  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex max-w-[1180px] flex-col gap-6 px-4 py-7 sm:px-6">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold tracking-tight">Deleted</h1>
          <p className="mt-1 min-h-5 text-sm text-ink2">
            Restore something, or delete it forever to free storage. Each row says when it was deleted and when it is deleted forever
            {data && data.keepDays > 0
              ? ` (projects and clips after ${plural(data.keepDays, "day")}, library and templates after ${plural(data.libraryDays, "day")})`
              : ""}
            .
          </p>
        </div>

        {list.isPending && !list.error && (
          <SkeletonRegion label="Loading deleted items…" className="flex flex-col gap-2">
            {["w-1/3", "w-2/5", "w-1/4"].map((w, i) => (
              <div key={i} className={`${GRID} min-h-[3.5rem] px-3 py-2`}>
                <Skeleton className="h-4 w-4 rounded" />
                <Skeleton className={`h-4 ${w} sm:col-span-2`} />
                <Skeleton className="hidden h-3.5 w-48 sm:block" />
                <Skeleton className="h-8 w-8 rounded-[10px]" />
              </div>
            ))}
          </SkeletonRegion>
        )}
        {list.error && <p className="text-err">✕ {list.error.message}</p>}

        {data && empty && (
          <div className="flex flex-col items-center gap-2 rounded-[16px] border border-dashed border-line2 px-5 py-10 text-center">
            <Trash2 className="h-6 w-6 text-ink3" aria-hidden />
            <b className="text-[15px]">Nothing waiting</b>
            <p className="max-w-[440px] text-[13px] leading-relaxed text-ink2">
              Deleted projects, clips, library items and templates show up here until you restore them or delete them forever.
            </p>
          </div>
        )}

        {data && items.length > 0 && (
          <div className="flex flex-col text-[13px]">
            <div className={`relative ${GRID} px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink3`}>
              <span className="h-8 w-8" aria-hidden />
              <label className="absolute inset-y-0 left-0 flex w-11 cursor-pointer items-center justify-center pl-3">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--acc)]"
                  checked={allOn}
                  onChange={() => setSel(allOn ? [] : allKeys)}
                  aria-label={allOn ? "Clear selection" : "Select all"}
                />
              </label>
              <span className="hidden sm:block">Kind</span>
              <span>Name</span>
              <span className="hidden sm:block">When</span>
              <span />
            </div>
            <ul className="flex flex-col gap-1">
              {items.map((r) => {
                const k = keyOf(r.kind, r.id);
                const on = highlighted === k;
                const checked = sel.includes(k);
                const heldWhy = whyHeld(r);
                return (
                  <li
                    key={k}
                    id={`deleted-${r.id}`}
                    className={`group/row relative ${GRID} min-h-[3.5rem] rounded-[10px] px-3 py-2 ${on || checked ? "bg-acc-soft" : "hover:bg-sunk/60"}`}
                  >
                    <span className="h-8 w-8" aria-hidden />
                    <label
                      className={`absolute inset-y-0 left-0 z-[1] flex w-11 cursor-pointer items-center justify-center pl-3 ${checked ? "opacity-100" : "opacity-0"} ${REVEAL_ROW}`}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--acc)]"
                        checked={checked}
                        onChange={() => toggle(r)}
                        aria-label={`Select ${r.title}`}
                      />
                    </label>
                    <span className="hidden font-semibold text-ink3 sm:block">{KIND_LABEL[r.kind]}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-semibold text-ink2">{r.title}</span>
                      <span className="block truncate text-xs text-ink3 sm:hidden" title={foreverDate(r.purgeAt)}>
                        {KIND_LABEL[r.kind]} · {detailOf(r)}
                      </span>
                    </span>
                    <span className="hidden truncate text-xs text-ink3 sm:block" title={foreverDate(r.purgeAt)}>
                      {detailOf(r)}
                    </span>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <MoreButton aria-label={`Actions for ${r.title}`} className={`opacity-0 ${REVEAL_ROW}`} />
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className="menu w-[200px]">
                          <DropdownMenu.Item className="menu-item" disabled={busy} onSelect={() => onRestore([r])}>
                            Restore
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            className="menu-item-danger"
                            disabled={!r.canPurge || busy}
                            title={heldWhy}
                            onSelect={() => r.canPurge && setPending([r])}
                          >
                            Delete forever…
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </li>
                );
              })}
            </ul>
            {data.truncated && (
              <p className="mt-2 text-xs text-ink3">
                Showing first {items.length} of {data.total}
              </p>
            )}
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
                    <DropdownMenu.Content side="top" align="end" sideOffset={8} className="menu w-[220px]">
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
          </div>
        )}
      </main>
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
    </ScrollArea>
  );
}
