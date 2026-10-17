import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
  const [busy, setBusy] = useState<"name" | "password" | null>(null);
  const shownName = name ?? me.data?.name ?? "";

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("name");
    const r = await authClient.updateUser({ name: shownName.trim() });
    setBusy(null);
    if (r.error) return toast(r.error.message ?? "Could not save");
    toast("Name saved");
    setName(null);
    void qc.invalidateQueries({ queryKey: trpc.me.pathKey() });
  };
  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("password");
    const r = await authClient.changePassword({ currentPassword: cur, newPassword: next, revokeOtherSessions: true });
    setBusy(null);
    if (r.error) return toast(r.error.message ?? "Could not change the password");
    toast("Password changed; other sessions signed out");
    setCur("");
    setNext("");
  };

  return (
    <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-bold">Account</h2>
        <span className="font-mono text-xs text-ink3">{me.data?.email ?? ""}{me.data?.role === "admin" ? " · admin" : ""}</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <form className="flex flex-col gap-2" onSubmit={(e) => void saveName(e)}>
          <label className="text-xs text-ink2">Name</label>
          <div className="flex gap-2">
            <input className="input" value={shownName} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Name" />
            <button className="btn-ghost min-w-[4.5rem]" type="submit" disabled={busy !== null || name === null || !shownName.trim() || shownName === me.data?.name}>
              {busy === "name" ? "…" : "Save"}
            </button>
          </div>
        </form>
        <form className="flex flex-col gap-2" onSubmit={(e) => void changePassword(e)}>
          <label className="text-xs text-ink2">Change password</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input className="input" type="password" placeholder="Current" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" aria-label="Current password" />
            <input className="input" type="password" placeholder="New (8+ characters)" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" aria-label="New password" />
            <button className="btn-ghost min-w-[5.5rem]" type="submit" disabled={busy !== null || !cur || next.length < 8}>
              {busy === "password" ? "…" : "Change"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
