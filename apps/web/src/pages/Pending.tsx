import { PENDING_APPROVAL_MESSAGE, REPO_URL } from "@reelsaw/shared";
import { ThemeToggle } from "../App";
import { AuthCardHeader } from "../components/AuthCardHeader";
import { signOut } from "../lib/auth";
import { useMe } from "../lib/account";
import { ScrollArea } from "../components/scroll-area";

/** Signed in, but the account is waiting for approval or suspended. The only page such an account sees. */
export function PendingPage() {
  const me = useMe();
  const blocked = me.data?.blocked;
  const suspended = blocked?.kind === "banned";
  return (
    <ScrollArea className="h-dvh">
    <div className="relative flex min-h-dvh items-center justify-center p-6">
      <ThemeToggle className="absolute right-4 top-4" />
      <div className="flex w-full max-w-[420px] flex-col gap-4 rounded-[18px] border border-line bg-panel p-7 shadow-pop">
        <AuthCardHeader title={suspended ? "Account suspended" : "Waiting for approval"} titleClassName="text-[22px]" />
        <p className="text-sm leading-relaxed text-ink2">
          {blocked?.reason ?? PENDING_APPROVAL_MESSAGE}
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
      <p className="absolute bottom-4 left-0 right-0 text-center text-xs text-ink3">
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="text-ink3 no-underline hover:text-acc-text">
          github.com/osbytes/reelsaw
        </a>
      </p>
    </div>
    </ScrollArea>
  );
}
