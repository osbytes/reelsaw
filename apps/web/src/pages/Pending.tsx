import { PENDING_APPROVAL_MESSAGE, REPO_URL } from "@reelsaw/shared";
import { ThemeToggle } from "../App";
import { AuthCardHeader } from "../components/AuthCardHeader";
import { accountNotice, signOut } from "../lib/auth";
import { Trans, useLingui } from "@lingui/react/macro";
import { useMe } from "../lib/account";
import { ScrollArea } from "../components/scroll-area";

/** Signed in, but the account is waiting for approval or suspended. The only page such an account sees. */
export function PendingPage() {
  const { t } = useLingui();
  const me = useMe();
  const blocked = me.data?.blocked;
  const suspended = blocked?.kind === "banned";
  return (
    <ScrollArea className="h-dvh">
      <div className="relative flex min-h-dvh items-center justify-center p-6">
        <ThemeToggle className="absolute end-4 top-4" />
        <div className="flex w-full max-w-[420px] flex-col gap-4 rounded-[18px] border border-line bg-panel p-7 shadow-pop">
          <AuthCardHeader title={suspended ? t`Account suspended` : t`Waiting for approval`} titleClassName="text-[22px]" />
          <p className="text-sm leading-relaxed text-ink2">
            {accountNotice(blocked?.reason ?? PENDING_APPROVAL_MESSAGE)}
            {!suspended && t` This page refreshes on its own; you can also come back later.`}
          </p>
          <p className="min-h-5 text-xs text-ink3">{me.data ? t`Signed in as ${me.data.email}` : ""}</p>
          <div className="flex gap-2">
            {!suspended && (
              <button className="btn-ghost" onClick={() => void me.refetch()} disabled={me.isFetching}>
                <Trans>Check again</Trans>
              </button>
            )}
            <button className="btn-quiet" onClick={() => signOut().then(() => window.location.assign("/login"))}>
              <Trans>Sign out</Trans>
            </button>
          </div>
        </div>
        <p className="absolute bottom-4 start-0 end-0 text-center text-xs text-ink3">
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="text-ink3 no-underline hover:text-acc-text">
            {"github.com/osbytes/reelsaw"}
          </a>
        </p>
      </div>
    </ScrollArea>
  );
}
