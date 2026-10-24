import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MUST_CHANGE_PASSWORD_COPY, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, REPO_URL } from "@reelsaw/shared";
import { Logo, ThemeToggle } from "../App";
import { signOut } from "../lib/auth";
import { useMe } from "../lib/account";
import { useTRPC } from "../lib/trpc";
import { ScrollArea } from "../components/scroll-area";
import { useDocumentTitle } from "../lib/title";

/**
 * After `reelsaw set-password --must-change`. Blocking page, not a dismissible dialog: every
 * protected route lands here until they pick a new password. The session is the proof they knew
 * the temporary one, so there is no current-password field.
 */
export function MustChangePasswordPage() {
  const me = useMe();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  useDocumentTitle("Choose a password · Reelsaw");

  const save = useMutation({
    ...trpc.me.completePasswordChange.mutationOptions(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.me.pathKey() }),
  });
  const mismatch = confirm.length > 0 && password !== confirm;
  const tooShort = password.length > 0 && password.length < PASSWORD_MIN_LENGTH;
  const busy = save.isPending;

  return (
    <ScrollArea className="h-dvh">
      <div className="relative flex min-h-dvh items-center justify-center p-6">
        <ThemeToggle className="absolute right-4 top-4" />
        <form
          className="flex w-full max-w-[420px] flex-col gap-4 rounded-[18px] border border-line bg-panel p-7 shadow-pop"
          onSubmit={(e) => {
            e.preventDefault();
            if (password.length < PASSWORD_MIN_LENGTH || password !== confirm) return;
            save.mutate({ password });
          }}
        >
          <Logo />
          <h1 className="text-[22px] font-bold tracking-tight">Choose a password</h1>
          <p className="text-sm leading-relaxed text-ink2">{MUST_CHANGE_PASSWORD_COPY}</p>
          <p className="min-h-5 text-xs text-ink3">{me.data ? `Signed in as ${me.data.email}` : ""}</p>
          <div>
            <label className="label">New password</label>
            <input
              className="input"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="label">Confirm</label>
            <input
              className="input"
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
          {(save.error || mismatch || tooShort) && (
            <p className="rounded-[10px] bg-err-soft px-3 py-2 text-sm leading-relaxed text-ink">
              {save.error?.message ?? (tooShort ? "Use at least 8 characters." : "The two passwords do not match.")}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary min-w-[8rem] py-2.5 text-sm" disabled={busy || password.length < PASSWORD_MIN_LENGTH || password !== confirm}>
              {busy ? "…" : "Save password"}
            </button>
            <button type="button" className="btn-quiet" onClick={() => signOut().then(() => window.location.assign("/login"))}>
              Sign out
            </button>
          </div>
        </form>
        <p className="absolute bottom-4 left-0 right-0 text-center text-xs text-ink3">
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="text-ink3 no-underline hover:text-acc-text">
            github.com/osbytes/reelsaw
          </a>
        </p>
      </div>
    </ScrollArea>
  );
}
