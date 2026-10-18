import { useEffect, useMemo, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "../lib/trpc";
import { useMe } from "../lib/account";
import { toast } from "sonner";
import { ScrollArea } from "../components/scroll-area";
import { ConfirmDialog, Modal, MoreButton, Skeleton } from "../components/ui";

type Usage = { projects: number; sourceMinutes: number; clipsRendered: number; storedBytes: number; llmCalls: number; llmInputTokens: number; llmOutputTokens: number };
type Row = { id: string; name: string; email: string; role: "user" | "admin"; status: "pending" | "active" | "suspended"; banReason: string | null; projects: number; createdAt: string; lastActive: string | null; usage: Usage };
type SortKey = "name" | "status" | "projects" | "sourceMinutes" | "clipsRendered" | "storedBytes" | "lastActive";

const STATUS: Record<Row["status"], { glyph: string; tone: string; word: string }> = {
  pending: { glyph: "◷", tone: "text-warn", word: "Pending" },
  active: { glyph: "●", tone: "text-ok", word: "Active" },
  suspended: { glyph: "✕", tone: "text-err", word: "Suspended" },
};

const PAGE = 50;

/** `value`, but only after it has stopped changing for `ms`. */
function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
const num = new Intl.NumberFormat();
const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

function ago(iso: string | null) {
  if (!iso) return "never";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Every row shares one grid: a fixed-layout table, so a badge or a missing button cannot move another
 * column. From 900px: name (flexes) | status 7rem | projects, minutes, clips 4.5rem | stored 5.5rem |
 * active 6.5rem | actions 11.5rem (state button, Limits, and a menu). Below 900px the usage columns
 * fold into one line under the name and every action lives in the menu, in a 3.5rem slot.
 */
const FULL = "hidden min-[900px]:table-cell";
const TH = "sticky top-0 z-10 h-9 border-b border-line bg-panel px-3 align-middle text-xs font-medium leading-4 text-ink3";
const COL = "hidden min-[900px]:table-column";

/** Admin: who may use this instance. Pending accounts first; every action is one click plus a confirm for the destructive ones. */
export function AdminUsersPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const me = useMe();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "ban" | "remove"; row: Row } | null>(null);
  const [limitsFor, setLimitsFor] = useState<Row | null>(null);
  const [banReason, setBanReason] = useState("");
  const q = useDebounced(search.trim(), 200);
  // server-side paging; each account carries its all-time usage, so there is no separate usage query
  const list = useInfiniteQuery(
    trpc.admin.users.list.infiniteQueryOptions(
      { q: q || undefined, limit: PAGE },
      { getNextPageParam: (last) => last.nextCursor ?? undefined, placeholderData: keepPreviousData },
    ),
  );
  const done = (msg: string) => () => {
    toast(msg);
    void qc.invalidateQueries({ queryKey: trpc.admin.users.pathKey() });
  };
  const fail = (e: { message: string }) => toast.error(e.message);
  const approve = useMutation({ ...trpc.admin.users.approve.mutationOptions(), onSuccess: done("Approved"), onError: fail });
  const setRole = useMutation({ ...trpc.admin.users.setRole.mutationOptions(), onSuccess: done("Role changed"), onError: fail });
  const ban = useMutation({ ...trpc.admin.users.ban.mutationOptions(), onSuccess: done("Suspended"), onError: fail });
  const unban = useMutation({ ...trpc.admin.users.unban.mutationOptions(), onSuccess: done("Reinstated"), onError: fail });
  const remove = useMutation({ ...trpc.admin.users.remove.mutationOptions(), onSuccess: done("Account removed"), onError: fail });
  const busy = approve.isPending || setRole.isPending || ban.isPending || unban.isPending || remove.isPending;
  const loaded = useMemo(() => (list.data?.pages.flatMap((pg) => pg.items) ?? []) as Row[], [list.data]);
  const total = list.data?.pages[0]?.total ?? 0;
  // sorting is client side, over the rows loaded so far
  const rows = useMemo(() => {
    const base = loaded;
    if (!sort) return base;
    const val = (r: Row): string | number => {
      switch (sort.key) {
        case "name": return (r.name || r.email).toLowerCase();
        case "status": return r.status;
        case "lastActive": return r.lastActive ? new Date(r.lastActive).getTime() : 0;
        case "projects": return r.usage.projects;
        default: return r.usage[sort.key];
      }
    };
    return [...base].sort((x, y) => (val(x) < val(y) ? -sort.dir : val(x) > val(y) ? sort.dir : 0));
  }, [loaded, sort]);
  const pending = rows.filter((r) => r.status === "pending").length;

  const head = (k: SortKey, label: string, opts: { right?: boolean; className?: string; usage?: boolean } = {}) => (
    <th scope="col" className={`${TH} ${opts.right ? "text-right" : "text-left"} ${opts.className ?? ""}`} aria-sort={sort?.key === k ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
      <button
        type="button"
        title={opts.usage ? "All time. Sorts the loaded rows" : "Sorts the loaded rows"}
        className={`inline-flex h-4 items-center gap-1 whitespace-nowrap align-middle leading-4 hover:text-ink ${opts.right ? "flex-row-reverse" : ""}`}
        onClick={() => setSort(sort?.key === k && sort.dir === -1 ? null : { key: k, dir: sort?.key === k ? -1 : k === "name" || k === "status" ? 1 : -1 })}
      >
        {label}
        <span aria-hidden className="inline-block w-2 text-[10px] leading-none">{sort?.key === k ? (sort.dir === 1 ? "▲" : "▼") : ""}</span>
      </button>
    </th>
  );

  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex max-w-[1040px] flex-col gap-5 px-4 py-7 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[28px] font-bold tracking-tight">Users</h1>
            <div className="mt-1 flex min-h-5 items-center text-sm text-ink2">
              {list.isPending ? <Skeleton className="h-3.5 w-44" /> : list.data ? `Showing ${num.format(rows.length)} of ${num.format(total)} account${total === 1 ? "" : "s"}${pending ? ` · ${pending} waiting for approval` : ""}` : ""}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input className="input w-[14rem]" placeholder="Search name or email" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search users" />
          </div>
        </div>

        <div className="min-h-10 text-[13px]">
          {list.error && <span className="text-err">✕ {list.error.message}</span>}
          {list.data && !list.isPlaceholderData && rows.length === 0 && <span className="text-ink3">No accounts match.</span>}
          {(rows.length > 0 || list.isPending) && (
            <div className="rounded-[16px] border border-line bg-panel">
              <table className="w-full table-fixed border-separate border-spacing-0">
                <caption className="sr-only">Accounts, with all-time usage</caption>
                <colgroup>
                  <col />
                  <col className={`${COL} min-[900px]:w-28`} />
                  <col className={`${COL} min-[900px]:w-[4.5rem]`} />
                  <col className={`${COL} min-[900px]:w-[4.5rem]`} />
                  <col className={`${COL} min-[900px]:w-[4.5rem]`} />
                  <col className={`${COL} min-[900px]:w-[5.5rem]`} />
                  <col className={`${COL} min-[900px]:w-[6.5rem]`} />
                  <col className="w-14 min-[900px]:w-[11.5rem]" />
                </colgroup>
                <thead>
                  <tr>
                    {head("name", "Account", { className: "rounded-tl-[16px]" })}
                    {head("status", "Status", { className: FULL })}
                    {head("projects", "Projects", { right: true, className: FULL, usage: true })}
                    {head("sourceMinutes", "Minutes", { right: true, className: FULL, usage: true })}
                    {head("clipsRendered", "Clips", { right: true, className: FULL, usage: true })}
                    {head("storedBytes", "Stored", { right: true, className: FULL, usage: true })}
                    {head("lastActive", "Active", { className: FULL })}
                    <th scope="col" className={`${TH} rounded-tr-[16px] text-right`}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.isPending &&
                    Array.from({ length: 5 }, (_, i) => {
                      const cell = "border-t border-line px-3 align-middle";
                      return (
                        <tr key={`sk-${i}`} className="h-[84px] min-[900px]:h-[60px]" aria-hidden>
                          <td className={cell}>
                            <Skeleton className={`h-4 ${["w-2/5", "w-1/2", "w-1/3", "w-3/5", "w-2/5"][i]}`} />
                            <Skeleton className="mt-1.5 h-3 w-3/5" />
                            <Skeleton className="mt-1.5 h-3 w-4/5 min-[900px]:hidden" />
                          </td>
                          <td className={`${cell} ${FULL}`}><Skeleton className="h-3.5 w-16" /></td>
                          {[0, 1, 2].map((j) => (
                            <td key={j} className={`${cell} ${FULL}`}><Skeleton className="ml-auto h-3.5 w-8" /></td>
                          ))}
                          <td className={`${cell} ${FULL}`}><Skeleton className="ml-auto h-3.5 w-12" /></td>
                          <td className={`${cell} ${FULL}`}><Skeleton className="h-3.5 w-14" /></td>
                          <td className={cell}><Skeleton className="ml-auto h-8 w-8 rounded-[8px] min-[900px]:w-[11rem]" /></td>
                        </tr>
                      );
                    })}
                  {rows.map((r) => {
                    const st = STATUS[r.status];
                    const self = r.id === me.data?.id;
                    const u = r.usage;
                    const line = `${num.format(u.projects)} projects · ${num.format(u.sourceMinutes)} min · ${num.format(u.clipsRendered)} clips · ${bytes(u.storedBytes)}`;
                    const model = `All time: ${num.format(u.llmCalls)} model calls, ${Math.round(u.llmInputTokens / 1000)}k tokens in, ${Math.round(u.llmOutputTokens / 1000)}k out`;
                    const cell = "border-t border-line px-3 align-middle";
                    const stateLabel = r.status === "pending" ? "Approve" : r.status === "suspended" ? "Reinstate" : "Suspend";
                    const stateOff = busy || (self && r.status === "active");
                    const stateWhy = self && r.status === "active" ? "You cannot suspend your own account" : undefined;
                    const stateRun = () => {
                      if (r.status === "pending") approve.mutate({ id: r.id });
                      else if (r.status === "suspended") unban.mutate({ id: r.id });
                      else {
                        setBanReason("");
                        setConfirm({ kind: "ban", row: r });
                      }
                    };
                    return (
                      <tr key={r.id} className="h-[84px] min-[900px]:h-[60px]">
                        <td className={cell} title={model}>
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 truncate font-semibold">{r.name || r.email}</span>
                            {r.role === "admin" && <span className="chip shrink-0 bg-acc-soft text-acc-text">admin</span>}
                            {self && <span className="shrink-0 text-xs text-ink3">(you)</span>}
                          </div>
                          <div className="truncate text-xs text-ink2">{r.email}</div>
                          <div className="truncate text-xs text-ink3 min-[900px]:hidden">
                            <span className={st.tone}>
                              {st.glyph} {st.word}
                            </span>{" "}
                            · {line} · active {ago(r.lastActive)}
                          </div>
                        </td>
                        <td className={`${cell} ${FULL} text-xs ${st.tone}`} title={r.banReason ?? undefined}>
                          {st.glyph} {st.word}
                        </td>
                        <td className={`${cell} ${FULL} text-right font-mono text-xs tabular-nums`}>{num.format(u.projects)}</td>
                        <td className={`${cell} ${FULL} text-right font-mono text-xs tabular-nums`}>{num.format(u.sourceMinutes)}</td>
                        <td className={`${cell} ${FULL} text-right font-mono text-xs tabular-nums`}>{num.format(u.clipsRendered)}</td>
                        <td className={`${cell} ${FULL} text-right font-mono text-xs tabular-nums`}>{bytes(u.storedBytes)}</td>
                        <td className={`${cell} ${FULL} text-xs text-ink3`}>{ago(r.lastActive)}</td>
                        <td className={`${cell} text-right`}>
                          <div className="flex items-center justify-end gap-1.5">
                            <button className={`${r.status === "pending" ? "btn-primary" : "btn-ghost"} hidden h-8 w-[5.5rem] text-xs min-[900px]:inline-flex`} disabled={stateOff} title={stateWhy} onClick={stateRun}>
                              {stateLabel}
                            </button>
                            <button className="btn-ghost hidden h-8 w-[4.25rem] text-xs min-[900px]:inline-flex" onClick={() => setLimitsFor(r)}>
                              Limits
                            </button>
                            <DropdownMenu.Root>
                              <DropdownMenu.Trigger asChild>
                                <MoreButton aria-label={`More actions for ${r.email}`} />
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Portal>
                                <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className="menu w-[230px]">
                                  <DropdownMenu.Item className="menu-item min-[900px]:hidden" disabled={stateOff} onSelect={stateRun}>
                                    {stateLabel}
                                    {stateWhy && <span className="menu-hint">not your own</span>}
                                  </DropdownMenu.Item>
                                  <DropdownMenu.Item className="menu-item min-[900px]:hidden" onSelect={() => setLimitsFor(r)}>
                                    Limits…
                                  </DropdownMenu.Item>
                                  {r.status === "pending" && (
                                    <DropdownMenu.Item
                                      className="menu-item"
                                      disabled={busy}
                                      onSelect={() => {
                                        setBanReason("");
                                        setConfirm({ kind: "ban", row: r });
                                      }}
                                    >
                                      Suspend
                                    </DropdownMenu.Item>
                                  )}
                                  <DropdownMenu.Item className="menu-item" disabled={busy || self} onSelect={() => setRole.mutate({ id: r.id, role: r.role === "admin" ? "user" : "admin" })}>
                                    {r.role === "admin" ? "Make user" : "Make admin"}
                                    {self && <span className="menu-hint">not your own</span>}
                                  </DropdownMenu.Item>
                                  <DropdownMenu.Item className="menu-item text-err" disabled={busy || self} onSelect={() => setConfirm({ kind: "remove", row: r })}>
                                    Remove account…
                                    {self && <span className="menu-hint">not your own</span>}
                                  </DropdownMenu.Item>
                                </DropdownMenu.Content>
                              </DropdownMenu.Portal>
                            </DropdownMenu.Root>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* fixed-height footer so loading the next page never moves what is below */}
        <div className="-mt-2 flex h-10 items-center justify-center">
          {list.hasNextPage && (
            <button type="button" className="btn-ghost h-9 min-w-[8rem]" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage ? "Loading…" : `Load ${num.format(Math.min(PAGE, total - rows.length))} more`}
            </button>
          )}
        </div>

        {limitsFor && <LimitsDialog row={limitsFor} onClose={() => setLimitsFor(null)} />}
        <ConfirmDialog
          open={confirm?.kind === "remove"}
          onOpenChange={(o) => !o && setConfirm(null)}
          title={`Remove ${confirm?.row.email ?? "this account"}?`}
          body={<>Their {confirm?.row.projects ?? 0} project{confirm?.row.projects === 1 ? "" : "s"}, clips and files are deleted. This cannot be undone.</>}
          confirm="Remove account"
          danger
          onConfirm={() => {
            if (confirm) remove.mutate({ id: confirm.row.id });
            setConfirm(null);
          }}
        />
        <ConfirmDialog
          open={confirm?.kind === "ban"}
          onOpenChange={(o) => !o && setConfirm(null)}
          title={`Suspend ${confirm?.row.email ?? "this account"}?`}
          body={
            <>
              They are signed out now and cannot use the app, their API keys or MCP until reinstated. Their projects stay.
              <input className="input mt-3" placeholder="Reason (shown to them, optional)" value={banReason} onChange={(e) => setBanReason(e.target.value)} maxLength={300} aria-label="Reason" />
            </>
          }
          confirm="Suspend"
          danger
          onConfirm={() => {
            if (confirm) ban.mutate({ id: confirm.row.id, reason: banReason || undefined });
            setConfirm(null);
          }}
        />
      </main>
    </ScrollArea>
  );
}

type LimitKey = "MAX_PROJECTS_PER_USER" | "MAX_SOURCE_MINUTES_PER_DAY" | "MAX_NEW_PROJECTS_PER_HOUR";
const LIMITS: Array<{ key: LimitKey; label: string; window: string; unit: string }> = [
  { key: "MAX_PROJECTS_PER_USER", label: "Projects kept", window: "all projects the account has now", unit: "projects" },
  { key: "MAX_SOURCE_MINUTES_PER_DAY", label: "Minutes of video per day", window: "since 00:00 UTC today", unit: "minutes" },
  { key: "MAX_NEW_PROJECTS_PER_HOUR", label: "New projects per hour", window: "the last 60 minutes", unit: "projects" },
];

/** Per-user quota overrides, each next to what the account has used. Empty = the instance setting (0 = unlimited). */
function LimitsDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = useQuery(trpc.admin.users.limits.queryOptions({ id: row.id }));
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const values = draft ?? Object.fromEntries(Object.entries(q.data?.overrides ?? {}).map(([k, v]) => [k, String(v)]));
  const save = useMutation({
    ...trpc.admin.users.setLimits.mutationOptions(),
    onSuccess: () => {
      toast("Limits saved");
      void qc.invalidateQueries({ queryKey: trpc.admin.users.pathKey() });
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Limits for ${row.email}`} width={460}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const limits = Object.fromEntries(LIMITS.map(({ key }) => [key, values[key]?.trim() ? Number(values[key]) : null])) as Record<LimitKey, number | null>;
          save.mutate({ id: row.id, limits });
        }}
      >
        {LIMITS.map(({ key, label, window, unit }) => {
          const used = q.data?.usage?.[key];
          const typed = values[key]?.trim();
          const cap = typed ? Number(typed) : (q.data?.effective?.[key] ?? 0);
          const ratio = used === undefined || !cap ? 0 : used / cap;
          const state = ratio >= 1 ? { glyph: "✕", word: "Over the limit", tone: "text-err", bar: "bg-err" } : ratio >= 0.8 ? { glyph: "◷", word: "Near the limit", tone: "text-warn", bar: "bg-warn" } : null;
          return (
            <div key={key} className="flex flex-col gap-1.5">
              <label htmlFor={`limit-${key}`} className="text-xs font-semibold text-ink2">
                {label}
              </label>
              {q.isPending ? (
                <Skeleton className="h-[38px] w-full rounded-[10px]" />
              ) : (
              <input
                id={`limit-${key}`}
                className="input"
                type="number"
                min={0}
                value={values[key] ?? ""}
                placeholder={q.data ? `instance: ${q.data.instance[key] === 0 ? "unlimited" : q.data.instance[key]}` : ""}
                onChange={(e) => setDraft({ ...values, [key]: e.target.value })}
              />
              )}
              {q.isPending ? (
                <Skeleton className="h-1 w-full rounded-full" />
              ) : (
              <div className="h-1 w-full overflow-hidden rounded-full bg-sunk" aria-hidden>
                <div className={`h-full rounded-full ${state?.bar ?? "bg-acc"}`} style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }} />
              </div>
              )}
              <div className="flex min-h-4 items-center justify-between gap-2 text-xs tabular-nums text-ink3">
                <span>
                  {used === undefined ? <Skeleton className="inline-block h-3 w-32 align-middle" /> : cap ? `${num.format(used)} of ${num.format(cap)} ${unit}` : `${num.format(used)} ${unit}, no cap`} · {window}
                </span>
                <span className={`shrink-0 ${state?.tone ?? ""}`}>{state ? `${state.glyph} ${state.word}` : ""}</span>
              </div>
            </div>
          );
        })}
        <p className="text-xs text-ink3">0 = unlimited. Empty = use the instance setting.</p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-ink min-w-[5rem]" disabled={save.isPending || !q.data}>
            {save.isPending ? "…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
