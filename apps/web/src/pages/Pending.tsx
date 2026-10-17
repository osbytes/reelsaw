import { Logo, ThemeToggle } from "../App";
import { signOut } from "../lib/auth";
import { useMe } from "../lib/account";

/** Signed in, but the account is waiting for approval or suspended. The only page such an account sees. */
export function PendingPage() {
  const me = useMe();
  const blocked = me.data?.blocked;
  const suspended = blocked?.kind === "banned";
  return (
    <div className="relative flex h-screen items-center justify-center overflow-auto p-6">
      <ThemeToggle className="absolute right-4 top-4" />
      <div className="flex w-full max-w-[420px] flex-col gap-4 rounded-[18px] border border-line bg-panel p-7 shadow-pop">
        <Logo />
        <h1 className="text-[22px] font-bold tracking-tight">{suspended ? "Account suspended" : "Waiting for approval"}</h1>
        <p className="text-sm leading-relaxed text-ink2">
          {blocked?.reason ?? "Your account is waiting for an admin to approve it."}
          {!suspended && " This page refreshes on its own; you can also come back later."}
        </p>
        <p className="min-h-5 text-xs text-ink3">{me.data ? `Signed in as ${me.data.email}` : ""}</p>
        <div className="flex gap-2">
          {!suspended && (
            <button className="btn-ghost" onClick={() => void me.refetch()} disabled={me.isFetching}>
              Check again
            </button>
          )}
          <button className="btn-quiet" onClick={() => signOut().then(() => window.location.assign("/login"))}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
