import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "../lib/trpc";
import { toast } from "sonner";
import { ModelPicker } from "./ModelPicker";
import { PANEL_FOCUS_CLEARANCE, StickyPanelFooter } from "./StickyPanelFooter";
import { ConfirmDialog, ProgressBar, Skeleton } from "./ui";
import { formatBytes, formatDateTime, formatNumber } from "@reelsaw/shared";
import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";

type Kind = "language" | "transcription" | "align";
const KINDS: Array<{ kind: Kind; title: MessageDescriptor; help: MessageDescriptor; catalog: "language" | "transcription" }> = [
  { kind: "language", title: msg`Language model`, help: msg`Names, disfluencies, finding and scoring moments, titles.`, catalog: "language" },
  { kind: "transcription", title: msg`Transcription`, help: msg`Speech to words with timestamps. Must return word timestamps.`, catalog: "transcription" },
  {
    kind: "align",
    title: msg`Alignment`,
    help: msg`Re-aligns each cut on a short window. A bigger whisper here is cheap; keep it on the same server or vendor as transcription.`,
    catalog: "transcription",
  },
];

/**
 * Settings → System → Models (admins). Swap the language, transcription and alignment models without
 * a restart: pickers list what every configured provider offers (keys stay in .env), self-hosted
 * servers show installed models and can download more with progress, and Save verifies each change
 * before it takes effect. Stages already running keep their model; the next stage uses the new one.
 */
export function ModelsSection() {
  const { t } = useLingui();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const state = useQuery({
    ...trpc.admin.models.get.queryOptions(),
    refetchInterval: (q) => (q.state.data?.pulls.some((p) => p.status === "running") ? 1000 : 10_000),
  });
  // each picker loads its own listing a page at a time (ModelPicker → admin.models.catalog)
  const providers = useQuery(trpc.admin.providers.get.queryOptions());
  const refreshCatalogs = () => {
    void qc.invalidateQueries({ queryKey: trpc.admin.providers.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.admin.models.catalog.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.admin.system.pathKey() });
  };
  const saveCredentials = useMutation(
    trpc.admin.providers.set.mutationOptions({
      onSuccess: (st) => {
        const title = st.title;
        toast(t`${title} connected`);
        refreshCatalogs();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const clearCredentials = useMutation(
    trpc.admin.providers.clear.mutationOptions({
      onSuccess: (st) => {
        const title = st.title;
        toast(t`${title}: back to .env`);
        refreshCatalogs();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const onSaveCredentials = (provider: string, patch: { apiKey?: string | null; baseUrl?: string | null }) =>
    saveCredentials.mutateAsync({ provider, ...patch });
  const [clearing, setClearing] = useState<string | null>(null);
  const clearingTitle = providers.data?.find((p) => p.provider === clearing)?.title ?? clearing;
  // the pickers only ask; the dialog below does it
  const onClearCredentials = async (provider: string) => setClearing(provider);

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
        const language = st.current.language;
        const transcription = st.current.transcription;
        toast(t`Models saved: ${language} · ${transcription}`);
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const test = useMutation(
    trpc.admin.models.test.mutationOptions({
      onSuccess: (r, input) => {
        const id = input.id;
        const secs = formatNumber(r.ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
        if (!r.ok) return void toast(`${id}: ${r.error}`);
        const reply = r.reply;
        toast(reply ? t`${id} answered in ${secs} s: “${reply}”` : t`${id} answered in ${secs} s`);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const pull = useMutation(
    trpc.admin.models.pull.mutationOptions({
      onSuccess: (job) => {
        const model = job.model;
        toast(t`Downloading ${model}…`);
        invalidate();
      },
      onError: (e) => toast.error(e.message),
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
  // keyed by the models, not the poll: progress ticks every second and must not hand the pickers a new Set each time
  const pullingKey = running.map((p) => `${p.provider}:${p.model}`).join("\n");
  const pulling = useMemo(() => new Set(pullingKey ? pullingKey.split("\n") : []), [pullingKey]);

  const updatedBy = s?.updatedBy;
  const sourceOf = (k: Kind) =>
    s?.override[k]
      ? updatedBy
        ? t`set here by ${updatedBy}`
        : t`set here`
      : k === "align" && s?.env.align === s?.env.transcription
        ? t`follows transcription`
        : t`from .env`;
  const changedAt = s?.updatedAt ? formatDateTime(s.updatedAt) : "";
  const changes = dirty.length;

  return (
    <section className={`flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5 ${PANEL_FOCUS_CLEARANCE}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-bold">
          <Trans>Models</Trans>
        </h2>
        <span className="text-xs text-ink3">{s?.updatedAt ? t`changed ${changedAt}` : t`as configured in .env`}</span>
      </div>
      <p className="text-[13px] text-ink2">
        <Trans>
          Switch models without a restart. Pick a provider, enter its key or server URL right there if it has none (stored encrypted;{" "}
          <span className="font-mono text-xs">.env</span> stays the default), and its models appear. A change applies to the next stage that starts; running
          stages finish with the model they began with.
        </Trans>
      </p>
      {s && Object.keys(s.ignored).length > 0 && (
        <div className="rounded-[10px] border border-warn/40 bg-warn/10 px-3 py-2 text-[13px]">
          {Object.entries(s.ignored).map(([k, why]) => (
            <div key={k}>
              <Trans>
                The saved {k} model is ignored and the .env one runs: {why}
              </Trans>
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        {KINDS.map(({ kind, title: titleMsg, help: helpMsg, catalog }) => {
          const title = i18n._(titleMsg);
          const help = i18n._(helpMsg);
          if (!s)
            return (
              <div key={kind} role="status" className="flex min-w-0 flex-col gap-1.5">
                <span className="sr-only">
                  <Trans>Loading {title}…</Trans>
                </span>
                <div className="flex h-[18px] items-center justify-between gap-2">
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className="h-3 w-14" />
                </div>
                <Skeleton className="h-[38px] w-full rounded-[10px]" />
              </div>
            );
          const value = shown(kind);
          const envModel = s.env[kind];
          const changed = draft[kind] !== undefined && draft[kind] !== s?.current[kind];
          return (
            <div key={kind} className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <label className="text-[13px] font-semibold">{title}</label>
                <span className="text-[11px] text-ink3">{changed ? t`unsaved` : sourceOf(kind)}</span>
              </div>
              <ModelPicker
                kind={catalog}
                label={title}
                value={value}
                onChange={(id) => setDraft((d) => ({ ...d, [kind]: id }))}
                states={providers.data ?? []}
                onPull={(id) => pull.mutate({ id })}
                pulling={pulling}
                onSaveCredentials={onSaveCredentials}
                onClearCredentials={onClearCredentials}
                saving={saveCredentials.isPending || clearCredentials.isPending}
              />
              <p className="flex-1 text-[11px] leading-4 text-ink3">{help}</p>
              <div className="mt-auto flex min-w-0 gap-1 pt-1">
                <button
                  type="button"
                  className="btn-quiet text-xs"
                  disabled={!value || test.isPending}
                  onClick={() => test.mutate({ kind: catalog, id: value })}
                >
                  {test.isPending && test.variables?.id === value ? t`Testing…` : t`Test`}
                </button>
                {s?.override[kind] && (
                  <button
                    type="button"
                    className="btn-quiet min-w-0 max-w-full text-xs"
                    title={t`Back to .env: ${envModel} (applied when you Save)`}
                    disabled={save.isPending || draft[kind] === s.env[kind]}
                    onClick={() => setDraft((d) => ({ ...d, [kind]: s.env[kind] }))}
                  >
                    <span className="block truncate">
                      <Trans>
                        Back to .env <span className="font-mono">({envModel})</span>
                      </Trans>
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
                  <Trans>
                    Downloading <span className="font-mono text-xs">{p.model}</span> <span className="text-ink3">· {p.message}</span>
                  </Trans>
                </span>
                <span className="flex items-center gap-2 font-mono text-xs text-ink3">
                  {p.total > 0 ? `${formatBytes(p.completed)} / ${formatBytes(p.total)}` : ""}
                  <button type="button" className="btn-quiet text-xs" onClick={() => cancel.mutate({ id: p.id })}>
                    <Trans>Cancel</Trans>
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
                {p.model}: {p.status === "done" ? t`installed` : p.message}
              </div>
            ))}
        </div>
      )}
      <ConfirmDialog
        open={clearing !== null}
        onOpenChange={(o) => !o && setClearing(null)}
        title={clearingTitle ? t`Remove the ${clearingTitle} credentials saved here?` : t`Remove the provider credentials saved here?`}
        body={t`The saved key and server address are deleted and this provider falls back to .env. Without credentials there, its models stop working for everyone until the key is entered again.`}
        confirm={t`Remove`}
        danger
        onConfirm={() => (clearing ? clearCredentials.mutateAsync({ provider: clearing }) : Promise.resolve())}
      />
      <StickyPanelFooter>
        <span className="me-auto text-[12px] text-ink3">
          {dirty.length
            ? plural(changes, {
                one: "# change to save; each is checked first (key, server, word timestamps)",
                other: "# changes to save; each is checked first (key, server, word timestamps)",
              })
            : ""}
        </span>
        <span className="flex gap-2">
          {/* always there, like every panel's footer, so the row does not shift when a change appears */}
          <button type="button" className="btn-quiet" disabled={!dirty.length || save.isPending} onClick={() => setDraft({})}>
            <Trans>Discard</Trans>
          </button>
          <button
            type="button"
            className="btn-primary min-w-[6.5rem]"
            disabled={!dirty.length || save.isPending}
            onClick={() => save.mutate(Object.fromEntries(dirty.map(({ kind }) => [kind, draft[kind]!])))}
          >
            {save.isPending ? t`Checking…` : t`Save`}
          </button>
        </span>
      </StickyPanelFooter>
    </section>
  );
}
