import { useCallback, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useMutation } from "@tanstack/react-query";
import {
  REPO_URL,
  RESET_PASSWORD_CALLBACK_PATH,
  RESET_PASSWORD_DONE_NOTICE,
  RESET_PASSWORD_EXPIRED_NOTICE,
  RESET_PASSWORD_SENT_NOTICE,
  RESET_PASSWORD_UNAVAILABLE,
  resetPasswordFromSearch,
  resetPasswordPath,
} from "@reelsaw/shared";
import { requestPasswordReset, resetPassword } from "../lib/auth";
import { Captcha } from "../components/Captcha";
import { ThemeToggle } from "../App";
import { AuthCardHeader } from "../components/AuthCardHeader";
import { useSystemStatus } from "../lib/account";
import { track } from "../lib/telemetry";
import { ScrollArea } from "../components/scroll-area";
import { useDocumentTitle } from "../lib/title";
import { Skeleton, SkeletonRegion } from "../components/ui";

/** Request a reset email, or choose a new password from the emailed link (`?token=`). */
export function ResetPasswordPage() {
  const nav = useNavigate();
  const location = useLocation();
  const fromLink = resetPasswordFromSearch(location.search);
  const routedNotice = location.state && typeof location.state === "object" && "notice" in location.state && typeof location.state.notice === "string" ? location.state.notice : null;
  const [email, setEmail] = useState(fromLink.email ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [notice, setNotice] = useState<string | null>(fromLink.expired ? RESET_PASSWORD_EXPIRED_NOTICE : routedNotice);
  const status = useSystemStatus();
  const captcha = status.data?.captcha ?? null;
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaEpoch, setCaptchaEpoch] = useState(0);
  const onToken = useCallback((t: string | null) => setCaptchaToken(t), []);
  function consumeCaptcha() {
    setCaptchaToken(null);
    setCaptchaEpoch((n) => n + 1);
  }
  const choosing = !!fromLink.token;
  useDocumentTitle(fromLink.expired ? "This link expired · Reelsaw" : "Reset password · Reelsaw");

  const request = useMutation({
    mutationFn: async () => {
      const r = await requestPasswordReset({
        email: email.trim(),
        redirectTo: RESET_PASSWORD_CALLBACK_PATH,
        fetchOptions: captchaToken ? { headers: { "x-captcha-response": captchaToken } } : undefined,
      });
      if (r.error) throw new Error(r.error.message ?? "Could not send a reset link");
    },
    onSuccess: () => {
      consumeCaptcha();
      setNotice(RESET_PASSWORD_SENT_NOTICE);
      track("password_reset_requested");
      if (fromLink.expired || fromLink.token) nav(resetPasswordPath(email), { replace: true, state: { notice: RESET_PASSWORD_SENT_NOTICE } });
    },
    onError: () => consumeCaptcha(),
  });
  const save = useMutation({
    mutationFn: async () => {
      const token = fromLink.token;
      if (!token) throw new Error("This reset link is missing. Request a new one.");
      const r = await resetPassword({ newPassword: password, token });
      if (r.error) throw new Error(r.error.message ?? "Could not change the password");
    },
    onSuccess: () => {
      track("password_reset_completed");
      nav("/login", { replace: true, state: { notice: RESET_PASSWORD_DONE_NOTICE } });
    },
  });

  // a token is enough to choose a new password even if email was turned off after the link was sent
  if (!choosing && status.isPending) {
    return (
      <SkeletonRegion label="Loading…" className="mx-auto flex min-h-dvh max-w-[380px] flex-col justify-center gap-3 px-6">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-10 w-full rounded-[10px]" />
        <Skeleton className="h-10 w-full rounded-[10px]" />
      </SkeletonRegion>
    );
  }
  if (!choosing && status.data?.emailEnabled === false) {
    return (
      <AuthShell title={fromLink.expired ? "This link expired" : "Reset password"}>
        <p className="rounded-[10px] bg-warn-soft px-3 py-2 text-sm leading-relaxed text-ink">{RESET_PASSWORD_UNAVAILABLE}</p>
        <Link to="/login" className="w-full text-center text-xs text-ink3 no-underline hover:text-ink">
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  const mismatch = confirm.length > 0 && confirm !== password;
  const rawError = (choosing ? save.error?.message : request.error?.message) ?? null;
  const error = rawError && /invalid token/i.test(rawError) ? RESET_PASSWORD_EXPIRED_NOTICE : rawError;
  const busy = request.isPending || save.isPending;
  const intro = !choosing && !notice && !error ? "We'll email a link if this address has an account." : null;
  const banner = error ?? notice ?? (mismatch ? "The two passwords do not match." : intro);
  const tone = error || mismatch ? "err" : notice ? "warn" : null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (choosing) {
      if (password !== confirm) return;
      save.mutate();
      return;
    }
    if (!email.trim()) return;
    request.mutate();
  }

  return (
    <AuthShell title={fromLink.expired ? "This link expired" : choosing ? "Choose a new password" : "Reset your password"}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        {choosing ? (
          <>
            <div>
              <label className="label">New password</label>
              <input className="input" name="password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div>
              <label className="label">Confirm password</label>
              <input className="input" name="confirm-password" type="password" autoComplete="new-password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
          </>
        ) : (
          <div>
            <label className="label">Email</label>
            <input className="input" name="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        )}
        {!choosing && captcha && <Captcha key={captchaEpoch} provider={captcha.provider} siteKey={captcha.siteKey} onToken={onToken} />}
        <p className={`min-h-10 rounded-[10px] px-3 py-2 text-sm leading-relaxed ${tone === "err" ? "bg-err-soft text-ink" : tone === "warn" ? "bg-warn-soft text-ink" : "text-ink2"}`}>
          {banner ?? ""}
        </p>
        <button className="btn-primary w-full min-w-[12rem] py-2.5 text-sm" disabled={busy || (!choosing && !!captcha && !captchaToken) || (choosing && (password.length < 8 || password !== confirm))}>
          {busy ? "…" : choosing ? "Change password" : fromLink.expired ? "Send me a new link" : "Send reset link"}
        </button>
        <Link to="/login" className="w-full text-center text-xs text-ink3 no-underline hover:text-ink">
          Back to sign in
        </Link>
      </form>
    </AuthShell>
  );
}

function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <ScrollArea className="h-dvh">
      <div className="relative flex min-h-dvh items-center justify-center p-6">
        <ThemeToggle className="absolute right-4 top-4" />
        <div className="flex w-full max-w-[380px] flex-col gap-4 rounded-[18px] border border-line bg-panel p-7 shadow-pop">
          <AuthCardHeader title={title} />
          {children}
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
