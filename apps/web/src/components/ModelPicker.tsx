import { useEffect, useMemo, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@reelsaw/server";
import { Check, ChevronRight, ChevronsUpDown, Download, ExternalLink, KeyRound, Server } from "lucide-react";
import { ScrollArea } from "./scroll-area";
import { Skeleton } from "./ui";
import { useTRPC } from "../lib/trpc";
import { useDebounced } from "../lib/useDebounced";
import { useLoadMoreSentinel } from "../lib/useLoadMore";

type CatalogPage = inferRouterOutputs<AppRouter>["admin"]["models"]["catalog"];
export type PickerProvider = CatalogPage["providers"][number];
export type PickerModel = PickerProvider["models"][number];
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

/** models per provider when the picker opens, and per page after that: a Speaches registry alone lists hundreds */
const PAGE = 50;
/** matches per provider while searching */
const SEARCH_PAGE = 20;
const num = new Intl.NumberFormat();

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
 * search box searches every provider on the server (fuzzy, ranked) and lists the matches. Listings
 * come a page at a time (admin.models.catalog, the same as list_models): the first page of each
 * provider on load, the rest as the list scrolls, with "Showing 50 of 729" so the cut is never
 * silent. A self-hosted model that is not installed shows a download action. A typed id that
 * matches nothing can still be chosen ("Use <id>"), since registries lag behind new releases.
 */
export function ModelPicker({
  kind,
  value,
  onChange,
  states,
  onPull,
  pulling,
  onSaveCredentials,
  onClearCredentials,
  saving,
  label,
  placeholder = "Pick a model",
}: {
  kind: "language" | "transcription";
  value: string;
  onChange: (id: string) => void;
  states: PickerProviderState[];
  onPull?: (id: string) => void;
  pulling?: Set<string>;
  /** resolves when saved and verified; rejects with the provider's error */
  onSaveCredentials: (provider: string, patch: { apiKey?: string | null; baseUrl?: string | null }) => Promise<unknown>;
  onClearCredentials: (provider: string) => Promise<unknown>;
  saving?: boolean;
  label: string;
  placeholder?: string;
}) {
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  /** the model last chosen here, so the trigger keeps its note when it came from a later page or a search */
  const [chosen, setChosen] = useState<PickerModel | null>(null);
  const browse = useQuery(trpc.admin.models.catalog.queryOptions({ kind, limit: PAGE }));
  const providers = useMemo(() => browse.data?.providers ?? [], [browse.data]);
  const loading = browse.isPending;
  // the models in use come first in their provider's first page, so the trigger finds them here
  const known = useMemo(() => new Map(providers.flatMap((p) => p.models.map((m) => [m.id, m] as const))), [providers]);
  const current = known.get(value) ?? (chosen?.id === value ? chosen : undefined);
  const byProvider = useMemo(() => new Map(providers.map((p) => [p.provider, p])), [providers]);
  const stateOf = (provider: string) => states.find((s) => s.provider === provider);
  // open on the current value's provider
  useEffect(() => {
    if (open) setPicked(value ? value.split(":")[0]! : (providers.find((p) => p.available)?.provider ?? null));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const typed = query.trim();
  // fuzzy across every provider's models on the server (the shared Fuse search): typos, scattered
  // characters and multi-word queries ("haiku gateway") all rank by closeness
  const q = useDebounced(typed, 200);
  const search = useQuery({
    ...trpc.admin.models.catalog.queryOptions({ kind, q, limit: SEARCH_PAGE }),
    enabled: open && !!q,
    placeholderData: keepPreviousData,
  });
  const hits = typed && search.data?.q ? search.data.providers : [];
  const searching = !!typed && (typed !== q || search.isFetching);
  const canUseTyped = /^[a-z0-9_-]+:\S+$/i.test(typed) && !known.has(typed) && !hits.some((p) => p.models.some((m) => m.id === typed));
  const selected = picked ? byProvider.get(picked) : undefined;
  const selectedState = picked ? stateOf(picked) : undefined;

  const choose = (id: string, m: PickerModel | null) => {
    onChange(id);
    setChosen(m);
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
          choose(m.id, m);
        }}
        className="flex w-full cursor-pointer items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-sm hover:bg-sunk disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="grid h-4 w-4 shrink-0 place-items-center text-acc">{on && <Check className="h-4 w-4" />}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs">
            {/* the short name the provider column shows ("OpenAI"), not the listing's "OpenAI-compatible server (url)" */}
            {showProvider && <span className="text-ink3">{stateOf(p.provider)?.title ?? p.title} · </span>}
            {m.label}
          </span>
          {m.note && <span className="block truncate text-[11px] text-ink3">{m.note}</span>}
        </span>
        {needsPull && (
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[11px] font-semibold ${busy ? "text-ink3" : "bg-acc-soft text-acc-text"}`}
          >
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
    return { text: p.selfHosted ? `${num.format(p.installedCount ?? 0)} installed` : "from .env", tone: "text-ink3" };
  };

  // the confirm is a dialog below this z-[80] popover: close it first
  const askClear = (provider: string) => {
    setOpen(false);
    return onClearCredentials(provider);
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
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-[80] w-[min(640px,calc(100vw-24px))] overflow-hidden rounded-[12px] border border-line bg-panel text-ink shadow-pop"
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search every provider, or type provider:model…"
            autoFocus
            className="w-full border-b border-line bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-ink3"
          />
          {typed ? (
            <ScrollArea className="max-h-[min(360px,calc(var(--radix-popover-content-available-height)-60px))]">
              <div className="p-1">
                {canUseTyped && (
                  <button
                    type="button"
                    onClick={() => choose(typed, null)}
                    className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-sm hover:bg-sunk"
                  >
                    <span className="w-4" />
                    <span className="min-w-0 flex-1 truncate">
                      Use <span className="font-mono text-xs">{typed}</span>
                    </span>
                    <span className="shrink-0 text-xs text-ink3">not among the matches; checked on save</span>
                  </button>
                )}
                {hits.map((p) => (
                  <ModelList
                    key={`${p.provider}\n${search.data?.q}`}
                    kind={kind}
                    first={p}
                    q={search.data?.q ?? undefined}
                    limit={SEARCH_PAGE}
                    row={(m) => modelRow(m, p, true)}
                  />
                ))}
                {!canUseTyped && !hits.length && (
                  <div className="px-3 py-6 text-center text-sm text-ink3">{searching || loading ? <PickerSkeleton /> : "No matches"}</div>
                )}
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
                        <span className="grid h-4 w-4 shrink-0 place-items-center text-ink3">
                          {p.selfHosted || s?.baseUrlEnv ? <Server className="h-3.5 w-3.5" /> : <KeyRound className="h-3.5 w-3.5" />}
                        </span>
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
                    <ProviderForm
                      key={selected.provider}
                      state={selectedState}
                      catalog={selected}
                      saving={saving}
                      onSave={onSaveCredentials}
                      onClear={askClear}
                    />
                  ) : selected ? (
                    <>
                      {selectedState && (
                        <ProviderSummary state={selectedState} catalog={selected} onClear={askClear} saving={saving} onSave={onSaveCredentials} />
                      )}
                      {selected.models.length ? (
                        <ModelList key={selected.provider} kind={kind} first={selected} limit={PAGE} row={(m) => modelRow(m, selected, false)} loadOnScroll />
                      ) : (
                        <div className="px-3 py-6 text-center text-sm text-ink3">{loading ? <PickerSkeleton /> : "No models of this kind here"}</div>
                      )}
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

/**
 * One provider's models: the page already loaded (`first`), then the next pages of the same provider (and search)
 * when the list is scrolled to its end (`loadOnScroll`) or "Show more" is pressed. Says how many of how many it shows.
 * Remounted per provider and search, so switching back starts from the first page again and stays cheap.
 */
function ModelList({
  kind,
  first,
  q,
  limit,
  row,
  loadOnScroll = false,
}: {
  kind: "language" | "transcription";
  first: PickerProvider;
  q?: string | undefined;
  limit: number;
  row: (m: PickerModel) => ReactNode;
  loadOnScroll?: boolean;
}) {
  const trpc = useTRPC();
  const [more, setMore] = useState(false);
  const rest = useInfiniteQuery(
    trpc.admin.models.catalog.infiniteQueryOptions(
      { kind, provider: first.provider, limit, ...(q ? { q } : {}) },
      {
        initialCursor: first.nextCursor,
        getNextPageParam: (last) => last.providers[0]?.nextCursor ?? undefined,
        enabled: more && !!first.nextCursor,
      },
    ),
  );
  const models = useMemo(() => {
    if (!more || !rest.data) return first.models;
    const seen = new Set(first.models.map((m) => m.id));
    const out = [...first.models];
    for (const page of rest.data.pages)
      for (const m of page.providers[0]?.models ?? [])
        if (!seen.has(m.id)) {
          seen.add(m.id);
          out.push(m);
        }
    return out;
  }, [first.models, more, rest.data]);
  const hasMore = more ? rest.isPending || rest.hasNextPage : !!first.nextCursor;
  const loadMore = () => (more ? void rest.fetchNextPage() : setMore(true));
  const sentinel = useLoadMoreSentinel(loadMore, loadOnScroll && hasMore && !rest.isFetching);
  return (
    <>
      {models.map((m) => row(m))}
      {models.length < first.total && (
        <div ref={sentinel} className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] text-ink3">
          <span>
            Showing {num.format(models.length)} of {num.format(first.total)}
            {q ? " matches" : ""}
          </span>
          {hasMore && (
            <button type="button" className="rounded-[6px] px-1.5 py-0.5 hover:bg-sunk disabled:opacity-60" disabled={rest.isFetching} onClick={loadMore}>
              {rest.isFetching ? "Loading…" : "Show more"}
            </button>
          )}
        </div>
      )}
    </>
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
  saving?: boolean | undefined;
  onSave: (provider: string, patch: { apiKey?: string | null; baseUrl?: string | null }) => Promise<unknown>;
}) {
  const [edit, setEdit] = useState(false);
  const parts: string[] = [];
  if (state.keyEnv.length)
    parts.push(
      state.keySource === "db"
        ? `key entered here (…${state.keyLast4})`
        : state.keySource === "env"
          ? `key from ${state.keyEnv.find((k) => k) ?? ".env"}`
          : "no key",
    );
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
  saving?: boolean | undefined;
  onSave: (provider: string, patch: { apiKey?: string | null; baseUrl?: string | null }) => Promise<unknown>;
  onClear: (provider: string) => Promise<unknown>;
  compact?: boolean;
  onDone?: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(state.baseUrl ?? "");
  const [hint, setHint] = useState<string | null>(null);
  const wantsKey = state.keyEnv.length > 0 || state.provider !== "openai";
  const wantsUrl = !!state.baseUrlEnv;
  const submit = async () => {
    setHint(null);
    const patch: { apiKey?: string | null; baseUrl?: string | null } = {};
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    if (wantsUrl && baseUrl.trim() !== (state.baseUrl ?? "")) patch.baseUrl = baseUrl.trim() || null;
    if (!Object.keys(patch).length) return setHint(wantsUrl && !state.keyEnv.length ? "Enter the server's URL" : "Enter a key");
    try {
      await onSave(state.provider, patch);
      setApiKey("");
      onDone?.();
    } catch {
      /* mutation onError already toasted */
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
          <span className="block text-[12px] text-ink2">
            {(catalog.error ?? state.unreadable)
              ? "The stored key cannot be read any more (the server secret changed): enter it again."
              : (catalog.reason ?? "Enter credentials to list its models.")}
          </span>
        </div>
      )}
      {wantsUrl && (
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-ink2">Base URL{state.provider === "openai" ? " (leave empty for api.openai.com)" : ""}</span>
          <input
            className="input font-mono text-xs"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={state.provider === "openai" ? "http://speaches:8000/v1" : "http://host.docker.internal:11434/v1"}
            autoComplete="off"
          />
        </label>
      )}
      {wantsKey && (
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-ink2">
            API key
            {state.keySource === "env"
              ? ` (replaces ${state.keyEnv[0]})`
              : state.keyLast4
                ? ` (replaces …${state.keyLast4})`
                : state.keyEnv.length
                  ? ""
                  : " (optional)"}
          </span>
          <input
            type="password"
            className="input font-mono text-xs"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={state.keyHint ?? "…"}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      )}
      {hint && <div className="text-[12px] text-warn">{hint}</div>}
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
      <p className="text-[11px] text-ink3">
        Stored encrypted on this server; never shown again. Saving lists the provider's models first, so a wrong key is refused.
      </p>
    </form>
  );
}
