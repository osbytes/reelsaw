import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "../lib/trpc";
import { ConfirmDialog } from "./ui";

/**
 * Apps (claude.ai, Claude Desktop, other MCP connectors) this account allowed through the consent screen.
 * Only shown once there is one, so instances without MCP_OAUTH never see an empty section.
 */
export function ConnectedAppsSection() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<{ clientId: string; name: string } | null>(null);
  const grants = useQuery(trpc.me.oauthGrants.queryOptions());
  const revoke = useMutation(
    trpc.me.revokeOauthGrant.mutationOptions({
      onSuccess: () => {
        toast("Access removed");
        void qc.invalidateQueries({ queryKey: trpc.me.oauthGrants.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const list = grants.data ?? [];
  if (list.length === 0) return null;

  return (
    <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <h2 className="text-[15px] font-bold">Connected apps</h2>
      <p className="text-[13px] text-ink2">Apps you allowed to use Reelsaw as you. Removing one signs it out; it has to ask you again to come back.</p>
      <ul className="divide-y divide-line text-[13px]">
        {list.map((g) => {
          const name = g.name ?? "Unnamed app";
          return (
            <li key={g.clientId} className="flex min-h-[2.75rem] items-center gap-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{name}</span>
                <span className="block truncate font-mono text-xs text-ink3">{g.redirectHosts.join(", ") || "no redirect address"}</span>
              </span>
              <button className="btn-danger w-[4.5rem] text-xs" disabled={revoke.isPending} onClick={() => setConfirm({ clientId: g.clientId, name })}>
                Revoke
              </button>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Remove this app?"
        body={<>“{confirm?.name}” loses access to your account straight away.</>}
        confirm="Revoke"
        danger
        onConfirm={() => {
          if (confirm) revoke.mutate({ clientId: confirm.clientId });
          setConfirm(null);
        }}
      />
    </section>
  );
}
