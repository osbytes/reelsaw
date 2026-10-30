import { useMutation, useQuery } from "@tanstack/react-query";
import { Skeleton, SkeletonRegion } from "../components/ui";
import { Navigate, useLocation } from "react-router";
import { ThemeToggle } from "../App";
import { AuthCardHeader } from "../components/AuthCardHeader";
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
  useDocumentTitle("Authorize · Reelsaw");
  // where the approval goes back to: the app's name is its own claim, this address is not
  const redirectUri = q.get("redirect_uri") ?? "";
  const redirectHost = URL.canParse(redirectUri) ? new URL(redirectUri).host : "";

  const clientQ = useQuery({
    queryKey: ["oauth-public-client", clientId],
    queryFn: async () => {
      const r = await authClient.$fetch<Client>("/oauth2/public-client", { query: { client_id: clientId } });
      return r.data ?? { client_id: clientId };
    },
    enabled: !!clientId,
  });
  const client = clientQ.data;

  const decide = useMutation({
    mutationFn: async (accept: boolean) => {
      const r = await authClient.$fetch<{ redirect_uri: string }>("/oauth2/consent", { method: "POST", body: { accept, oauth_query: loc.search.slice(1) } });
      if (r.error || !r.data?.redirect_uri) throw new Error(r.error?.message ?? "Could not record the decision");
      return r.data.redirect_uri;
    },
    onSuccess: (uri) => window.location.assign(uri),
  });

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

  const what: Record<string, string> = {
    openid: "know who you are",
    profile: "see your name",
    email: "see your email address",
    offline_access: "stay connected without signing in again",
  };
  return (
    <ScrollArea className="h-dvh">
      <div className="relative flex min-h-dvh items-center justify-center p-6">
        <ThemeToggle className="absolute right-4 top-4" />
        <div className="flex w-full max-w-[420px] flex-col gap-4 rounded-[18px] border border-line bg-panel p-7 shadow-pop">
          <AuthCardHeader title="Allow access?" titleClassName="text-[22px]" />
          <p className="text-sm leading-relaxed text-ink2">
            <b>{client?.name ?? "An application"}</b>
            {client?.uri ? <span className="text-ink3"> ({client.uri})</span> : null} wants to use Reelsaw as <b>{data.user.email}</b>: create projects, read
            transcripts, edit and download clips.
          </p>
          <div className="rounded-[10px] border border-line bg-bg p-3 text-sm">
            <div className="text-xs text-ink3">After you allow, you go back to</div>
            <div className="break-all font-mono text-[15px] font-bold">{redirectHost || "an address we could not read"}</div>
            <div className="mt-1 text-xs text-ink2">
              {redirectHost ? `Only continue if you started this from ${redirectHost}.` : "Only continue if you started this yourself."}
            </div>
          </div>
          {scopes.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-ink2">
              {scopes.map((s) => (
                <li key={s}>{what[s] ?? s}</li>
              ))}
            </ul>
          )}
          <p className="min-h-5 text-sm text-err">{decide.error?.message ?? ""}</p>
          <div className="flex gap-2">
            <button className="btn-primary min-w-[6rem]" disabled={decide.isPending || !clientId} onClick={() => decide.mutate(true)}>
              Allow
            </button>
            <button className="btn-ghost" disabled={decide.isPending} onClick={() => decide.mutate(false)}>
              Deny
            </button>
          </div>
          <p className="text-xs text-ink3">You can remove this later under Settings → Connected apps.</p>
        </div>
      </div>
    </ScrollArea>
  );
}
