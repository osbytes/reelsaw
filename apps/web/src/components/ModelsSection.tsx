import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "../lib/trpc";
import { useToast } from "../lib/toast";
import { ModelPicker, type PickerProvider } from "./ModelPicker";
import { ProgressBar } from "./ui";

type Kind = "language" | "transcription" | "align";
const KINDS: Array<{ kind: Kind; title: string; help: string; catalog: "language" | "transcription" }> = [
  { kind: "language", title: "Language model", help: "Names, disfluencies, finding and scoring moments, titles.", catalog: "language" },
  { kind: "transcription", title: "Transcription", help: "Speech to words with timestamps. Must return word timestamps.", catalog: "transcription" },
  { kind: "align", title: "Alignment", help: "Re-aligns each cut on a short window. A bigger whisper here is cheap; keep it on the same server or vendor as transcription.", catalog: "transcription" },
];

function fmtBytes(n: number) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

/**
 * Settings → System → Models (admins). Swap the language, transcription and alignment models without
 * a restart: pickers list what every configured provider offers (keys stay in .env), self-hosted
 * servers show installed models and can download more with progress, and Save verifies each change
 * before it takes effect. Stages already running keep their model; the next stage uses the new one.
 */
export function ModelsSection() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const state = useQuery({ ...trpc.admin.models.get.queryOptions(), refetchInterval: (q) => (q.state.data?.pulls.some((p) => p.status === "running") ? 1000 : 10_000) });
  const language = useQuery(trpc.admin.models.catalog.queryOptions({ kind: "language" }));
  const transcription = useQuery(trpc.admin.models.catalog.queryOptions({ kind: "transcription" }));
  const catalogs = { language, transcription };
  const providers = useQuery(trpc.admin.providers.get.queryOptions());
  const refreshCatalogs = () => {
    void qc.invalidateQueries({ queryKey: trpc.admin.providers.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.admin.models.catalog.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.admin.system.pathKey() });
  };
  const saveCredentials = useMutation(trpc.admin.providers.set.mutationOptions({ onSuccess: (st) => void (toast(`${st.title} connected`), refreshCatalogs()) }));
  const clearCredentials = useMutation(trpc.admin.providers.clear.mutationOptions({ onSuccess: (st) => void (toast(`${st.title}: back to .env`), refreshCatalogs()), onError: (e) => toast(e.message) }));
  const onSaveCredentials = (provider: string, patch: { apiKey?: string | null; baseUrl?: string | null }) => saveCredentials.mutateAsync({ provider, ...patch });
  const onClearCredentials = (provider: string) => clearCredentials.mutateAsync({ provider });

  const s = state.data;
  const [draft, setDraft] = useState<Partial<Record<Kind, string>>>({});
  useEffect(() => setDraft({}), [s?.updatedAt]);
  const shown = (k: Kind) => draft[k] ?? s?.current[k] ?? "";
  const dirty = KINDS.filter(({ kind }) => draft[kind] !== undefined && draft[kind] !== s?.current[kind]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: trpc.admin.models.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.admin.system.pathKey() });
  };
  const save = useMutation(
    trpc.admin.models.set.mutationOptions({
      onSuccess: (st) => {
        setDraft({});
        toast(`Models saved: ${st.current.language} · ${st.current.transcription}`);
        invalidate();
      },
      onError: (e) => toast(e.message),
    }),
  );
  const test = useMutation(
    trpc.admin.models.test.mutationOptions({
      onSuccess: (r, input) => toast(r.ok ? `${input.id} answered in ${(r.ms / 1000).toFixed(1)} s${r.reply ? `: “${r.reply}”` : ""}` : `${input.id}: ${r.error}`),
      onError: (e) => toast(e.message),
    }),
  );
  const pull = useMutation(
    trpc.admin.models.pull.mutationOptions({
      onSuccess: (job) => {
        toast(`Downloading ${job.model}…`);
        invalidate();
      },
      onError: (e) => toast(e.message),
    }),
  );
  const cancel = useMutation(trpc.admin.models.cancelPull.mutationOptions({ onSuccess: invalidate }));
  // a finished download changes what is installed: refresh the listings once
  const running = s?.pulls.filter((p) => p.status === "running") ?? [];
  const runningKey = running.map((p) => p.id).join(",");
  useEffect(() => {
    if (!runningKey) {
      void qc.invalidateQueries({ queryKey: trpc.admin.models.catalog.pathKey() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningKey]);
  const pulling = useMemo(() => new Set(running.map((p) => `${p.provider}:${p.model}`)), [running]);

  const sourceOf = (k: Kind) => (s?.override[k] ? `set here${s.updatedBy ? ` by ${s.updatedBy}` : ""}` : k === "align" && s?.env.align === s?.env.transcription ? "follows transcription" : "from .env");

  return (
    <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-bold">Models</h2>
        <span className="text-xs text-ink3">{s?.updatedAt ? `changed ${new Date(s.updatedAt).toLocaleString()}` : "as configured in .env"}</span>
      </div>
      <p className="text-[13px] text-ink2">
        Switch models without a restart. Pick a provider, enter its key or server URL right there if it has none (stored encrypted; <span className="font-mono text-xs">.env</span> stays the default), and its models appear. A change applies to the next stage that starts; running stages finish with the model they began with.
      </p>
      {s && Object.keys(s.ignored).length > 0 && (
        <div className="rounded-[10px] border border-warn/40 bg-warn/10 px-3 py-2 text-[13px]">
          {Object.entries(s.ignored).map(([k, why]) => (
            <div key={k}>
              The saved {k} model is ignored and the .env one runs: {why}
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        {KINDS.map(({ kind, title, help, catalog }) => {
          const providerList = (catalogs[catalog].data ?? []) as PickerProvider[];
          const value = shown(kind);
          const changed = draft[kind] !== undefined && draft[kind] !== s?.current[kind];
          return (
            <div key={kind} className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <label className="text-[13px] font-semibold">{title}</label>
                <span className="text-[11px] text-ink3">{changed ? "unsaved" : sourceOf(kind)}</span>
              </div>
              <ModelPicker
                label={title}
                value={value}
                onChange={(id) => setDraft((d) => ({ ...d, [kind]: id }))}
                providers={providerList}
                states={providers.data ?? []}
                loading={catalogs[catalog].isLoading}
                onPull={(id) => pull.mutate({ id })}
                pulling={pulling}
                onSaveCredentials={onSaveCredentials}
                onClearCredentials={onClearCredentials}
                saving={saveCredentials.isPending || clearCredentials.isPending}
              />
              <p className="flex-1 text-[11px] leading-4 text-ink3">{help}</p>
              <div className="mt-auto flex min-w-0 gap-1 pt-1">
                <button type="button" className="btn-quiet text-xs" disabled={!value || test.isPending} onClick={() => test.mutate({ kind: catalog, id: value })}>
                  {test.isPending && test.variables?.id === value ? "Testing…" : "Test"}
                </button>
                {s?.override[kind] && (
                  <button type="button" className="btn-quiet min-w-0 max-w-full text-xs" title={`Back to .env: ${s.env[kind]} (applied when you Save)`} disabled={save.isPending || draft[kind] === s.env[kind]} onClick={() => setDraft((d) => ({ ...d, [kind]: s.env[kind] }))}>
                    <span className="block truncate">
                      Back to .env <span className="font-mono">({s.env[kind]})</span>
                    </span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {running.length > 0 && (
        <div className="flex flex-col gap-2 rounded-[10px] bg-sunk px-3 py-2">
          {running.map((p) => (
            <div key={p.id} className="flex flex-col gap-1 text-[13px]">
              <div className="flex items-baseline justify-between gap-2">
                <span>
                  Downloading <span className="font-mono text-xs">{p.model}</span> <span className="text-ink3">· {p.message}</span>
                </span>
                <span className="flex items-center gap-2 font-mono text-xs text-ink3">
                  {p.total > 0 ? `${fmtBytes(p.completed)} / ${fmtBytes(p.total)}` : ""}
                  <button type="button" className="btn-quiet text-xs" onClick={() => cancel.mutate({ id: p.id })}>
                    Cancel
                  </button>
                </span>
              </div>
              <ProgressBar value={p.total > 0 ? p.completed / p.total : 0} />
            </div>
          ))}
        </div>
      )}
      {s?.pulls.some((p) => p.status !== "running") && (
        <div className="text-[12px] text-ink3">
          {s.pulls
            .filter((p) => p.status !== "running")
            .slice(-3)
            .map((p) => (
              <div key={p.id}>
                {p.model}: {p.status === "done" ? "installed" : p.message}
              </div>
            ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-[12px] text-ink3">{dirty.length ? `${dirty.length} change${dirty.length === 1 ? "" : "s"} to save; each is checked first (key, server, word timestamps)` : ""}</span>
        <span className="flex gap-2">
          {dirty.length > 0 && (
            <button type="button" className="btn-quiet" onClick={() => setDraft({})}>
              Discard
            </button>
          )}
          <button type="button" className="btn-primary" disabled={!dirty.length || save.isPending} onClick={() => save.mutate(Object.fromEntries(dirty.map(({ kind }) => [kind, draft[kind]!])))}>
            {save.isPending ? "Checking…" : "Save"}
          </button>
        </span>
      </div>
    </section>
  );
}
