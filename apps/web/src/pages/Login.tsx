import { useCallback, useState } from "react";
import { useNavigate, Navigate } from "react-router";
import { authClient, signIn, signUp, useSession } from "../lib/auth";
import { Captcha } from "../components/Captcha";
import { Logo, ThemeToggle } from "../App";
import { useSystemStatus } from "../lib/account";
import { ScrollArea } from "../components/scroll-area";

export function LoginPage() {
  const { data } = useSession();
  const nav = useNavigate();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const status = useSystemStatus();
  const signupMode = status.data?.signupMode ?? "open";
  const captcha = status.data?.captcha ?? null;
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const onToken = useCallback((t: string | null) => setCaptchaToken(t), []);
  // arriving from an OAuth authorize redirect (MCP connector): after sign-in, hand the signed query back
  const oauthQuery = /(^|&)client_id=/.test(window.location.search.slice(1)) && /(^|&)sig=/.test(window.location.search.slice(1)) ? window.location.search.slice(1) : null;

  if (data && !oauthQuery) return <Navigate to="/" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fetchOptions = captchaToken ? { headers: { "x-captcha-response": captchaToken } } : undefined;
    const res =
      mode === "login"
        ? await signIn.email({ email, password, fetchOptions })
        : await signUp.email({ email, password, name: name || email.split("@")[0]!, fetchOptions });
    if (res.error) {
      setBusy(false);
      setCaptchaToken(null);
      return setError(res.error.message ?? "Something went wrong");
    }
    if (oauthQuery) {
      const r = await authClient.$fetch<{ redirect_uri: string }>("/oauth2/continue", { method: "POST", body: { oauth_query: oauthQuery } });
      if (r.data?.redirect_uri) return window.location.assign(r.data.redirect_uri);
      setBusy(false);
      return setError(r.error?.message ?? "Could not continue the authorization");
    }
    setBusy(false);
    nav("/", { replace: true });
  }

  return (
    <ScrollArea className="h-screen">
    <div className="relative flex min-h-screen items-center justify-center p-6">
      <ThemeToggle className="absolute right-4 top-4" />
      <form onSubmit={submit} className="flex w-full max-w-[380px] flex-col gap-4 rounded-[18px] border border-line bg-panel p-7 shadow-pop">
        <Logo />
        <div>
          <h1 className="text-[26px] font-bold tracking-tight">{mode === "login" ? "Sign in" : "Create account"}</h1>
          <p className="mt-1 text-sm text-ink2">Running on <span className="font-mono text-[13px]">{window.location.host}</span></p>
        </div>
        {mode === "signup" && (
          <div>
            <label className="label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        <div>
          <label className="label">Email</label>
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label">Password</label>
          <input className="input" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
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
        {captcha && <Captcha provider={captcha.provider} siteKey={captcha.siteKey} onToken={onToken} />}
        {error && <p className="rounded-[10px] bg-err-soft px-3 py-2 text-sm text-ink">{error}</p>}
        <button className="btn-primary w-full py-2.5 text-sm" disabled={busy || (!!captcha && !captchaToken)}>
          {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        {signupMode !== "closed" ? (
          <button type="button" className="w-full text-center text-xs text-ink3 hover:text-ink" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
            {mode === "login" ? "Need an account? Sign up" : "Have an account? Sign in"}
          </button>
        ) : (
          <p className="min-h-4 text-center text-xs text-ink3">Sign-ups are closed on this instance.</p>
        )}
      </form>
    </div>
    </ScrollArea>
  );
}
