import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "../lib/trpc";
import { useMe } from "../lib/account";
import { useToast } from "../lib/toast";
import { ScrollArea } from "../components/scroll-area";
import { ConfirmDialog, Modal, Segmented } from "../components/ui";

type Row = { id: string; name: string; email: string; role: "user" | "admin"; status: "pending" | "active" | "suspended"; banReason: string | null; projects: number; createdAt: string; lastActive: string | null };

const STATUS: Record<Row["status"], { glyph: string; tone: string; word: string }> = {
  pending: { glyph: "◷", tone: "text-warn", word: "Pending" },
  active: { glyph: "●", tone: "text-ok", word: "Active" },
  suspended: { glyph: "✕", tone: "text-err", word: "Suspended" },
};

function ago(iso: string | null) {
  if (!iso) return "never";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Admin: who may use this instance. Pending accounts first; every action is one click plus a confirm for the destructive ones. */
export function AdminUsersPage() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const [search, setSearch] = useState("");
  const [confirm, setConfirm] = useState<{ kind: "ban" | "remove"; row: Row } | null>(null);
  const [tab, setTab] = useState<"users" | "usage">("users");
  const [limitsFor, setLimitsFor] = useState<Row | null>(null);
  const usage = useQuery({ ...trpc.admin.usage.queryOptions({ days: 30 }), enabled: tab === "usage" });
  const [banReason, setBanReason] = useState("");
  const list = useQuery({ ...trpc.admin.users.list.queryOptions({ search: search || undefined }), refetchInterval: 15_000 });
  const done = (msg: string) => () => {
    toast(msg);
    void qc.invalidateQueries({ queryKey: trpc.admin.users.pathKey() });
  };
  const fail = (e: { message: string }) => toast(e.message);
  const approve = useMutation({ ...trpc.admin.users.approve.mutationOptions(), onSuccess: done("Approved"), onError: fail });
  const setRole = useMutation({ ...trpc.admin.users.setRole.mutationOptions(), onSuccess: done("Role changed"), onError: fail });
  const ban = useMutation({ ...trpc.admin.users.ban.mutationOptions(), onSuccess: done("Suspended"), onError: fail });
  const unban = useMutation({ ...trpc.admin.users.unban.mutationOptions(), onSuccess: done("Reinstated"), onError: fail });
  const remove = useMutation({ ...trpc.admin.users.remove.mutationOptions(), onSuccess: done("Account removed"), onError: fail });
  const busy = approve.isPending || setRole.isPending || ban.isPending || unban.isPending || remove.isPending;
  const rows = (list.data ?? []) as Row[];
  const pending = rows.filter((r) => r.status === "pending").length;

  return (
    <ScrollArea className="min-h-0 flex-1">
      <main className="mx-auto flex max-w-[1040px] flex-col gap-5 px-4 py-7 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[28px] font-bold tracking-tight">Users</h1>
            <p className="mt-1 min-h-5 text-sm text-ink2">{list.data ? `${rows.length} accounts${pending ? ` · ${pending} waiting for approval` : ""}` : ""}</p>
          </div>
          <div className="flex items-center gap-2">
            <Segmented value={tab} options={[{ value: "users", label: "Accounts" }, { value: "usage", label: "Usage · 30 days" }]} onChange={setTab} size="sm" />
            {tab === "users" && <input className="input max-w-xs" placeholder="Search name or email" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search users" />}
          </div>
        </div>

        {tab === "usage" && (
          <div className="min-h-10 overflow-x-auto rounded-[16px] border border-line bg-panel">
            {usage.isLoading && <p className="p-4 text-[13px] text-ink3">Loading…</p>}
            {usage.data && (
              <table className="w-full text-[13px]">
                <thead className="text-left text-xs text-ink3">
                  <tr>
                    <th className="px-4 py-2 font-medium">Account</th>
                    <th className="px-3 py-2 text-right font-medium">Projects</th>
                    <th className="px-3 py-2 text-right font-medium">Source min</th>
                    <th className="px-3 py-2 text-right font-medium">Clips</th>
                    <th className="px-3 py-2 text-right font-medium">Model calls</th>
                    <th className="px-3 py-2 text-right font-medium">Tokens in / out</th>
                    <th className="px-3 py-2 text-right font-medium">Stored</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {usage.data.users.map((u) => (
                    <tr key={u.id}>
                      <td className="px-4 py-2">
                        <div className="truncate font-semibold">{u.name || u.email}</div>
                        <div className="truncate text-xs text-ink2">{u.email}</div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{u.projects} <span className="text-ink3">/ {u.projectsTotal}</span></td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{u.sourceMinutes}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{u.clipsRendered}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{u.llmCalls}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{(u.llmInputTokens / 1000).toFixed(0)}k / {(u.llmOutputTokens / 1000).toFixed(0)}k</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{(u.storedBytes / 1e9).toFixed(2)} GB</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        <div className={`min-h-10 text-[13px] ${tab === "usage" ? "hidden" : ""}`}>
          {list.isLoading && <span className="text-ink3">Loading…</span>}
          {list.error && <span className="text-err">✕ {list.error.message}</span>}
          {list.data && rows.length === 0 && <span className="text-ink3">No accounts match.</span>}
          {rows.length > 0 && (
            <ul className="divide-y divide-line rounded-[16px] border border-line bg-panel">
              {rows.map((r) => {
                const st = STATUS[r.status];
                const self = r.id === me.data?.id;
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                    <div className="min-w-0 flex-1 basis-[220px]">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-semibold">{r.name || r.email}</span>
                        {r.role === "admin" && <span className="chip bg-acc-soft text-acc-text">admin</span>}
                        {self && <span className="text-xs text-ink3">(you)</span>}
                      </div>
                      <div className="truncate text-xs text-ink2">{r.email}</div>
                    </div>
                    <span className={`w-24 text-xs ${st.tone}`} title={r.banReason ?? undefined}>
                      {st.glyph} {st.word}
                    </span>
                    <span className="w-28 text-xs text-ink3">{r.projects} project{r.projects === 1 ? "" : "s"}</span>
                    <span className="w-28 text-xs text-ink3">active {ago(r.lastActive)}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {r.status === "pending" && (
                        <button className="btn-primary text-xs" disabled={busy} onClick={() => approve.mutate({ id: r.id })}>
                          Approve
                        </button>
                      )}
                      {r.status === "suspended" ? (
                        <button className="btn-ghost text-xs" disabled={busy} onClick={() => unban.mutate({ id: r.id })}>
                          Reinstate
                        </button>
                      ) : (
                        !self && (
                          <button className="btn-ghost text-xs" disabled={busy} onClick={() => { setBanReason(""); setConfirm({ kind: "ban", row: r }); }}>
                            Suspend
                          </button>
                        )
                      )}
                      {!self && (
                        <button className="btn-ghost text-xs" disabled={busy} onClick={() => setRole.mutate({ id: r.id, role: r.role === "admin" ? "user" : "admin" })}>
                          {r.role === "admin" ? "Make user" : "Make admin"}
                        </button>
                      )}
                      <button className="btn-ghost text-xs" onClick={() => setLimitsFor(r)}>
                        Limits
                      </button>
                      {!self && (
                        <button className="btn-danger text-xs" disabled={busy} onClick={() => setConfirm({ kind: "remove", row: r })}>
                          Remove
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
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

const LIMIT_LABELS: Record<string, string> = { MAX_PROJECTS_PER_USER: "Projects kept", MAX_SOURCE_MINUTES_PER_DAY: "Minutes of video per day", MAX_NEW_PROJECTS_PER_HOUR: "New projects per hour" };

/** Per-user quota overrides. Empty = the instance setting (0 = unlimited). */
function LimitsDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
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
    onError: (e) => toast(e.message),
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Limits for ${row.email}`} width={440}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const limits = Object.fromEntries(Object.keys(LIMIT_LABELS).map((k) => [k, values[k]?.trim() ? Number(values[k]) : null])) as Record<"MAX_PROJECTS_PER_USER" | "MAX_SOURCE_MINUTES_PER_DAY" | "MAX_NEW_PROJECTS_PER_HOUR", number | null>;
          save.mutate({ id: row.id, limits });
        }}
      >
        {Object.entries(LIMIT_LABELS).map(([k, label]) => (
          <label key={k} className="flex flex-col gap-1 text-xs text-ink2">
            {label}
            <input
              className="input"
              type="number"
              min={0}
              value={values[k] ?? ""}
              placeholder={q.data ? `instance: ${q.data.instance[k] === 0 ? "unlimited" : q.data.instance[k]}` : ""}
              onChange={(e) => setDraft({ ...values, [k]: e.target.value })}
            />
          </label>
        ))}
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
