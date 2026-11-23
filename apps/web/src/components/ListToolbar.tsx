import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowDownUp, Check, ListFilter, Rows3, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { formatNumber } from "@reelsaw/shared";
import { useLoadMoreSentinel } from "../lib/useLoadMore";

/**
 * The one way a list is searched, filtered, grouped and sorted (docs/PRINCIPLES.md "Lists align"; Users, Projects,
 * Templates, Library). One bar directly above the list, in a fixed order:
 *
 *   [ Search ……………… ]  [Filter ·2]  [Group: Flag]  [Sort: Name ↑]  (page actions stay in the page header)
 *   1,204 accounts · Status: Pending ✕ · Flag: shared address ✕ · Clear all
 *
 * - Search is the widest control and comes first: it is what people reach for.
 * - Every filter lives in one Filter menu (radio groups per facet, "Any" first), not a row of selects: the bar keeps
 *   its width whatever the list offers, and the menu has room for counts.
 * - What narrows the list shows on the second line as a chip that removes itself, so the state is visible without
 *   opening a menu, including filters that arrive by a link and have no control (a sign-up rule, one address).
 * - The count is on that line too, above the list: how many match is the first thing a search or filter answers.
 * - Group and Sort are display choices, at the end. Sort repeats the sortable column headers so it works where the
 *   headers fold away (below 1040px) and on lists without headers (cards). Both change the server query.
 * - The second line keeps its height (`min-h-7`) whether or not anything is filtered, so the list never moves.
 */

export type ListOption = { value: string; label: string; hint?: string | undefined };

/** One filter of the Filter menu: "" is "any", always the first option. */
export type ListFacet = { id: string; label: string; value: string; options: ListOption[]; onChange: (v: string) => void };

/** A filter in force, as a removable chip. Facets make theirs; a page adds the ones that arrive by link. */
export type ActiveFilter = { id: string; label: ReactNode; title?: string | undefined; onClear: () => void };

/** The chips of the facets that are set: "Status: Pending". */
export function facetChips(facets: ListFacet[]): ActiveFilter[] {
  return facets.flatMap((f) => {
    if (!f.value) return [];
    const o = f.options.find((x) => x.value === f.value);
    const facet = f.label;
    const chosen = o?.label ?? f.value;
    return [{ id: f.id, label: t`${facet}: ${chosen}`, onClear: () => f.onChange("") }];
  });
}

const TOOLBAR_BUTTON = "btn-ghost h-[38px] shrink-0 gap-1.5 px-3 text-[13px]";
const MENU_LABEL = "px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-ink3 uppercase";

export function ListSearch({
  value,
  onChange,
  placeholder,
  label,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  className?: string;
}) {
  const { t } = useLingui();
  return (
    <div className={`relative min-w-0 ${className}`}>
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink3" aria-hidden />
      <input
        className="input h-[38px] w-full ps-9 pe-9 [&::-webkit-search-cancel-button]:appearance-none"
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            onChange("");
          }
        }}
      />
      {value && (
        <button
          type="button"
          className="absolute end-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-ink3 hover:bg-sunk hover:text-ink"
          aria-label={t`Clear search`}
          onClick={() => onChange("")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function RadioItems({ options, value, onChange, keepOpen }: { options: ListOption[]; value: string; onChange: (v: string) => void; keepOpen?: boolean }) {
  return (
    <DropdownMenu.RadioGroup value={value} onValueChange={onChange}>
      {options.map((o) => (
        <DropdownMenu.RadioItem key={o.value} value={o.value} className="menu-item ps-8 relative" onSelect={keepOpen ? (e) => e.preventDefault() : undefined}>
          <DropdownMenu.ItemIndicator className="absolute start-2.5 inline-flex">
            <Check className="h-3.5 w-3.5" />
          </DropdownMenu.ItemIndicator>
          <span className="min-w-0 truncate">{o.label}</span>
          {o.hint && <span className="menu-hint tabular-nums">{o.hint}</span>}
        </DropdownMenu.RadioItem>
      ))}
    </DropdownMenu.RadioGroup>
  );
}

/** Every filter of the list in one menu; the button counts the ones set. The menu stays open while you pick. */
export function FilterMenu({ facets }: { facets: ListFacet[] }) {
  const { t } = useLingui();
  const on = facets.filter((f) => f.value).length;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={`${TOOLBAR_BUTTON} ${on ? "text-acc-text" : ""}`} aria-label={on ? t`Filter, ${on} on` : t`Filter`}>
          <ListFilter className="h-4 w-4" aria-hidden />
          <Trans>Filter</Trans>
          {/* the badge's room is kept so the bar does not shift when the first filter goes on */}
          <span className={`min-w-4 rounded-full px-1 text-center text-[11px] tabular-nums ${on ? "bg-acc-soft" : "invisible"}`} aria-hidden>
            {on || 0}
          </span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="bottom" align="start" sideOffset={6} className="menu max-h-[min(70dvh,560px)] w-[260px] overflow-y-auto">
          {facets.map((f, i) => (
            <div key={f.id}>
              {i > 0 && <DropdownMenu.Separator className="mx-1.5 my-1 h-px bg-line" />}
              <DropdownMenu.Label className={MENU_LABEL}>{f.label}</DropdownMenu.Label>
              <RadioItems options={f.options} value={f.value} onChange={f.onChange} keepOpen />
            </div>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** A one-of-several display choice (Group): the button says what is chosen. */
export function ChoiceMenu({
  label,
  value,
  options,
  onChange,
  icon = Rows3,
}: {
  label: string;
  value: string;
  options: ListOption[];
  onChange: (v: string) => void;
  icon?: typeof Rows3;
}) {
  const { t } = useLingui();
  const Icon = icon;
  const current = options.find((o) => o.value === value)?.label ?? options[0]?.label;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={`${TOOLBAR_BUTTON} max-w-[14rem]`} aria-label={t`${label}: ${current}`}>
          <Icon className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate max-sm:hidden">
            <span className="text-ink3">{t`${label}: `}</span>
            {current}
          </span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className="menu w-[220px]">
          <DropdownMenu.Label className={MENU_LABEL}>{label}</DropdownMenu.Label>
          <RadioItems options={options} value={value} onChange={onChange} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export type SortChoice<K extends string> = { key: K; dir: "asc" | "desc" } | null;
export type SortOption<K extends string> = { value: K; label: string; firstDir: "asc" | "desc"; asc?: string; desc?: string };

/**
 * Sort: the column, then the direction. The same state as the sortable column headers (`listSortToggle`), so the two
 * never disagree. With nothing picked (null) the list is in its default order: either one of the options in its first
 * direction (`defaultKey`: Projects and Templates by last change, newest first, which stays the one entry for it and
 * can still be turned to oldest first), or an order no option names (`defaultLabel`: Users' pending, then newest).
 */
export function SortMenu<K extends string>({
  options,
  value: picked,
  onChange: change,
  defaultLabel = "",
  defaultKey,
}: {
  options: SortOption<K>[];
  value: SortChoice<K>;
  onChange: (v: SortChoice<K>) => void;
  defaultLabel?: string;
  defaultKey?: K;
}) {
  const { t } = useLingui();
  const def = defaultKey ? options.find((o) => o.value === defaultKey) : undefined;
  const value: SortChoice<K> = picked ?? (def ? { key: def.value, dir: def.firstDir } : null);
  // the default order is stored as null, so the hash and the query carry nothing for it
  const onChange = (v: SortChoice<K>) => change(v && def && v.key === def.value && v.dir === def.firstDir ? null : v);
  const cur = value ? options.find((o) => o.value === value.key) : undefined;
  const dirWords = (o: SortOption<K>) => ({ asc: o.asc ?? t`Ascending`, desc: o.desc ?? t`Descending` });
  const dirWord = cur && value ? dirWords(cur)[value.dir] : "";
  const shown = cur && value ? t`${cur.label}, ${dirWord}` : defaultLabel;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={`${TOOLBAR_BUTTON} max-w-[15rem]`} aria-label={t`Sort: ${shown}`}>
          <ArrowDownUp className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate max-sm:hidden">
            <span className="text-ink3">
              <Trans>Sort:</Trans>{" "}
            </span>
            {cur ? cur.label : defaultLabel}
          </span>
          {cur && value && (
            <span aria-hidden className="text-[10px] text-ink3 max-sm:hidden">
              {value.dir === "asc" ? "▲" : "▼"}
            </span>
          )}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className="menu w-[240px]">
          <DropdownMenu.Label className={MENU_LABEL}>
            <Trans>Sort by</Trans>
          </DropdownMenu.Label>
          <RadioItems
            options={[...(def ? [] : [{ value: "", label: defaultLabel }]), ...options.map((o) => ({ value: o.value, label: o.label }))]}
            value={value?.key ?? ""}
            onChange={(k) => {
              const o = options.find((x) => x.value === k);
              onChange(o ? { key: o.value, dir: value?.key === o.value ? value.dir : o.firstDir } : null);
            }}
            keepOpen
          />
          {cur && value && (
            <>
              <DropdownMenu.Separator className="mx-1.5 my-1 h-px bg-line" />
              <DropdownMenu.Label className={MENU_LABEL}>
                <Trans>Order</Trans>
              </DropdownMenu.Label>
              <RadioItems
                options={[
                  { value: "asc", label: dirWords(cur).asc },
                  { value: "desc", label: dirWords(cur).desc },
                ]}
                value={value.dir}
                onChange={(d) => onChange({ key: value.key, dir: d === "asc" ? "asc" : "desc" })}
              />
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * A sortable column header's click, over the same state as SortMenu: first click the column's natural direction,
 * second the other one, third back to the default order.
 */
export function listSortToggle<K extends string>(cur: SortChoice<K>, key: K, firstDir: "asc" | "desc"): SortChoice<K> {
  if (cur?.key !== key) return { key, dir: firstDir };
  return cur.dir === firstDir ? { key, dir: firstDir === "asc" ? "desc" : "asc" } : null;
}

export function ListToolbar({
  search,
  controls,
  count,
  filters = [],
  label,
}: {
  /** a `ListSearch` */
  search: ReactNode;
  /** FilterMenu, then ChoiceMenu (group), then SortMenu */
  controls?: ReactNode;
  /** "1,204 accounts", or a skeleton while the first page loads */
  count: ReactNode;
  filters?: ActiveFilter[];
  /** names the region for screen readers ("Search and filter accounts") */
  label: string;
}) {
  const { t } = useLingui();
  return (
    <search aria-label={label} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[min(100%,16rem)] flex-1">{search}</div>
        {controls && <div className="flex flex-wrap items-center gap-2">{controls}</div>}
      </div>
      <div className="flex min-h-7 flex-wrap items-center gap-1.5 text-xs text-ink3">
        <span className="me-1 tabular-nums" aria-live="polite">
          {count}
        </span>
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            className="chip max-w-[18rem] gap-1 bg-sunk text-ink2 hover:text-ink"
            title={f.title ?? t`Remove this filter`}
            onClick={f.onClear}
          >
            <span className="truncate">{f.label}</span>
            <X className="h-3 w-3 shrink-0" aria-hidden />
            <span className="sr-only">
              <Trans>Remove this filter</Trans>
            </span>
          </button>
        ))}
        {filters.length > 1 && (
          <button type="button" className="px-1 text-xs text-acc-text hover:underline" onClick={() => filters.forEach((f) => f.onClear())}>
            <Trans>Clear all</Trans>
          </button>
        )}
      </div>
    </search>
  );
}

/**
 * The end of a paged list: the next page loads on its own as the end scrolls near (the sentinel), and the button is
 * there for keyboards, for a list inside something that does not scroll, and to say what is left.
 */
export function ListLoadMore({
  hasMore,
  loading,
  busy = false,
  auto = true,
  onMore,
  left,
}: {
  hasMore: boolean;
  /** the next page is on its way */
  loading: boolean;
  /**
   * any other fetch of the list: a refetch, or the first page of a new search / filter / sort while the old one shows
   * as placeholder (its `hasNextPage` belongs to the old query). Pass `isFetching || isPlaceholderData`.
   */
  busy?: boolean;
  /** false: the button only. For sources whose pages cost someone else's quota (Library providers). */
  auto?: boolean;
  onMore: () => void;
  left?: number | undefined;
}) {
  const { t } = useLingui();
  const sentinel = useLoadMoreSentinel(onMore, auto && hasMore && !loading && !busy);
  if (!hasMore) return null;
  const n = left === undefined ? undefined : formatNumber(left);
  return (
    <>
      <span ref={sentinel} aria-hidden />
      <button type="button" className="btn-ghost h-9 min-w-[8rem] justify-center" disabled={loading || busy} onClick={onMore}>
        {loading ? t`Loading…` : n ? t`Load ${n} more` : t`Load more`}
      </button>
    </>
  );
}
