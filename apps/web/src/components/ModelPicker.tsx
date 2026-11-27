import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
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
import { Trans, useLingui } from "@lingui/react/macro";
import { formatNumber } from "@reelsaw/shared";
import { useRetirementLabel } from "./ModelRetirement";

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

function PickerSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-2 text-start">
      <span className="sr-only">
        <Trans>Asking providers…</Trans>
      </span>
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
  placeholder,
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
  const { t } = useLingui();
  const trpc = useTRPC();
  const retirementLabel = useRetirementLabel();
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
  /** the provider listing a model id: its prefix, or the provider that owns that prefix (opencode-go → opencode) */
  const cardOf = (id: string) => {
    const prefix = id.split(":")[0]!;
    return providers.find((p) => p.provider === prefix || p.prefixes?.includes(prefix))?.provider ?? prefix;
  };
  // open on the current value's provider
  useEffect(() => {
    if (open) setPicked(value ? cardOf(value) : (providers.find((p) => p.available)?.provider ?? null));
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
        className="flex w-full cursor-pointer items-center gap-2 rounded-[8px] px-2 py-1.5 text-start text-sm hover:bg-sunk disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="grid h-4 w-4 shrink-0 place-items-center text-acc">{on && <Check className="h-4 w-4" />}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs">
            {/* the short name the provider column shows ("OpenAI"), not the listing's "OpenAI-compatible server (url)";
                a provider with sections names the section instead ("OpenCode Zen" / "OpenCode Go"), the only thing
                that tells two rows with the same model apart once search drops the section headings */}
            {showProvider && <span className="text-ink3">{m.group ?? stateOf(p.provider)?.title ?? p.title} · </span>}
            {m.label}
          </span>
          {m.note && <span className="block truncate text-[11px] text-ink3">{m.note}</span>}
        </span>
        {m.retirement && (
          // a word with its glyph, never colour alone; the row stays one line high (the label sits beside the name)
          <span className="shrink-0 rounded-[6px] bg-warn-soft px-1.5 py-0.5 text-[11px] font-semibold text-ink">! {retirementLabel(m.retirement)}</span>
        )}
        {needsPull && (
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[11px] font-semibold ${busy ? "text-ink3" : "bg-acc-soft text-acc-text"}`}
          >
            <Download className="h-3 w-3" />
            {busy ? t`downloading…` : t`download`}
          </span>
        )}
      </button>
    );
  };

  const statusOf = (p: PickerProvider) => {
    const s = stateOf(p.provider);
    if (p.error) return { text: t`unreachable`, tone: "text-warn" };
    if (!p.available) return { text: s?.baseUrlEnv && !s.keyEnv.length ? t`needs a URL` : t`needs a key`, tone: "text-ink3" };
    if (s?.keySource === "db" || s?.baseUrlSource === "db") return { text: t`entered here`, tone: "text-ok" };
    const installed = formatNumber(p.installedCount ?? 0);
    return { text: p.selfHosted ? t`${installed} installed` : t`from .env`, tone: "text-ink3" };
  };

  // the confirm is a dialog below this z-[80] popover: close it first
  const askClear = (provider: string) => {
    setOpen(false);
    return onClearCredentials(provider);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" role="combobox" aria-expanded={open} aria-label={label} className="input flex min-h-[38px] items-center gap-2 py-1 text-start">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={`truncate font-mono text-xs ${value ? "" : "text-ink3"}`}>{value || (placeholder ?? t`Pick a model`)}</span>
            {/* always two lines, so pickers side by side stay the same height */}
            <span className={`min-h-4 truncate text-[11px] ${current?.retirement ? "text-warn" : "text-ink3"}`}>
              {current?.retirement
                ? `! ${retirementLabel(current.retirement)}${current.note ? ` · ${current.note}` : ""}`
                : (current?.note ?? (value ? value.split(":")[0] : ""))}
            </span>
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
            placeholder={t`Search every provider, or type provider:model…`}
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
                    className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-start text-sm hover:bg-sunk"
                  >
                    <span className="w-4" />
                    <span className="min-w-0 flex-1 truncate">
                      <Trans>
                        Use <span className="font-mono text-xs">{typed}</span>
                      </Trans>
                    </span>
                    <span className="shrink-0 text-xs text-ink3">
                      <Trans>not among the matches; checked on save</Trans>
                    </span>
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
                  <div className="px-3 py-6 text-center text-sm text-ink3">{searching || loading ? <PickerSkeleton /> : t`No matches`}</div>
                )}
              </div>
            </ScrollArea>
          ) : (
            <div className="grid grid-cols-[200px_1fr]">
              <ScrollArea className="max-h-[min(400px,calc(var(--radix-popover-content-available-height)-60px))] border-e border-line">
                <div className="p-1">
                  {providers.map((p) => {
                    const st = statusOf(p);
                    const s = stateOf(p.provider);
                    return (
                      <button
                        key={p.provider}
                        type="button"
                        onClick={() => setPicked(p.provider)}
                        className={`flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-start text-sm hover:bg-sunk ${picked === p.provider ? "bg-sunk" : ""}`}
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
                  {!providers.length && <div className="px-3 py-6 text-center text-sm text-ink3">{loading ? <PickerSkeleton /> : t`No providers`}</div>}
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
                        <div className="px-3 py-6 text-center text-sm text-ink3">{loading ? <PickerSkeleton /> : t`No models of this kind here`}</div>
                      )}
                    </>
                  ) : (
                    <div className="px-3 py-6 text-center text-sm text-ink3">
                      <Trans>Pick a provider</Trans>
                    </div>
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
  const { t } = useLingui();
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
  // sections (OpenCode Zen / Go): a heading where the section changes, and, once everything is loaded,
  // the sections that came back empty with the reason ("This key cannot use OpenCode Go")
  const groups = first.groups ?? [];
  const noticeOf = (name: string) => groups.find((g) => g.name === name)?.notice;
  const heading = (name: string, notice: string | undefined) => (
    <div key={`group:${name}`} className="px-2 pb-1 pt-2 first:pt-1">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink3">{name}</div>
      {notice && <div className="text-[11px] text-ink3">{notice}</div>}
    </div>
  );
  const shownGroups = new Set(models.map((m) => m.group));
  const emptyGroups = hasMore || q ? [] : groups.filter((g) => !shownGroups.has(g.name));
  const shownCount = formatNumber(models.length);
  const totalCount = formatNumber(first.total);
  return (
    <>
      {models.map((m, i) => (
        <Fragment key={m.id}>
          {!q && m.group && m.group !== models[i - 1]?.group && heading(m.group, noticeOf(m.group))}
          {row(m)}
        </Fragment>
      ))}
      {emptyGroups.map((g) => heading(g.name, g.notice))}
      {models.length < first.total && (
        <div ref={sentinel} className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] text-ink3">
          <span>{q ? t`Showing ${shownCount} of ${totalCount} matches` : t`Showing ${shownCount} of ${totalCount}`}</span>
          {hasMore && (
            <button type="button" className="rounded-[6px] px-1.5 py-0.5 hover:bg-sunk disabled:opacity-60" disabled={rest.isFetching} onClick={loadMore}>
              {rest.isFetching ? t`Loading…` : t`Show more`}
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
  const { t } = useLingui();
  const [edit, setEdit] = useState(false);
  const parts: string[] = [];
  const last4 = state.keyLast4;
  const keyVar = state.keyEnv.find((k) => k) ?? ".env";
  const url = state.baseUrl;
  if (state.keyEnv.length)
    parts.push(state.keySource === "db" ? t`key entered here (…${last4})` : state.keySource === "env" ? t`key from ${keyVar}` : t`no key`);
  if (url) parts.push(state.baseUrlSource === "db" ? t`${url} (entered here)` : `${url} (.env)`);
  if (catalog.source === "live") parts.push(t`live listing`);
  return (
    <div className="mb-1 flex flex-col gap-1 border-b border-line px-2 pb-2 pt-1">
      <div className="flex items-center justify-between gap-2 text-[11px] text-ink3">
        <span className="truncate">{parts.join(" · ")}</span>
        <span className="flex shrink-0 gap-1">
          <button type="button" className="rounded-[6px] px-1.5 py-0.5 hover:bg-sunk" onClick={() => setEdit((v) => !v)}>
            {edit ? t`Close` : t`Edit`}
          </button>
          {(state.keySource === "db" || state.baseUrlSource === "db") && (
            <button type="button" className="rounded-[6px] px-1.5 py-0.5 hover:bg-sunk" onClick={() => void onClear(state.provider)}>
              <Trans>Remove</Trans>
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
  const { t } = useLingui();
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(state.baseUrl ?? "");
  const [hint, setHint] = useState<string | null>(null);
  const wantsKey = state.keyEnv.length > 0 || state.provider !== "openai";
  const wantsUrl = !!state.baseUrlEnv;
  const firstKeyVar = state.keyEnv[0] ?? "";
  const last4 = state.keyLast4 ?? "";
  const submit = async () => {
    setHint(null);
    const patch: { apiKey?: string | null; baseUrl?: string | null } = {};
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    if (wantsUrl && baseUrl.trim() !== (state.baseUrl ?? "")) patch.baseUrl = baseUrl.trim() || null;
    if (!Object.keys(patch).length) return setHint(wantsUrl && !state.keyEnv.length ? t`Enter the server's URL` : t`Enter a key`);
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
              ? t`The stored key cannot be read any more (the server secret changed): enter it again.`
              : (catalog.reason ?? t`Enter credentials to list its models.`)}
          </span>
        </div>
      )}
      {wantsUrl && (
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-ink2">{state.provider === "openai" ? t`Base URL (leave empty for api.openai.com)` : t`Base URL`}</span>
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
            {state.keySource === "env"
              ? t`API key (replaces ${firstKeyVar})`
              : state.keyLast4
                ? t`API key (replaces …${last4})`
                : state.keyEnv.length
                  ? t`API key`
                  : t`API key (optional)`}
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
            <Trans>Get a key</Trans> <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span />
        )}
        <span className="flex gap-1">
          {compact && (state.keySource === "db" || state.baseUrlSource === "db") && (
            <button type="button" className="btn-quiet text-xs" disabled={saving} onClick={() => void onClear(state.provider).then(() => onDone?.())}>
              <Trans>Remove</Trans>
            </button>
          )}
          <button type="submit" className="btn-primary text-xs" disabled={saving}>
            {saving ? t`Trying…` : t`Save and connect`}
          </button>
        </span>
      </div>
      <p className="text-[11px] text-ink3">
        <Trans>Stored encrypted on this server; never shown again. Saving lists the provider's models first, so a wrong key is refused.</Trans>
      </p>
    </form>
  );
}
