import { useEffect, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronRight, ChevronsUpDown, Download, ExternalLink, KeyRound, Server } from "lucide-react";
import { ScrollArea } from "./scroll-area";
import { createFuzzy } from "../lib/fuzzy";
import { Skeleton } from "./ui";

export interface PickerModel {
  id: string;
  label: string;
  note?: string;
  installed?: boolean;
}
export interface PickerProvider {
  provider: string;
  title: string;
  available: boolean;
  reason?: string;
  source: "live" | "installed" | "static";
  selfHosted?: { baseUrl: string; server: "ollama" | "speaches" | "openai-compatible"; canPull: boolean };
  models: PickerModel[];
  error?: string;
}
export interface PickerProviderState {
  provider: string;
  title: string;
  keyEnv: string[];
  baseUrlEnv?: string;
  keyHint?: string;
  docsUrl?: string;
  hasKey: boolean;
  keySource: "env" | "db" | null;
  keyLast4: string | null;
  baseUrl: string | null;
  baseUrlSource: "env" | "db" | null;
  unreadable: boolean;
}

function PickerSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-2 text-left">
      <span className="sr-only">Asking providers…</span>
      {["w-2/3", "w-1/2", "w-3/5"].map((w) => (
        <Skeleton key={w} className={`h-4 ${w}`} />
      ))}
    </div>
  );
}

/**
 * Provider-first model picker, cascader style: the left column lists providers with their state
 * (configured from .env, entered here, needs a key, unreachable); the right column shows that
 * provider's models, or the inline form to enter its key / base URL when it has none. Typing in the
 * search box flattens every available provider's models into one filtered list. A self-hosted
 * model that is not installed shows a download action. A typed id that matches nothing can still
 * be chosen ("Use <id>"), since registries lag behind new releases.
 */
export function ModelPicker({
  value,
  onChange,
  providers,
  states,
  loading,
  onPull,
  pulling,
  onSaveCredentials,
  onClearCredentials,
  saving,
  label,
  placeholder = "Pick a model",
}: {
  value: string;
  onChange: (id: string) => void;
  providers: PickerProvider[];
  states: PickerProviderState[];
  loading?: boolean;
  onPull?: (id: string) => void;
  pulling?: Set<string>;
  /** resolves when saved and verified; rejects with the provider's error */
  onSaveCredentials: (provider: string, patch: { apiKey?: string | null; baseUrl?: string | null }) => Promise<unknown>;
  onClearCredentials: (provider: string) => Promise<unknown>;
  saving?: boolean;
  label: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const known = useMemo(() => new Map(providers.flatMap((p) => p.models.map((m) => [m.id, m] as const))), [providers]);
  const current = known.get(value);
  const byProvider = useMemo(() => new Map(providers.map((p) => [p.provider, p])), [providers]);
  const stateOf = (provider: string) => states.find((s) => s.provider === provider);
  // open on the current value's provider
  useEffect(() => {
    if (open) setPicked(value ? value.split(":")[0]! : (providers.find((p) => p.available)?.provider ?? null));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const typed = query.trim();
  const q = typed.toLowerCase();
  const canUseTyped = /^[a-z0-9_-]+:\S+$/i.test(typed) && !known.has(typed);
  // fuzzy across every provider's models (Fuse, shared with the command palette): typos, scattered
  // characters and multi-word queries ("haiku gateway") all rank by closeness
  const index = useMemo(
    () =>
      createFuzzy(
        providers.flatMap((p) => p.models.map((m) => ({ m, p, id: m.id, label: m.label, title: p.title, note: m.note ?? "" }))),
        [
          { name: "label", weight: 3 },
          { name: "id", weight: 2 },
          { name: "title", weight: 1 },
          { name: "note", weight: 0.5 },
        ],
      ),
    [providers],
  );
  const hits = useMemo(() => (q ? index.filter(q, 60) : []), [q, index]);
  const selected = picked ? byProvider.get(picked) : undefined;
  const selectedState = picked ? stateOf(picked) : undefined;

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  const modelRow = (m: PickerModel, p: PickerProvider, showProvider: boolean) => {
    const on = m.id === value;
    const needsPull = m.installed === false;
    const busy = pulling?.has(m.id);
    return (
      <button
        key={m.id}
        type="button"
        disabled={!p.available}
        onClick={() => {
          if (needsPull) {
            if (!busy) onPull?.(m.id);
            return;
          }
          choose(m.id);
        }}
        className="flex w-full cursor-pointer items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-sm hover:bg-sunk disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="grid h-4 w-4 shrink-0 place-items-center text-acc">{on && <Check className="h-4 w-4" />}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs">
            {showProvider && <span className="text-ink3">{p.title} · </span>}
            {m.label}
          </span>
          {m.note && <span className="block truncate text-[11px] text-ink3">{m.note}</span>}
        </span>
        {needsPull && (
          <span className={`inline-flex shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[11px] font-semibold ${busy ? "text-ink3" : "bg-acc-soft text-acc-text"}`}>
            <Download className="h-3 w-3" />
            {busy ? "downloading…" : "download"}
          </span>
        )}
      </button>
    );
  };

  const statusOf = (p: PickerProvider) => {
    const s = stateOf(p.provider);
    if (p.error) return { text: "unreachable", tone: "text-warn" };
    if (!p.available) return { text: s?.baseUrlEnv && !s.keyEnv.length ? "needs a URL" : "needs a key", tone: "text-ink3" };
    if (s?.keySource === "db" || s?.baseUrlSource === "db") return { text: "entered here", tone: "text-ok" };
    return { text: p.selfHosted ? `${p.models.filter((m) => m.installed).length} installed` : "from .env", tone: "text-ink3" };
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" role="combobox" aria-expanded={open} aria-label={label} className="input flex min-h-[38px] items-center gap-2 py-1 text-left">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={`truncate font-mono text-xs ${value ? "" : "text-ink3"}`}>{value || placeholder}</span>
            {/* always two lines, so pickers side by side stay the same height */}
            <span className="min-h-4 truncate text-[11px] text-ink3">{current?.note ?? (value ? value.split(":")[0] : "")}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-ink3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} collisionPadding={12} className="z-[80] w-[min(640px,calc(100vw-24px))] overflow-hidden rounded-[12px] border border-line bg-panel text-ink shadow-pop">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search every provider, or type provider:model…"
            autoFocus
            className="w-full border-b border-line bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-ink3"
          />
          {q ? (
            <ScrollArea className="max-h-[min(360px,calc(var(--radix-popover-content-available-height)-60px))]">
              <div className="p-1">
                {canUseTyped && (
                  <button type="button" onClick={() => choose(typed)} className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-sm hover:bg-sunk">
                    <span className="w-4" />
                    <span className="min-w-0 flex-1 truncate">
                      Use <span className="font-mono text-xs">{typed}</span>
                    </span>
                    <span className="shrink-0 text-xs text-ink3">not in any listing; checked on save</span>
                  </button>
                )}
                {hits.map(({ m, p }) => modelRow(m, p, true))}
                {!canUseTyped && !hits.length && <div className="px-3 py-6 text-center text-sm text-ink3">{loading ? <PickerSkeleton /> : "No matches"}</div>}
              </div>
            </ScrollArea>
          ) : (
            <div className="grid grid-cols-[200px_1fr]">
              <ScrollArea className="max-h-[min(400px,calc(var(--radix-popover-content-available-height)-60px))] border-r border-line">
                <div className="p-1">
                  {providers.map((p) => {
                    const st = statusOf(p);
                    const s = stateOf(p.provider);
                    return (
                      <button
                        key={p.provider}
                        type="button"
                        onClick={() => setPicked(p.provider)}
                        className={`flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-sm hover:bg-sunk ${picked === p.provider ? "bg-sunk" : ""}`}
                      >
                        <span className="grid h-4 w-4 shrink-0 place-items-center text-ink3">{p.selfHosted || s?.baseUrlEnv ? <Server className="h-3.5 w-3.5" /> : <KeyRound className="h-3.5 w-3.5" />}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px]">{s?.title ?? p.title}</span>
                          <span className={`block truncate text-[11px] ${st.tone}`}>{st.text}</span>
                        </span>
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink3" />
                      </button>
                    );
                  })}
                  {!providers.length && <div className="px-3 py-6 text-center text-sm text-ink3">{loading ? <PickerSkeleton /> : "No providers"}</div>}
                </div>
              </ScrollArea>
              <ScrollArea className="max-h-[min(400px,calc(var(--radix-popover-content-available-height)-60px))]">
                <div className="p-1">
                  {selected && selectedState && (!selected.available || selected.error) ? (
                    <ProviderForm key={selected.provider} state={selectedState} catalog={selected} saving={saving} onSave={onSaveCredentials} onClear={onClearCredentials} />
                  ) : selected ? (
                    <>
                      {selectedState && <ProviderSummary state={selectedState} catalog={selected} onClear={onClearCredentials} saving={saving} onSave={onSaveCredentials} />}
                      {selected.models.length ? selected.models.map((m) => modelRow(m, selected, false)) : <div className="px-3 py-6 text-center text-sm text-ink3">{loading ? <PickerSkeleton /> : "No models of this kind here"}</div>}
                    </>
                  ) : (
                    <div className="px-3 py-6 text-center text-sm text-ink3">Pick a provider</div>
                  )}
                </div>
              </ScrollArea>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Configured provider: where its key / URL comes from, and a way to replace or remove it. */
function ProviderSummary({
  state,
  catalog,
  onClear,
  saving,
  onSave,
}: {
  state: PickerProviderState;
  catalog: PickerProvider;
  onClear: (provider: string) => Promise<unknown>;
  saving?: boolean;
  onSave: (provider: string, patch: { apiKey?: string | null; baseUrl?: string | null }) => Promise<unknown>;
}) {
  const [edit, setEdit] = useState(false);
  const parts: string[] = [];
  if (state.keyEnv.length) parts.push(state.keySource === "db" ? `key entered here (…${state.keyLast4})` : state.keySource === "env" ? `key from ${state.keyEnv.find((k) => k) ?? ".env"}` : "no key");
  if (state.baseUrl) parts.push(`${state.baseUrl} (${state.baseUrlSource === "db" ? "entered here" : ".env"})`);
  if (catalog.source === "live") parts.push("live listing");
  return (
    <div className="mb-1 flex flex-col gap-1 border-b border-line px-2 pb-2 pt-1">
      <div className="flex items-center justify-between gap-2 text-[11px] text-ink3">
        <span className="truncate">{parts.join(" · ")}</span>
        <span className="flex shrink-0 gap-1">
          <button type="button" className="rounded-[6px] px-1.5 py-0.5 hover:bg-sunk" onClick={() => setEdit((v) => !v)}>
            {edit ? "Close" : "Edit"}
          </button>
          {(state.keySource === "db" || state.baseUrlSource === "db") && (
            <button type="button" className="rounded-[6px] px-1.5 py-0.5 hover:bg-sunk" onClick={() => void onClear(state.provider)}>
              Remove
            </button>
          )}
        </span>
      </div>
      {edit && <ProviderForm state={state} catalog={catalog} saving={saving} onSave={onSave} onClear={onClear} compact onDone={() => setEdit(false)} />}
    </div>
  );
}

/** Inline credentials form: API key (masked) and, for self-hosted providers, the base URL. Save tries them before storing. */
function ProviderForm({
  state,
  catalog,
  saving,
  onSave,
  onClear,
  compact,
  onDone,
}: {
  state: PickerProviderState;
  catalog: PickerProvider;
  saving?: boolean;
  onSave: (provider: string, patch: { apiKey?: string | null; baseUrl?: string | null }) => Promise<unknown>;
  onClear: (provider: string) => Promise<unknown>;
  compact?: boolean;
  onDone?: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(state.baseUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const wantsKey = state.keyEnv.length > 0 || state.provider !== "openai";
  const wantsUrl = !!state.baseUrlEnv;
  const submit = async () => {
    setError(null);
    const patch: { apiKey?: string | null; baseUrl?: string | null } = {};
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    if (wantsUrl && baseUrl.trim() !== (state.baseUrl ?? "")) patch.baseUrl = baseUrl.trim() || null;
    if (!Object.keys(patch).length) return setError(wantsUrl && !state.keyEnv.length ? "Enter the server's URL" : "Enter a key");
    try {
      await onSave(state.provider, patch);
      setApiKey("");
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <form
      className={`flex flex-col gap-2 ${compact ? "pt-1" : "px-2 py-2"}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {!compact && (
        <div className="text-[13px]">
          <b>{state.title}</b>
          <span className="block text-[12px] text-ink2">{catalog.error ?? state.unreadable ? "The stored key cannot be read any more (the server secret changed): enter it again." : catalog.reason ?? "Enter credentials to list its models."}</span>
        </div>
      )}
      {wantsUrl && (
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-ink2">Base URL{state.provider === "openai" ? " (leave empty for api.openai.com)" : ""}</span>
          <input className="input font-mono text-xs" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={state.provider === "openai" ? "http://speaches:8000/v1" : "http://host.docker.internal:11434/v1"} autoComplete="off" />
        </label>
      )}
      {wantsKey && (
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-ink2">
            API key{state.keySource === "env" ? ` (replaces ${state.keyEnv[0]})` : state.keyLast4 ? ` (replaces …${state.keyLast4})` : state.keyEnv.length ? "" : " (optional)"}
          </span>
          <input type="password" className="input font-mono text-xs" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={state.keyHint ?? "…"} autoComplete="off" spellCheck={false} />
        </label>
      )}
      {error && <div className="text-[12px] text-warn">{error}</div>}
      <div className="flex items-center justify-between gap-2">
        {state.docsUrl ? (
          <a href={state.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-ink3 hover:text-ink">
            Get a key <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span />
        )}
        <span className="flex gap-1">
          {compact && (state.keySource === "db" || state.baseUrlSource === "db") && (
            <button type="button" className="btn-quiet text-xs" disabled={saving} onClick={() => void onClear(state.provider).then(() => onDone?.())}>
              Remove
            </button>
          )}
          <button type="submit" className="btn-primary text-xs" disabled={saving}>
            {saving ? "Trying…" : "Save and connect"}
          </button>
        </span>
      </div>
      <p className="text-[11px] text-ink3">Stored encrypted on this server; never shown again. Saving lists the provider's models first, so a wrong key is refused.</p>
    </form>
  );
}
