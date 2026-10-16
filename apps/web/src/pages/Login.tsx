import { useState } from "react";
import { useNavigate, Navigate } from "react-router";
import { signIn, signUp, useSession } from "../lib/auth";
import { Logo, ThemeToggle } from "../App";

export function LoginPage() {
  const { data } = useSession();
  const nav = useNavigate();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (data) return <Navigate to="/" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res =
      mode === "login"
        ? await signIn.email({ email, password })
        : await signUp.email({ email, password, name: name || email.split("@")[0]! });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Something went wrong");
    else nav("/", { replace: true });
  }

  return (
    <div className="relative flex h-screen items-center justify-center overflow-auto p-6">
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
        {error && <p className="rounded-[10px] bg-err-soft px-3 py-2 text-sm text-ink">{error}</p>}
        <button className="btn-primary w-full py-2.5 text-sm" disabled={busy}>
          {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        <button type="button" className="w-full text-center text-xs text-ink3 hover:text-ink" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
          {mode === "login" ? "Need an account? Sign up" : "Have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
