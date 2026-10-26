import { useCallback, useState } from "react";
import { useNavigate, Navigate, useLocation, Link } from "react-router";
import {
  CONFIRM_EMAIL_THEN_SIGN_IN,
  signupCreatedNotice,
  billingPlanPath,
  INTERVAL_PARAM,
  PLAN_PARAM,
  REPO_URL,
  resetPasswordPath,
  VERIFY_EMAIL_CALLBACK_PATH,
  VERIFY_EMAIL_EXPIRED_NOTICE,
  VERIFY_EMAIL_SENT_NOTICE,
  shouldOfferResendVerification,
  verifyEmailErrorFromSearch,
} from "@reelsaw/shared";
import { authClient, sendVerificationEmail, signIn, signUp, useSession } from "../lib/auth";
import { Captcha } from "../components/Captcha";
import { Logo, ThemeToggle } from "../App";
import { useSystemStatus } from "../lib/account";
import { track } from "../lib/telemetry";
import { ScrollArea } from "../components/scroll-area";
import { useDocumentTitle } from "../lib/title";

/** Where to go after the next sign-in (a plan picked on the website); kept a day, in localStorage so an email verification link in a new tab still finds it. */
export const AFTER_SIGN_IN_KEY = "reelsaw.afterSignIn";
export function takeAfterSignIn(): string | null {
  try {
    const raw = localStorage.getItem(AFTER_SIGN_IN_KEY);
    if (!raw) return null;
    localStorage.removeItem(AFTER_SIGN_IN_KEY);
    const { to, at } = JSON.parse(raw) as { to: string; at: number };
    return typeof to === "string" && to.startsWith("/") && Date.now() - at < 86_400_000 ? to : null;
  } catch {
    return null;
  }
}
function rememberAfterSignIn(to: string) {
  try {
    localStorage.setItem(AFTER_SIGN_IN_KEY, JSON.stringify({ to, at: Date.now() }));
  } catch {
    /* private mode: the user lands on the projects page instead */
  }
}

export function LoginPage({ signup = false }: { signup?: boolean }) {
  const { data } = useSession();
  const nav = useNavigate();
  const [mode, setMode] = useState<"login" | "signup">(signup ? "signup" : "login");
  // /signup?plan=pro&interval=year from the pricing page: remembered now, used after the first sign-in
  const [plan] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    const plan = q.get(PLAN_PARAM);
    if (!plan || !/^[a-z0-9_-]{1,40}$/.test(plan)) return null;
    const interval = q.get(INTERVAL_PARAM) === "year" ? "year" : "month";
    rememberAfterSignIn(billingPlanPath(plan, interval));
    return plan;
  });
  const fromLink = verifyEmailErrorFromSearch(window.location.search);
  const [email, setEmail] = useState(fromLink.email ?? "");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const location = useLocation();
  const routedNotice = location.state && typeof location.state === "object" && "notice" in location.state && typeof location.state.notice === "string" ? location.state.notice : null;
  const [expiredLink, setExpiredLink] = useState(fromLink.expired);
  const [afterSignUp, setAfterSignUp] = useState(() => typeof routedNotice === "string" && routedNotice.includes(CONFIRM_EMAIL_THEN_SIGN_IN));
  const [notice, setNotice] = useState<string | null>(fromLink.expired ? VERIFY_EMAIL_EXPIRED_NOTICE : routedNotice);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const status = useSystemStatus();
  const signupMode = status.data?.signupMode ?? "open";
  const captcha = status.data?.captcha ?? null;
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const onToken = useCallback((t: string | null) => setCaptchaToken(t), []);
  // a captcha token is single-use: after a failed attempt the widget must be solved again, so it remounts
  const [captchaAttempt, setCaptchaAttempt] = useState(0);
  // arriving from an OAuth authorize redirect (MCP connector): after sign-in, hand the signed query back
  const oauthQuery = /(^|&)client_id=/.test(window.location.search.slice(1)) && /(^|&)sig=/.test(window.location.search.slice(1)) ? window.location.search.slice(1) : null;
  const canResend = status.data?.emailEnabled !== false && shouldOfferResendVerification({ errorCode, expiredLink, afterSignUp });
  useDocumentTitle(expiredLink ? "This link expired · Reelsaw" : mode === "signup" ? "Create account · Reelsaw" : "Sign in · Reelsaw");

  if (data && !oauthQuery) return <Navigate to="/" replace />;

  async function resend(e?: React.FormEvent) {
    e?.preventDefault();
    if (!email.trim()) return setError("Enter the email you signed up with.");
    setBusy(true);
    setError(null);
    setErrorCode(null);
    const r = await sendVerificationEmail({ email: email.trim(), callbackURL: VERIFY_EMAIL_CALLBACK_PATH });
    setBusy(false);
    if (r.error) {
      setError(r.error.message ?? "Could not send a new link");
      return;
    }
    setExpiredLink(false);
    setNotice(VERIFY_EMAIL_SENT_NOTICE);
    setMode("login");
    if (window.location.search) nav("/login", { replace: true, state: { notice: VERIFY_EMAIL_SENT_NOTICE } });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (expiredLink) return resend(e);
    setBusy(true);
    setError(null);
    setErrorCode(null);
    const fetchOptions = captchaToken ? { headers: { "x-captcha-response": captchaToken } } : undefined;
    const res =
      mode === "login"
        ? await signIn.email({ email, password, fetchOptions })
        : await signUp.email({ email, password, name: name || email.split("@")[0]!, callbackURL: VERIFY_EMAIL_CALLBACK_PATH, fetchOptions });
    if (res.error) {
      setBusy(false);
      setCaptchaToken(null);
      setCaptchaAttempt((n) => n + 1);
      setErrorCode(res.error.code ?? null);
      return setError(res.error.message ?? "Something went wrong");
    }
    // Verification is required, so the account exists and there is no session. Stay here and switch
    // to sign-in with the password they just chose. Leaving for a fresh form is where a password
    // manager offers a new strong password, and that sign-in then fails.
    if (mode === "signup" && res.data && res.data.token == null) {
      const text = signupCreatedNotice(signupMode);
      setBusy(false);
      setCaptchaToken(null);
      setCaptchaAttempt((n) => n + 1);
      setNotice(text);
      setAfterSignUp(true);
      setMode("login");
      if (window.location.pathname !== "/login") nav("/login", { replace: true, state: { notice: text } });
      return;
    }
    if (oauthQuery) {
      const r = await authClient.$fetch<{ redirect_uri: string }>("/oauth2/continue", { method: "POST", body: { oauth_query: oauthQuery } });
      if (r.data?.redirect_uri) return window.location.assign(r.data.redirect_uri);
      setBusy(false);
      return setError(r.error?.message ?? "Could not continue the authorization");
    }
    setBusy(false);
    track(mode === "signup" ? "signup_completed" : "signin_completed", { plan: plan ?? undefined });
    nav(takeAfterSignIn() ?? "/", { replace: true });
  }

  return (
    <ScrollArea className="h-dvh">
    <div className="relative flex min-h-dvh items-center justify-center p-6">
      <ThemeToggle className="absolute right-4 top-4" />
      <form onSubmit={submit} className="flex w-full max-w-[380px] flex-col gap-4 rounded-[18px] border border-line bg-panel p-7 shadow-pop">
        <Logo />
        <div>
          <h1 className="text-[26px] font-bold tracking-tight">{expiredLink ? "This link expired" : mode === "login" ? "Sign in" : "Create account"}</h1>
          <p className="mt-1 text-sm text-ink2">Running on <span className="font-mono text-[13px]">{window.location.host}</span></p>
        </div>
        {mode === "signup" && (
          <div>
            <label className="label">Name</label>
            <input className="input" name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        <div>
          <label className="label">Email</label>
          <input className="input" name="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {!expiredLink && (
          <div>
            <label className="label">Password</label>
            <input
              key={mode}
              className="input"
              name="password"
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {mode === "login" && (
              <p className="mt-1.5 text-right">
                <Link to={resetPasswordPath(email)} className="text-xs text-ink3 no-underline hover:text-ink">
                  Forgot password?
                </Link>
              </p>
            )}
          </div>
        )}
        {mode === "signup" && plan && <p className="text-xs leading-relaxed text-ink2">After you sign in, you pick up where you left off: the {plan} plan.</p>}
        {mode === "signup" && signupMode === "approval" && <p className="text-xs leading-relaxed text-ink2">New accounts wait for an admin to approve them before they can start projects.</p>}
        {mode === "signup" && (status.data?.termsUrl || status.data?.privacyUrl) && (
          <p className="text-xs leading-relaxed text-ink3">
            By creating an account you accept the{" "}
            {status.data.termsUrl && <a href={status.data.termsUrl} target="_blank" rel="noreferrer">terms</a>}
            {status.data.termsUrl && status.data.privacyUrl && " and "}
            {status.data.privacyUrl && <a href={status.data.privacyUrl} target="_blank" rel="noreferrer">privacy policy</a>}.
          </p>
        )}
        {oauthQuery && <p className="text-xs leading-relaxed text-ink2">An application is asking to use Reelsaw on your behalf. Sign in to continue; you can review what it gets on the next screen.</p>}
        {!expiredLink && captcha && <Captcha key={captchaAttempt} provider={captcha.provider} siteKey={captcha.siteKey} onToken={onToken} />}
        {(error || notice) && (
          <p className={`rounded-[10px] px-3 py-2 text-sm leading-relaxed text-ink ${error ? "bg-err-soft" : "bg-warn-soft"}`}>{error ?? notice}</p>
        )}
        <button className="btn-primary w-full min-w-[12rem] py-2.5 text-sm" disabled={busy || (!expiredLink && !!captcha && !captchaToken)}>
          {busy ? "…" : expiredLink ? "Send me a new link" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        {canResend && !expiredLink && (
          <button type="button" className="w-full min-w-[12rem] text-center text-xs text-ink3 hover:text-ink" onClick={() => void resend()} disabled={busy || !email.trim()}>
            Send a new confirmation
          </button>
        )}
        {signupMode !== "closed" ? (
          <button type="button" className="w-full text-center text-xs text-ink3 hover:text-ink" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setExpiredLink(false); }}>
            {mode === "login" ? "Need an account? Sign up" : "Have an account? Sign in"}
          </button>
        ) : (
          <p className="min-h-4 text-center text-xs text-ink3">Sign-ups are closed on this instance.</p>
        )}
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
