import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authClient } from "../lib/auth";
import { toast } from "sonner";
import { ConfirmDialog, Skeleton, SkeletonRegion } from "./ui";
import { ScrollArea } from "./scroll-area";

type Key = { id: string; name: string | null; start: string | null; createdAt: Date | string; lastRequest: Date | string | null };

function when(d: Date | string | null | undefined) {
  if (!d) return "never";
  const t = new Date(d);
  return t.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * API keys for agents (MCP) and scripts. The secret is shown once, right after creation, with
 * ready-to-paste client configs; afterwards only its first characters are listed.
 */
export function ApiKeysSection({ mcpUrl }: { mcpUrl: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);
  const [confirm, setConfirm] = useState<Key | null>(null);

  const list = useQuery({
    queryKey: ["apiKeys"],
    queryFn: async () => {
      const r = await authClient.apiKey.list();
      if (r.error) throw new Error(r.error.message ?? "Could not load keys");
      return r.data.apiKeys as Key[];
    },
  });
  const create = useMutation({
    mutationFn: async (n: string) => {
      const r = await authClient.apiKey.create({ name: n });
      if (r.error || !r.data) throw new Error(r.error?.message ?? "Could not create the key");
      return r.data as Key & { key: string };
    },
    onSuccess: (k, n) => {
      setFresh({ name: n, key: k.key });
      setName("");
      void qc.invalidateQueries({ queryKey: ["apiKeys"] });
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const r = await authClient.apiKey.delete({ keyId: id });
      if (r.error) throw new Error(r.error.message ?? "Could not revoke the key");
    },
    onSuccess: () => {
      toast("Key revoked");
      void qc.invalidateQueries({ queryKey: ["apiKeys"] });
    },
    onError: (e) => toast.error(e.message),
  });

  const copy = (s: string, what: string) => {
    void navigator.clipboard.writeText(s).then(() => toast(`${what} copied`));
  };
  const keys = list.data ?? [];
  const claudeCmd = fresh ? `claude mcp add --transport http reelsaw ${mcpUrl} --header "Authorization: Bearer ${fresh.key}"` : "";
  const json = fresh ? JSON.stringify({ mcpServers: { reelsaw: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${fresh.key}` } } } }, null, 2) : "";
  // for clients that launch a command: `reelsaw mcp` serves the same tools over stdio from inside the app container
  const stdio = fresh
    ? JSON.stringify({ mcpServers: { reelsaw: { command: "docker", args: ["exec", "-i", "-e", `REELSAW_API_KEY=${fresh.key}`, "reelsaw-app-1", "reelsaw", "mcp"] } } }, null, 2)
        // the args array on one line: seven one-word entries do not need seven lines
        .replace(/\[\s+([^\]]+?)\s+\]/, (_, inner: string) => `[${inner.split(/,\s+/).join(", ")}]`)
    : "";

  return (
    <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-bold">API keys and MCP</h2>
        <span className="font-mono text-xs text-ink3">{mcpUrl}</span>
      </div>
      <p className="text-[13px] text-ink2">
        A key lets an agent (Claude Code, Claude Desktop, Cursor…) or a script use Reelsaw as you: create projects, read transcripts, edit and download clips. Send it as{" "}
        <span className="font-mono text-xs">Authorization: Bearer …</span>. Keys are shown once.
      </p>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate(name.trim());
        }}
      >
        <input className="input max-w-xs flex-1" placeholder="Key name, e.g. claude-code on my laptop" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} aria-label="Key name" />
        <button className="btn-ink min-w-[7.5rem]" type="submit" disabled={!name.trim() || create.isPending}>
          {create.isPending ? "Creating…" : "Create key"}
        </button>
      </form>

      {fresh && (
        <div className="flex flex-col gap-2 rounded-[12px] border border-acc/40 bg-acc-soft p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <b className="text-[13px]">
              Key “{fresh.name}” created. Copy it now; it will not be shown again.
            </b>
            <button className="btn-quiet text-xs" onClick={() => setFresh(null)} aria-label="Dismiss">
              Done
            </button>
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-[8px] bg-panel px-2 py-1 font-mono text-xs">{fresh.key}</code>
            <button className="btn-ghost text-xs" onClick={() => copy(fresh.key, "Key")}>
              Copy
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs text-ink2">
                <span>Claude Code</span>
                <button className="btn-quiet text-xs" onClick={() => copy(claudeCmd, "Command")}>
                  Copy
                </button>
              </div>
              <ScrollArea className="rounded-[8px] bg-panel">
                <pre className="w-max p-2 font-mono text-[11px] leading-4">{claudeCmd}</pre>
              </ScrollArea>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs text-ink2">
                <span>Cursor / Claude Desktop / mcp.json</span>
                <button className="btn-quiet text-xs" onClick={() => copy(json, "Config")}>
                  Copy
                </button>
              </div>
              <ScrollArea className="rounded-[8px] bg-panel">
                <pre className="w-max p-2 font-mono text-[11px] leading-4">{json}</pre>
              </ScrollArea>
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <div className="flex items-center justify-between text-xs text-ink2">
                <span>
                  Command (stdio), for clients that launch a program instead of calling a URL. <span className="font-mono">reelsaw-app-1</span> is the app container (<span className="font-mono">docker ps</span>).
                </span>
                <button className="btn-quiet text-xs" onClick={() => copy(stdio, "Config")}>
                  Copy
                </button>
              </div>
              <pre className="overflow-x-auto rounded-[8px] bg-panel p-2 font-mono text-[11px] leading-4">{stdio}</pre>
            </div>
          </div>
        </div>
      )}

      <div className="min-h-6 text-[13px]">
        {list.isPending && !list.error && (
          <SkeletonRegion label="Loading keys…" className="divide-y divide-line">
            {["w-1/3", "w-1/4"].map((w, i) => (
              <div key={i} className="flex items-center gap-3 py-2">
                <Skeleton className={`h-4 ${w}`} />
                <Skeleton className="ml-auto h-3.5 w-28" />
                <Skeleton className="h-7 w-16 rounded-[8px]" />
              </div>
            ))}
          </SkeletonRegion>
        )}
        {list.error && <span className="text-err">✕ {list.error.message}</span>}
        {list.data && keys.length === 0 && <span className="text-ink3">No keys yet.</span>}
        {keys.length > 0 && (
          <ul className="divide-y divide-line">
            <li aria-hidden className="hidden grid-cols-[minmax(0,1fr)_5rem_9rem_9.5rem_5rem] items-center gap-x-3 pb-1 text-xs text-ink3 sm:grid">
              <span>Name</span>
              <span>Key</span>
              <span>Created</span>
              <span>Last used</span>
              <span />
            </li>
            {keys.map((k) => (
              <li key={k.id} className="grid min-h-[3.25rem] grid-cols-[minmax(0,1fr)_5rem] items-center gap-x-3 gap-y-0.5 py-2 sm:min-h-[2.75rem] sm:grid-cols-[minmax(0,1fr)_5rem_9rem_9.5rem_5rem]">
                <span className="truncate font-semibold">{k.name ?? "unnamed"}</span>
                <span className="row-span-2 row-start-1 col-start-2 justify-self-end sm:order-last sm:row-span-1 sm:col-start-5">
                  <button className="btn-danger w-[4.5rem] text-xs" onClick={() => setConfirm(k)} disabled={remove.isPending}>
                    Revoke
                  </button>
                </span>
                <span className="hidden font-mono text-xs text-ink2 sm:block">{k.start ?? "rs_"}…</span>
                <span className="col-span-1 truncate text-xs text-ink3 sm:hidden">
                  {k.start ?? "rs_"}… · created {when(k.createdAt)} · used {when(k.lastRequest)}
                </span>
                <span className="hidden text-xs text-ink3 sm:block">created {when(k.createdAt)}</span>
                <span className="hidden text-xs text-ink3 sm:block">last used {when(k.lastRequest)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Revoke this key?"
        body={
          <>
            Anything using “{confirm?.name ?? "this key"}” stops working immediately.
          </>
        }
        confirm="Revoke"
        danger
        onConfirm={() => {
          if (confirm) remove.mutate(confirm.id);
          setConfirm(null);
        }}
      />
    </section>
  );
}
