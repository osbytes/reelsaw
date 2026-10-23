import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { authClient } from "../lib/auth";
import { useMe } from "../lib/account";
import { toast } from "sonner";
import { useTRPC } from "../lib/trpc";

/** Settings → Account: name, email (read-only), password. */
export function AccountSection() {
  const me = useMe();
  const qc = useQueryClient();
  const trpc = useTRPC();
  const [name, setName] = useState<string | null>(null);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const shownName = name ?? me.data?.name ?? "";

  const saveName = useMutation({
    mutationFn: async (n: string) => {
      const r = await authClient.updateUser({ name: n });
      if (r.error) throw new Error(r.error.message ?? "Could not save");
    },
    onSuccess: () => {
      toast("Name saved");
      setName(null);
      void qc.invalidateQueries({ queryKey: trpc.me.pathKey() });
    },
    onError: (e) => toast.error(e.message),
  });
  const changePassword = useMutation({
    mutationFn: async () => {
      const r = await authClient.changePassword({ currentPassword: cur, newPassword: next, revokeOtherSessions: true });
      if (r.error) throw new Error(r.error.message ?? "Could not change the password");
    },
    onSuccess: () => {
      toast("Password changed; other sessions signed out");
      setCur("");
      setNext("");
    },
    onError: (e) => toast.error(e.message),
  });
  const busy = saveName.isPending || changePassword.isPending;

  return (
    <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-bold">Account</h2>
        <span className="font-mono text-xs text-ink3">{me.data?.email ?? ""}{me.data?.role === "admin" ? " · admin" : ""}</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            saveName.mutate(shownName.trim());
          }}
        >
          <label className="text-xs text-ink2">Name</label>
          <div className="flex gap-2">
            <input className="input" value={shownName} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Name" />
            <button className="btn-ghost min-w-[4.5rem]" type="submit" disabled={busy || name === null || !shownName.trim() || shownName === me.data?.name}>
              {saveName.isPending ? "…" : "Save"}
            </button>
          </div>
        </form>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            changePassword.mutate();
          }}
        >
          <label className="text-xs text-ink2">Change password</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input className="input" type="password" placeholder="Current" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" aria-label="Current password" />
            <input className="input" type="password" placeholder="New (8+ characters)" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" aria-label="New password" />
            <button className="btn-ghost min-w-[5.5rem]" type="submit" disabled={busy || !cur || next.length < 8}>
              {changePassword.isPending ? "…" : "Change"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
