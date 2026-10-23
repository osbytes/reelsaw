import { useEffect, useState } from "react";
import { Skeleton, SkeletonRegion } from "../components/ui";
import { Navigate, useLocation } from "react-router";
import { Logo, ThemeToggle } from "../App";
import { authClient, useSession } from "../lib/auth";
import { ScrollArea } from "../components/scroll-area";
import { useDocumentTitle } from "../lib/title";

type Client = { client_id: string; name?: string; uri?: string; icon?: string };

/** OAuth consent for MCP connectors (claude.ai, Claude Desktop): who is asking, what they get, allow or deny. */
export function ConsentPage() {
  const { data, isPending } = useSession();
  const loc = useLocation();
  const q = new URLSearchParams(loc.search);
  const clientId = q.get("client_id") ?? "";
  const scopes = (q.get("scope") ?? "").split(" ").filter(Boolean);
  const [client, setClient] = useState<Client | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle("Authorize · Reelsaw");

  useEffect(() => {
    if (!clientId) return;
    void authClient.$fetch<Client>("/oauth2/public-client", { query: { client_id: clientId } }).then((r) => setClient(r.data ?? { client_id: clientId }));
  }, [clientId]);

  if (isPending)
    return (
      <SkeletonRegion className="mx-auto flex max-w-md flex-col gap-3 px-6 py-16">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="mt-2 h-10 w-full rounded-[10px]" />
      </SkeletonRegion>
    );
  if (!data) return <Navigate to={`/login${loc.search}`} replace />;

  const decide = async (accept: boolean) => {
    setBusy(true);
    setError(null);
    const r = await authClient.$fetch<{ redirect_uri: string }>("/oauth2/consent", { method: "POST", body: { accept, oauth_query: loc.search.slice(1) } });
    setBusy(false);
    if (r.error || !r.data?.redirect_uri) return setError(r.error?.message ?? "Could not record the decision");
    window.location.assign(r.data.redirect_uri);
  };

  const what: Record<string, string> = { openid: "know who you are", profile: "see your name", email: "see your email address", offline_access: "stay connected without signing in again" };
  return (
    <ScrollArea className="h-dvh">
    <div className="relative flex min-h-dvh items-center justify-center p-6">
      <ThemeToggle className="absolute right-4 top-4" />
      <div className="flex w-full max-w-[420px] flex-col gap-4 rounded-[18px] border border-line bg-panel p-7 shadow-pop">
        <Logo />
        <h1 className="text-[22px] font-bold tracking-tight">Allow access?</h1>
        <p className="text-sm leading-relaxed text-ink2">
          <b>{client?.name ?? "An application"}</b>
          {client?.uri ? <span className="text-ink3"> ({client.uri})</span> : null} wants to use Reelsaw as <b>{data.user.email}</b>: create projects, read transcripts, edit and download clips.
        </p>
        {scopes.length > 0 && (
          <ul className="list-disc pl-5 text-sm text-ink2">
            {scopes.map((s) => (
              <li key={s}>{what[s] ?? s}</li>
            ))}
          </ul>
        )}
        <p className="min-h-5 text-sm text-err">{error ?? ""}</p>
        <div className="flex gap-2">
          <button className="btn-primary min-w-[6rem]" disabled={busy || !clientId} onClick={() => void decide(true)}>
            Allow
          </button>
          <button className="btn-ghost" disabled={busy} onClick={() => void decide(false)}>
            Deny
          </button>
        </div>
        <p className="text-xs text-ink3">You can revoke this later by signing out everywhere or removing the connector on the other side.</p>
      </div>
    </div>
    </ScrollArea>
  );
}
