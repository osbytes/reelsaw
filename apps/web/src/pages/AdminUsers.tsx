import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC, useTRPCClient } from "../lib/trpc";
import { useMe } from "../lib/account";
import { readHash, useHashParams, writeHash } from "../lib/hash";
import { ChevronRight, Users } from "lucide-react";
import { toast } from "sonner";
import {
  ABUSE_FLAGS,
  ADDRESS_FLAGS,
  type AbuseFlag,
  type FlagGroup,
  formatBytes,
  inFlagGroup,
  IP_GROUP_REST,
  isAbuseFlag,
  isUserGroupBy,
  isUserSortKey,
  type SortDir,
  type UserGroupBy,
  type UserSortKey,
  userSortFirstDir,
  formatNumber,
  formatPriority,
  QUEUE_PRIORITY_MAX,
  QUEUE_PRIORITY_MIN,
  RESOURCE_CEILING_MAX_CORES,
  RESOURCE_CEILING_MAX_MEM_MB,
} from "@reelsaw/shared";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg, plural, t } from "@lingui/core/macro";
import { i18n, type MessageDescriptor } from "@lingui/core";
import { ago } from "../lib/time";
import { ScrollArea } from "../components/scroll-area";
import {
  LIST_ACTION,
  LIST_MENU,
  LIST_MENU_ITEM_FOLDED,
  LIST_REVEAL_ROW,
  LIST_SKELETON_ROWS,
  LIST_SUB,
  LIST_TITLE,
  ListCell,
  type ListColumn,
  ListEmpty,
  ListError,
  ListFooter,
  ListPage,
  ListRow,
  ListTable,
} from "../components/ListPage";
import { SelectionBar } from "../components/SelectionBar";
import { RuleFromUserDialog } from "../components/SignupRules";
import { ConfirmDialog, Modal, MoreButton, Segmented, Select, Skeleton } from "../components/ui";
import {
  type ActiveFilter,
  ChoiceMenu,
  FilterMenu,
  facetChips,
  type ListFacet,
  ListLoadMore,
  ListSearch,
  ListToolbar,
  listSortToggle,
  type SortOption,
  SortMenu,
} from "../components/ListToolbar";
import { pageTitle, useDocumentTitle } from "../lib/title";
import { useDebounced } from "../lib/useDebounced";

type Usage = {
  projects: number;
  sourceMinutes: number;
  clipsRendered: number;
  storedBytes: number;
  llmCalls: number;
  llmInputTokens: number;
  llmOutputTokens: number;
};
type Status = "pending" | "active" | "suspended";
type Row = {
  id: string;
  name: string;
  email: string;
  /** the address was confirmed (the verification link, or a sign-in provider that vouches for it) */
  emailVerified: boolean;
  role: "user" | "admin";
  status: Status;
  banReason: string | null;
  projects: number;
  createdAt: string;
  lastActive: string | null;
  usage: Usage /** the plan in force (hosted); null when this instance has no plans */;
  plan: string | null /** abuse flags from the hourly pass (abuse.ts) */;
  flags: string[];
  signupIp: string | null;
  /** the sign-up rule that held it for approval ("ip 203.0.113.0/24"); admins only, the account is never told */
  heldBy: string | null;
  mustChangePassword: boolean;
};
/** The "Flag" filter: any reason, or one. In the hash as flagged=1 or flag=shared_ip. */
type FlagFilter = "" | "any" | AbuseFlag;
const readFlag = (h: URLSearchParams): FlagFilter => {
  const f = h.get("flag");
  return isAbuseFlag(f) ? f : h.get("flagged") === "1" ? "any" : "";
};
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** The abuse flags in the active locale (keys from @reelsaw/shared; its English labels are for the CLI). */
const FLAG_NAME: Record<AbuseFlag, MessageDescriptor> = {
  shared_ip: msg`shared ip`,
  signup_burst: msg`signup burst`,
  disposable_email: msg`disposable email`,
};
const FLAG_SENTENCE: Record<AbuseFlag, MessageDescriptor> = {
  shared_ip: msg`Three or more accounts signed up from the same address in the last 7 days`,
  signup_burst: msg`Five or more accounts from the same address within one hour`,
  disposable_email: msg`The email domain is a known temporary-address service`,
};
const flagName = (f: AbuseFlag) => i18n._(FLAG_NAME[f]);
const accountsCount = (n: number) => plural(n, { one: "# account", other: "# accounts" });
const sectionsCount = (n: number) => plural(n, { one: "# section", other: "# sections" });
/**
 * "Group": one section per abuse reason (then the unflagged), with the address flags split by sign-up address; one
 * section per shared sign-up address (then the rest); or one flat list. In the hash as group=flag or group=ip.
 */
const groupOptions = () => [
  { value: "", label: t`None` },
  { value: "flag", label: t`Flag` },
  { value: "ip", label: t`Sign-up address` },
];
const asGroup = (v: string | null): UserGroupBy | "" => (isUserGroupBy(v) ? v : "");
type UserFilterInput = {
  q?: string | undefined;
  flagged?: boolean | undefined;
  flag?: AbuseFlag | undefined;
  status?: Status | undefined;
  verified?: boolean | undefined;
  heldBy?: string | undefined;
  signupIp?: string | undefined;
  sharedIp?: boolean | undefined;
  group?: { by: "flag"; key: FlagGroup } | undefined;
};
/** A section of the grouped list as the server returns it: its key, words, count over the filter, and the filter that is exactly it. */
type SectionData = { key: string; label: string; help: string; total: number; filter: UserFilterInput };
/**
 * What "every match" means for the selection bar: the whole filtered list (`id` null), or one section of it (a
 * flag, an address, or an address inside a flag). `covers` says which loaded rows that is, so they show checked.
 */
type AllOf = { id: string | null; filter: UserFilterInput; label: string; total: number; covers: (r: Row) => boolean };
const isFlagKey = (k: string): k is FlagGroup => k === "none" || isAbuseFlag(k);
/** Which loaded rows a section holds: the same rule as its server filter, for the rows the page has. */
function sectionCovers(by: UserGroupBy, key: string, siblings: readonly SectionData[]): (r: Row) => boolean {
  if (by === "flag") return (r) => isFlagKey(key) && inFlagGroup(r.flags, key);
  if (key !== IP_GROUP_REST) return (r) => r.signupIp === key;
  const shared = new Set(siblings.map((g) => g.key));
  return (r) => !r.signupIp || !shared.has(r.signupIp);
}
/** A flag section the page splits by sign-up address: several accounts from one address is what the flag means. */
const byAddress = (k: string) => ADDRESS_FLAGS.some((f) => f === k);
/**
 * The column the server orders every match by (never only the loaded rows: PRINCIPLES "Sorting happens in the
 * database"). In the hash as sort=storedBytes&dir=desc; null = pending first, then newest.
 */
type Sort = { key: UserSortKey; dir: SortDir } | null;
const readSort = (h: URLSearchParams): Sort => {
  const key = h.get("sort");
  if (!isUserSortKey(key)) return null;
  const dir = h.get("dir");
  return { key, dir: dir === "asc" || dir === "desc" ? dir : userSortFirstDir(key) };
};
/** The sort as list input: spread into every admin.users.list / groups call, so sections page in the same order. */
type SortInput = { sort?: UserSortKey | undefined; dir?: SortDir | undefined };

const STATUS: Record<Status, { glyph: string; tone: string; word: MessageDescriptor }> = {
  pending: { glyph: "◷", tone: "text-warn", word: msg`Pending` },
  active: { glyph: "●", tone: "text-ok", word: msg`Active` },
  suspended: { glyph: "✕", tone: "text-err", word: msg`Suspended` },
};
const statusOptions = () => [
  { value: "", label: t`Any` },
  { value: "pending", label: t`Pending` },
  { value: "active", label: t`Active` },
  { value: "suspended", label: t`Suspended` },
];
const verifiedOptions = () => [
  { value: "", label: t`Any` },
  { value: "yes", label: t`Verified` },
  { value: "no", label: t`Unverified` },
];

type BulkAction = "approve" | "hold" | "suspend" | "reinstate" | "delete";
type BulkResult = { changed: number; unchanged: number; skipped: Array<{ id: string; email: string; reason: string }> };
/** The Sort menu: the same columns as the sortable headers, for widths where the headers fold away. */
const sortOptions = (): SortOption<UserSortKey>[] => [
  { value: "name", label: t`Name`, firstDir: "asc", asc: t`A to Z`, desc: t`Z to A` },
  { value: "status", label: t`Status`, firstDir: "asc", asc: t`Active, pending, suspended`, desc: t`Suspended, pending, active` },
  { value: "created", label: t`Signed up`, firstDir: "desc", asc: t`Oldest first`, desc: t`Newest first` },
  { value: "lastActive", label: t`Last active`, firstDir: "desc", asc: t`Longest ago first`, desc: t`Most recent first` },
  { value: "projects", label: t`Projects (all time)`, firstDir: "desc", asc: t`Fewest first`, desc: t`Most first` },
  { value: "sourceMinutes", label: t`Minutes (all time)`, firstDir: "desc", asc: t`Fewest first`, desc: t`Most first` },
  { value: "clipsRendered", label: t`Clips (all time)`, firstDir: "desc", asc: t`Fewest first`, desc: t`Most first` },
  { value: "storedBytes", label: t`Stored`, firstDir: "desc", asc: t`Smallest first`, desc: t`Largest first` },
];

/** Accounts per bulk call (BULK_USERS on the server): a longer selection goes in several calls. */
const BULK_CHUNK = 50;
/** "Approved 3 accounts": what a bulk run did, as one sentence per action. */
const bulkDone = (a: BulkAction, n: number): string => {
  switch (a) {
    case "approve":
      return plural(n, { one: "Approved # account", other: "Approved # accounts" });
    case "hold":
      return plural(n, { one: "Sent back to approval: # account", other: "Sent back to approval: # accounts" });
    case "suspend":
      return plural(n, { one: "Suspended # account", other: "Suspended # accounts" });
    case "reinstate":
      return plural(n, { one: "Reinstated # account", other: "Reinstated # accounts" });
    case "delete":
      return plural(n, { one: "Deleted # account", other: "Deleted # accounts" });
  }
};

const PAGE = 50;

const asStatus = (v: string | null): Status | "" => (v === "pending" || v === "active" || v === "suspended" ? v : "");
const asYesNo = (v: string | null): "yes" | "no" | "" => (v === "yes" || v === "no" ? v : "");

/**
 * Admin: who may use this instance. Pending accounts first; every action is one click, plus a confirm for the
 * risky ones (PRINCIPLES: "Confirm risky changes"). Search and filters run on the server and live in the hash
 * (#q=…&status=pending&verified=no&flag=shared_ip). Rows are selectable; the selection bar acts on the checked
 * rows, or on every account matching the filters ("Select all 1,204"), in pages of 50 on the server.
 */
export function AdminUsersPage() {
  const { t } = useLingui();
  useDocumentTitle(pageTitle(t`Users`));
  const trpc = useTRPC();
  const client = useTRPCClient();
  const qc = useQueryClient();
  const me = useMe();
  const [search, setSearch] = useState(() => readHash().get("q") ?? "");
  const [flag, setFlag] = useState<FlagFilter>(() => readFlag(readHash()));
  const [status, setStatus] = useState<Status | "">(() => asStatus(readHash().get("status")));
  const [verified, setVerified] = useState<"yes" | "no" | "">(() => asYesNo(readHash().get("verified")));
  /** only the accounts one sign-up rule held ("ip 203.0.113.0/24"), from the rule's link in Settings */
  const [heldBy, setHeldBy] = useState(() => readHash().get("held") ?? "");
  /** only the accounts from one sign-up address, from an address section's "Only this address" */
  const [signupIp, setSignupIp] = useState(() => readHash().get("ip") ?? "");
  const [ruleFor, setRuleFor] = useState<Row | null>(null);
  const [sort, setSort] = useState<Sort>(() => readSort(readHash()));
  const [confirm, setConfirm] = useState<{ kind: "ban" | "delete" | "role" | "hold"; row: Row } | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState<BulkAction | null>(null);
  const [limitsFor, setLimitsFor] = useState<Row | null>(null);
  const [banReason, setBanReason] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  /** the selection is every account matching the filters (or one section of them), not only the checked rows */
  const [allOf, setAllOf] = useState<AllOf | null>(null);
  const allMatching = allOf !== null;
  const [groupBy, setGroupBy] = useState<UserGroupBy | "">(() => asGroup(readHash().get("group")));
  /**
   * folded sections, by section id ("flag:none", "ip:rest", "flag:shared_ip/ip:203.0.113.7"); the unflagged and the
   * unshared start folded, since grouping is for looking at the flagged and the shared
   */
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set(["flag:none", "ip:rest"]));
  const toggleSection = useCallback(
    (id: string) =>
      setClosed((cur) => {
        const next = new Set(cur);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  /** how far a bulk run has got; local because one run is several calls */
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  // a pasted link, back/forward or a hash edit re-applies the filters (our own writes do not notify the router)
  const hash = useHashParams();
  const hashKey = hash.toString();
  useEffect(() => {
    const h = new URLSearchParams(hashKey);
    setSearch(h.get("q") ?? "");
    setFlag(readFlag(h));
    setStatus(asStatus(h.get("status")));
    setVerified(asYesNo(h.get("verified")));
    setHeldBy(h.get("held") ?? "");
    setSignupIp(h.get("ip") ?? "");
    setGroupBy(asGroup(h.get("group")));
    setSort(readSort(h));
  }, [hashKey]);
  const q = useDebounced(search.trim(), 200);
  const filter = useMemo(
    (): UserFilterInput => ({
      q: q || undefined,
      flagged: flag === "any" || undefined,
      flag: flag && flag !== "any" ? flag : undefined,
      status: status || undefined,
      verified: verified ? verified === "yes" : undefined,
      heldBy: heldBy || undefined,
      signupIp: signupIp || undefined,
    }),
    [q, flag, status, verified, heldBy, signupIp],
  );
  useEffect(() => {
    writeHash({
      q: q || null,
      flagged: flag === "any" ? 1 : null,
      flag: flag && flag !== "any" ? flag : null,
      status: status || null,
      verified: verified || null,
      held: heldBy || null,
      ip: signupIp || null,
      group: groupBy || null,
    });
    // a selection made under other filters is not what the new list shows
    setSel([]);
    setAllOf(null);
  }, [q, flag, status, verified, heldBy, signupIp, groupBy]);
  // a new order is the same accounts, so the selection stays
  useEffect(() => writeHash({ sort: sort?.key ?? null, dir: sort?.dir ?? null }), [sort]);
  const order = useMemo((): SortInput => (sort ? { sort: sort.key, dir: sort.dir } : {}), [sort]);
  // server-side paging and sorting; each account carries its all-time usage, so there is no separate usage query
  const list = useInfiniteQuery(
    trpc.admin.users.list.infiniteQueryOptions(
      { ...filter, ...order, limit: PAGE },
      { getNextPageParam: (last) => last.nextCursor ?? undefined, placeholderData: keepPreviousData, enabled: !groupBy },
    ),
  );
  // grouped: the sections and their counts over the whole filter; each open section pages its own rows
  const groups = useQuery(
    trpc.admin.users.groups.queryOptions({ ...filter, by: groupBy || "flag", limit: 0 }, { enabled: !!groupBy, placeholderData: keepPreviousData }),
  );
  const sections: SectionData[] = groupBy ? (groups.data?.groups ?? []) : [];
  /** the rows each mounted section has loaded (by section id), so selection and bulk targets see every one of them */
  const [groupRows, setGroupRows] = useState<Partial<Record<string, Row[]>>>({});
  const onGroupRows = useCallback((key: string, r: Row[] | null) => {
    setGroupRows((cur) => {
      if (cur[key] === r || (!r && !(key in cur))) return cur;
      const next = { ...cur };
      if (r) next[key] = r;
      else delete next[key];
      return next;
    });
  }, []);
  // counted over every account, not the loaded page
  const pendingCount = useQuery(trpc.admin.users.pendingCount.queryOptions());
  const flagCounts = useQuery(trpc.admin.users.flagCounts.queryOptions());
  const flagOptions = useMemo(() => {
    const c = flagCounts.data;
    const n = (k: "any" | AbuseFlag) => (c ? formatNumber(c[k]) : undefined);
    return [
      { value: "", label: t`Any` },
      { value: "any", label: t`Any flag`, hint: n("any") },
      ...ABUSE_FLAGS.map((f) => ({ value: f, label: sentence(flagName(f)), hint: n(f) })),
    ];
  }, [flagCounts.data, t]);
  const refresh = () => void qc.invalidateQueries({ queryKey: trpc.admin.users.pathKey() });
  const done = (text: () => string) => () => {
    toast(text());
    refresh();
  };
  const fail = (e: { message: string }) => toast.error(e.message);
  const approve = useMutation({ ...trpc.admin.users.approve.mutationOptions(), onSuccess: done(() => t`Approved`), onError: fail });
  const hold = useMutation({ ...trpc.admin.users.hold.mutationOptions(), onSuccess: done(() => t`Sent back to approval`), onError: fail });
  const setRole = useMutation({ ...trpc.admin.users.setRole.mutationOptions(), onSuccess: done(() => t`Role changed`), onError: fail });
  const ban = useMutation({ ...trpc.admin.users.ban.mutationOptions(), onSuccess: done(() => t`Suspended`), onError: fail });
  const unban = useMutation({ ...trpc.admin.users.unban.mutationOptions(), onSuccess: done(() => t`Reinstated`), onError: fail });
  const remove = useMutation({ ...trpc.admin.users.remove.mutationOptions(), onSuccess: done(() => t`Account deleted`), onError: fail });
  const loaded = useMemo(() => {
    if (!groupBy) return (list.data?.pages.flatMap((pg) => pg.items) ?? []) as Row[];
    // an account flagged for two reasons is in two sections: once here
    const byId = new Map<string, Row>();
    for (const rs of Object.values(groupRows)) for (const r of rs ?? []) byId.set(r.id, r);
    return [...byId.values()];
  }, [groupBy, list.data, groupRows]);
  const total = groupBy ? (groups.data?.total ?? 0) : (list.data?.pages[0]?.total ?? 0);
  /** the filter "every match" acts on: the whole list, or the one section picked */
  const allFilter = (a: AllOf): UserFilterInput => (a.id ? a.filter : filter);
  const allTotal = allOf?.id ? allOf.total : total;
  const allOfLabel = allOf?.label ?? "";
  const allLabel = allOf?.id ? t`every account in “${allOfLabel}”` : t`every matching account`;
  /** One action over the selection: chunks of checked ids, or every page of the filter until the server says it is done. */
  const bulk = useMutation({
    mutationFn: async ({
      action,
      ids,
      filter: every,
      reason,
    }: {
      action: BulkAction;
      ids: string[] | null;
      filter?: UserFilterInput | undefined;
      reason?: string | undefined;
    }) => {
      const sum: BulkResult = { changed: 0, unchanged: 0, skipped: [] };
      const add = (r: BulkResult) => {
        sum.changed += r.changed;
        sum.unchanged += r.unchanged;
        sum.skipped.push(...r.skipped);
        setProgress((p) => p && { ...p, done: Math.min(p.of, p.done + r.changed + r.unchanged + r.skipped.length) });
      };
      if (ids) {
        for (let i = 0; i < ids.length; i += BULK_CHUNK) add(await client.admin.users.bulk.mutate({ action, ids: ids.slice(i, i + BULK_CHUNK), reason }));
      } else {
        let cursor: string | undefined;
        do {
          const r = await client.admin.users.bulk.mutate({ action, filter: every ?? filter, cursor, reason });
          add(r);
          cursor = r.nextCursor ?? undefined;
        } while (cursor);
      }
      return { action, ...sum };
    },
    onMutate: ({ ids }) => setProgress({ done: 0, of: ids?.length ?? allTotal }),
    onSuccess: (r) => {
      const parts = [bulkDone(r.action, r.changed)];
      const unchanged = formatNumber(r.unchanged);
      const skipped = formatNumber(r.skipped.length);
      const why = r.skipped[0]?.reason ?? "";
      if (r.unchanged) parts.push(t`${unchanged} left as they were`);
      if (r.skipped.length) parts.push(t`${skipped} skipped: ${why}`);
      toast(parts.join(" · "));
      setSel([]);
      setAllOf(null);
    },
    onError: fail,
    onSettled: () => {
      setProgress(null);
      refresh();
    },
  });
  const busy = approve.isPending || hold.isPending || setRole.isPending || ban.isPending || unban.isPending || remove.isPending || bulk.isPending;
  // a refetch drops rows that left the list (deleted, or no longer matching): so does the selection
  useEffect(() => {
    const live = new Set(loaded.map((r) => r.id));
    setSel((cur) => (cur.every((x) => live.has(x)) ? cur : cur.filter((x) => live.has(x))));
  }, [loaded]);
  // already in the server's order (the sort is part of the query)
  const rows = loaded;
  const pending = pendingCount.data ?? 0;

  const selfId = me.data?.id;
  const selected = useMemo(() => loaded.filter((r) => sel.includes(r.id)), [loaded, sel]);
  const allIds = rows.map((r) => r.id);
  const allOn = allIds.length > 0 && allIds.every((id) => sel.includes(id));
  const someOn = !allOn && sel.length > 0;
  const toggle = (id: string) => {
    setAllOf(null);
    setSel((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };
  /** checked: picked by hand, or inside what "every match" covers (the whole list, or that section) */
  const isChecked = (r: Row) => (allOf ? allOf.covers(r) : sel.includes(r.id));
  /** a section header's checkbox: its loaded rows on or off together */
  const setMany = (ids: string[], on: boolean) => {
    setAllOf(null);
    setSel((cur) => (on ? [...new Set([...cur, ...ids])] : cur.filter((x) => !ids.includes(x))));
  };
  /** The checked rows each action can change (an approved account needs no approval, nobody suspends or deletes themself). */
  const applies: Record<BulkAction, (r: Row) => boolean> = {
    approve: (r) => r.status === "pending",
    hold: (r) => r.status === "active" && r.role !== "admin" && r.id !== selfId,
    suspend: (r) => r.status !== "suspended" && r.id !== selfId,
    reinstate: (r) => r.status === "suspended",
    delete: (r) => r.id !== selfId,
  };
  const targets = (a: BulkAction) => selected.filter(applies[a]);
  const selCount = allOf ? allTotal : selected.length;
  const runBulk = (action: BulkAction, reason?: string) =>
    bulk.mutateAsync({
      action,
      ids: allOf ? null : targets(action).map((r) => r.id),
      filter: allOf ? allFilter(allOf) : undefined,
      reason: reason || undefined,
    });
  /** What a bulk action acts on, for its title and its confirm: "every matching account (1,204)" or "3 accounts". */
  const scope = (a: BulkAction) => (allOf ? `${allLabel} (${formatNumber(allTotal)})` : accountsCount(targets(a).length));
  const bulkOff = (a: BulkAction) => busy || (!allMatching && targets(a).length === 0);
  const bulkTitle = (a: BulkAction, verb: (what: string) => string, none: string) => (bulkOff(a) && !busy ? none : verb(scope(a)));

  const skeletonRow = (i: number, key: string | number = i) => (
    <ListRow key={key} tall skeleton>
      <ListCell />
      <ListCell>
        <Skeleton className={`h-4 ${["w-2/5", "w-1/2", "w-1/3", "w-3/5", "w-2/5"][i % 5]}`} />
        <Skeleton className="mt-1.5 h-3 w-3/5" />
        <Skeleton className="mt-1.5 h-3 w-4/5 min-[1040px]:hidden" />
      </ListCell>
      <ListCell full>
        <Skeleton className="h-3.5 w-16" />
      </ListCell>
      {[0, 1, 2].map((j) => (
        <ListCell key={j} full>
          <Skeleton className="ms-auto h-3.5 w-8" />
        </ListCell>
      ))}
      <ListCell full>
        <Skeleton className="ms-auto h-3.5 w-12" />
      </ListCell>
      <ListCell full>
        <Skeleton className="h-3.5 w-14" />
      </ListCell>
      <ListCell>
        <Skeleton className="ms-auto h-8 w-8 rounded-[8px] min-[1040px]:w-full" />
      </ListCell>
    </ListRow>
  );
  const renderRow = (r: Row, key: string): ReactNode => {
    const st = STATUS[r.status];
    const self = r.id === selfId;
    const checked = isChecked(r);
    const u = r.usage;
    const projects = formatNumber(u.projects);
    const minutes = formatNumber(u.sourceMinutes);
    const clips = formatNumber(u.clipsRendered);
    const stored = formatBytes(u.storedBytes);
    const line = t`${projects} projects · ${minutes} min · ${clips} clips · ${stored}`;
    const calls = formatNumber(u.llmCalls);
    const tokensIn = formatNumber(Math.round(u.llmInputTokens / 1000));
    const tokensOut = formatNumber(Math.round(u.llmOutputTokens / 1000));
    const model = t`All time: ${calls} model calls, ${tokensIn}k tokens in, ${tokensOut}k out`;
    const active = r.lastActive ? ago(r.lastActive) : t`never`;
    const stateLabel = r.status === "pending" ? t`Approve` : r.status === "suspended" ? t`Reinstate` : t`Suspend`;
    const stateOff = busy || (self && r.status === "active");
    const stateWhy = self && r.status === "active" ? t`You cannot suspend your own account` : undefined;
    const email = r.email;
    const heldRule = r.heldBy ?? "";
    const heldKind = heldRule.split(" ")[0] ?? "";
    const ip = r.signupIp;
    const statusWord = i18n._(st.word);
    const stateRun = () => {
      if (r.status === "pending") approve.mutate({ id: r.id });
      else if (r.status === "suspended") unban.mutate({ id: r.id });
      else {
        setBanReason("");
        setConfirm({ kind: "ban", row: r });
      }
    };
    return (
      <ListRow key={key} tall active={checked}>
        <ListCell className="relative !p-0">
          <label className={`absolute inset-0 flex cursor-pointer items-center justify-center ${checked ? "opacity-100" : "opacity-0"} ${LIST_REVEAL_ROW}`}>
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--acc)]"
              checked={checked}
              disabled={allMatching || bulk.isPending}
              onChange={() => toggle(r.id)}
              aria-label={t`Select ${email}`}
            />
          </label>
        </ListCell>
        <ListCell title={model}>
          <div className="flex items-center gap-2">
            <span className={`min-w-0 ${LIST_TITLE}`}>{r.name || r.email}</span>
            {r.role === "admin" && (
              <span className="chip shrink-0 bg-acc-soft text-acc-text">
                <Trans>admin</Trans>
              </span>
            )}
            {r.mustChangePassword && (
              <span className="chip shrink-0 bg-warn-soft text-warn" title={t`reelsaw set-password --must-change: they pick a new password at next sign-in`}>
                <Trans>must change password</Trans>
              </span>
            )}
            {r.plan && r.plan !== "free" && <span className="chip shrink-0 bg-sunk text-ink2">{r.plan}</span>}
            {r.status === "pending" && r.heldBy && (
              // the kind only ("held · email"), so the name keeps its room; the whole rule is in the title.
              // A click lists everyone that rule held.
              <button
                type="button"
                className="chip shrink-0 bg-sunk text-ink2 hover:text-ink"
                onClick={() => setHeldBy(r.heldBy ?? "")}
                title={t`Held for approval by the sign-up rule ${heldRule}. They only see “waiting for approval”. Click to list everyone it held.`}
              >
                <Trans>held · {heldKind}</Trans>
              </button>
            )}
            {/* a click lists everyone flagged for the same reason */}
            {r.flags.filter(isAbuseFlag).map((f) => {
              const help = i18n._(FLAG_SENTENCE[f]);
              return (
                <button
                  type="button"
                  key={f}
                  className="chip shrink-0 bg-warn-soft text-warn hover:brightness-110"
                  onClick={() => setFlag(f)}
                  title={
                    ip ? t`${help} · signed up from ${ip}. Click to list everyone flagged for this.` : t`${help}. Click to list everyone flagged for this.`
                  }
                >
                  ⚑ {flagName(f)}
                </button>
              );
            })}
            {self && (
              <span className="shrink-0 text-xs text-ink3">
                <Trans>(you)</Trans>
              </span>
            )}
          </div>
          {/* the address truncates; whether it is verified always shows */}
          <div className="flex min-w-0 items-baseline gap-1.5 text-xs text-ink3">
            <span className="min-w-0 truncate">{r.email}</span>
            <span
              className={`shrink-0 ${r.emailVerified ? "text-ok" : "text-warn"}`}
              title={r.emailVerified ? t`They confirmed this address` : t`They have not confirmed this address yet`}
            >
              {r.emailVerified ? `✓ ${t`verified`}` : `◇ ${t`unverified`}`}
            </span>
          </div>
          <div className={`${LIST_SUB} min-[1040px]:hidden`}>
            <span className={st.tone}>
              {st.glyph} {statusWord}
            </span>{" "}
            · {line} · <Trans>active {active}</Trans>
          </div>
        </ListCell>
        <ListCell full className={`text-xs ${st.tone}`} title={r.banReason ?? undefined}>
          {st.glyph} {statusWord}
        </ListCell>
        <ListCell full variant="num">
          {formatNumber(u.projects)}
        </ListCell>
        <ListCell full variant="num">
          {formatNumber(u.sourceMinutes)}
        </ListCell>
        <ListCell full variant="num">
          {formatNumber(u.clipsRendered)}
        </ListCell>
        <ListCell full variant="num">
          {formatBytes(u.storedBytes)}
        </ListCell>
        <ListCell full variant="muted">
          {active}
        </ListCell>
        <ListCell variant="actions">
          <div className="flex items-center justify-end gap-1.5">
            <button
              className={`${r.status === "pending" ? "btn-primary" : "btn-ghost"} w-[5.5rem] ${LIST_ACTION}`}
              disabled={stateOff}
              title={stateWhy}
              onClick={stateRun}
            >
              {stateLabel}
            </button>
            <button className={`btn-ghost w-[4.25rem] ${LIST_ACTION}`} onClick={() => setLimitsFor(r)}>
              <Trans>Limits</Trans>
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <MoreButton aria-label={t`More actions for ${email}`} />
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className={LIST_MENU}>
                  <DropdownMenu.Item className={LIST_MENU_ITEM_FOLDED} disabled={stateOff} onSelect={stateRun}>
                    {stateLabel}
                    {stateWhy && (
                      <span className="menu-hint">
                        <Trans>not your own</Trans>
                      </span>
                    )}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className={LIST_MENU_ITEM_FOLDED} onSelect={() => setLimitsFor(r)}>
                    <Trans>Limits…</Trans>
                  </DropdownMenu.Item>
                  {r.status === "active" && (
                    <DropdownMenu.Item
                      className="menu-item"
                      disabled={busy || self || r.role === "admin"}
                      onSelect={() => setConfirm({ kind: "hold", row: r })}
                    >
                      <Trans>Require approval…</Trans>
                      {(self || r.role === "admin") && <span className="menu-hint">{self ? t`not your own` : t`not an admin`}</span>}
                    </DropdownMenu.Item>
                  )}
                  {r.status === "pending" && (
                    <DropdownMenu.Item
                      className="menu-item"
                      disabled={busy}
                      onSelect={() => {
                        setBanReason("");
                        setConfirm({ kind: "ban", row: r });
                      }}
                    >
                      <Trans>Suspend</Trans>
                    </DropdownMenu.Item>
                  )}
                  <DropdownMenu.Item className="menu-item" disabled={busy} onSelect={() => window.setTimeout(() => setRuleFor(r), 0)}>
                    <Trans>Add sign-up rule…</Trans>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item" disabled={busy || self} onSelect={() => setConfirm({ kind: "role", row: r })}>
                    {r.role === "admin" ? t`Remove admin…` : t`Make admin…`}
                    {self && (
                      <span className="menu-hint">
                        <Trans>not your own</Trans>
                      </span>
                    )}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item className="menu-item-danger" disabled={busy || self} onSelect={() => setConfirm({ kind: "delete", row: r })}>
                    <Trans>Delete account…</Trans>
                    {self && (
                      <span className="menu-hint">
                        <Trans>not your own</Trans>
                      </span>
                    )}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </ListCell>
      </ListRow>
    );
  };
  // the same state as the Sort menu: natural direction, the other one, then the default order
  const sortable = (k: UserSortKey, usage?: boolean): NonNullable<ListColumn["sort"]> => ({
    dir: sort?.key === k ? (sort.dir === "asc" ? 1 : -1) : null,
    title: usage ? t`All time. Sorts every matching account` : t`Sorts every matching account`,
    onToggle: () => setSort(listSortToggle(sort, k, userSortFirstDir(k))),
  });
  // the actions column fits the state button, Limits and the menu; below the fold width only the menu
  const columns: ListColumn[] = [
    {
      label: (
        <label className="absolute inset-0 flex cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--acc)]"
            checked={allOn || (allOf !== null && !allOf.id)}
            ref={(el) => {
              if (el) el.indeterminate = (someOn && !allMatching) || !!allOf?.id;
            }}
            disabled={!allIds.length || bulk.isPending}
            onChange={() => {
              setAllOf(null);
              setSel(allOn ? [] : allIds);
            }}
            aria-label={allOn ? t`Clear selection` : t`Select all loaded accounts`}
          />
        </label>
      ),
      width: "w-11",
    },
    { label: t`Account`, sort: sortable("name") },
    { label: t`Status`, width: "min-[1040px]:w-28", full: true, sort: sortable("status") },
    { label: t`Projects`, width: "min-[1040px]:w-[4.5rem]", full: true, right: true, sort: sortable("projects", true) },
    { label: t`Minutes`, width: "min-[1040px]:w-[4.5rem]", full: true, right: true, sort: sortable("sourceMinutes", true) },
    { label: t`Clips`, width: "min-[1040px]:w-[4.5rem]", full: true, right: true, sort: sortable("clipsRendered", true) },
    { label: t`Stored`, width: "min-[1040px]:w-[5.5rem]", full: true, right: true, sort: sortable("storedBytes", true) },
    { label: t`Active`, width: "min-[1040px]:w-[6.5rem]", full: true, sort: sortable("lastActive") },
    { label: null, srLabel: t`Actions`, width: "w-14 min-[1040px]:w-[14rem]" },
  ];
  const filtered = !!(flag || status || verified || heldBy || signupIp);
  const facets: ListFacet[] = [
    { id: "status", label: t`Status`, value: status, options: statusOptions(), onChange: (v) => setStatus(asStatus(v)) },
    { id: "verified", label: t`Email`, value: verified, options: verifiedOptions(), onChange: (v) => setVerified(asYesNo(v)) },
    { id: "flag", label: t`Flag`, value: flag, options: flagOptions, onChange: (v) => setFlag(v === "any" || isAbuseFlag(v) ? v : "") },
  ];
  /** what narrows the list, as chips: the facets, and the two filters that only arrive by link (a sign-up rule, one address) */
  const activeFilters: ActiveFilter[] = [
    ...facetChips(facets),
    ...(heldBy
      ? [
          {
            id: "held",
            label: t`Held by ${heldBy}`,
            title: t`Only accounts the sign-up rule ${heldBy} held. Click to show everyone.`,
            onClear: () => setHeldBy(""),
          },
        ]
      : []),
    ...(signupIp
      ? [
          {
            id: "ip",
            label: t`From ${signupIp}`,
            title: t`Only accounts that signed up from ${signupIp}. Click to show everyone.`,
            onClear: () => setSignupIp(""),
          },
        ]
      : []),
  ];
  const noun = (n: number) => (q ? plural(n, { one: "# match", other: "# matches" }) : accountsCount(n));
  const pendingText = formatNumber(pending);
  const totalText = formatNumber(total);
  const shownRows = formatNumber(rows.length);
  const totalNoun = noun(total);
  const sectionCount = sectionsCount(sections.length);
  const totalAccounts = accountsCount(total);
  const approveScope = scope("approve");
  const holdScope = scope("hold");
  const suspendScope = scope("suspend");
  const deleteScope = scope("delete");
  const allLabelSentence = sentence(allLabel);
  const allTotalText = formatNumber(allTotal);
  const deleteAccounts = accountsCount(targets("delete").length);
  const deleteProjects = formatNumber(targets("delete").reduce((n, r) => n + r.projects, 0));
  const confirmEmail = confirm?.row.email;
  const progressDone = formatNumber(progress?.done ?? 0);
  const progressOf = formatNumber(progress?.of ?? 0);
  const colCount = { folded: columns.filter((c) => !c.full).length, full: columns.length };
  /** what every section, at any depth, takes from the page */
  const sectionProps: SectionShared = {
    closed,
    onToggle: toggleSection,
    onRows: onGroupRows,
    order,
    renderRow,
    skeletonRow,
    colCount,
    pageSize: q && !sort ? 100 : PAGE,
    isChecked,
    allOfId: allOf ? allOf.id : undefined,
    onSetMany: setMany,
    onSelectAll: setAllOf,
    onlyAddress: setSignupIp,
    disabled: bulk.isPending,
  };
  const listError = groupBy ? groups.error : list.error;
  const pendingList = groupBy ? groups.isPending : list.isPending;
  const empty = groupBy ? !!groups.data && !groups.isPlaceholderData && sections.length === 0 : !!list.data && !list.isPlaceholderData && rows.length === 0;

  return (
    <ListPage
      title={t`Users`}
      subtitle={
        <>
          <Trans>Who can use this instance</Trans>
          {pending > 0 && (
            <>
              {" · "}
              <button
                type="button"
                className="text-acc-text hover:underline"
                onClick={() => setStatus("pending")}
                title={t`List the accounts waiting for approval`}
              >
                <Trans>{pendingText} waiting for approval</Trans>
              </button>
            </>
          )}
        </>
      }
    >
      <ListToolbar
        label={t`Search and filter accounts`}
        search={<ListSearch value={search} onChange={setSearch} placeholder={t`Search name or email`} label={t`Search users`} />}
        controls={
          <>
            <FilterMenu facets={facets} />
            <ChoiceMenu label={t`Group`} value={groupBy} options={groupOptions()} onChange={(v) => setGroupBy(asGroup(v))} />
            <SortMenu options={sortOptions()} value={sort} onChange={setSort} defaultLabel={t`Pending, then newest`} />
          </>
        }
        count={pendingList ? <Skeleton className="h-3 w-24" /> : groupBy ? t`${totalNoun} in ${sectionCount}` : totalNoun}
        filters={activeFilters}
      />
      {listError && <ListError message={listError.message} />}
      {empty && (
        <ListEmpty icon={Users} title={q ? t`No accounts match “${q}”` : t`No accounts match`}>
          {filtered ? t`Try another status, email or flag filter.` : undefined}
        </ListEmpty>
      )}
      {((groupBy ? sections.length > 0 : rows.length > 0) || (pendingList && !listError)) && (
        <section className="flex flex-col gap-2">
          <ListTable
            caption={
              groupBy === "ip"
                ? t`Accounts grouped by sign-up address, with all-time usage`
                : groupBy
                  ? t`Accounts grouped by abuse flag, shared addresses split by address, with all-time usage`
                  : t`Accounts, with all-time usage`
            }
            columns={columns}
            loading={pendingList}
            loadingLabel={t`Loading accounts…`}
          >
            {groupBy ? (
              groups.isPending ? (
                Array.from({ length: LIST_SKELETON_ROWS }, (_, i) => skeletonRow(i))
              ) : (
                <>
                  {sections.map((g) => (
                    <UserGroupSection
                      key={g.key}
                      id={`${groupBy}:${g.key}`}
                      section={g}
                      address={groupBy === "ip" && g.key !== IP_GROUP_REST}
                      covers={sectionCovers(groupBy, g.key, sections)}
                      split={groupBy === "flag" && byAddress(g.key)}
                      shared={sectionProps}
                    />
                  ))}
                  {!!groups.data?.moreSections && <MoreAddresses n={groups.data.moreSections} cols={colCount} />}
                </>
              )
            ) : (
              <>
                {list.isPending && Array.from({ length: LIST_SKELETON_ROWS }, (_, i) => skeletonRow(i))}
                {rows.map((r) => renderRow(r, r.id))}
              </>
            )}
          </ListTable>
          <ListFooter
            action={
              !groupBy && (
                <ListLoadMore
                  hasMore={!!list.hasNextPage}
                  loading={list.isFetchingNextPage}
                  busy={(list.isFetching && !list.isFetchingNextPage) || list.isPlaceholderData}
                  onMore={() => void list.fetchNextPage()}
                  left={Math.min(PAGE, total - rows.length)}
                />
              )
            }
          >
            {pendingList ? (
              <Skeleton className="h-3 w-40" />
            ) : groupBy ? (
              groupBy === "flag" && sections.length > 1 ? (
                t`${totalAccounts} in ${sectionCount} · an account with two flags is in both`
              ) : (
                t`${totalAccounts} in ${sectionCount}`
              )
            ) : q && !sort && total > rows.length ? (
              t`Showing the best ${shownRows} of ${totalNoun}`
            ) : (
              t`Showing ${shownRows} of ${totalNoun}`
            )}
          </ListFooter>
          {(selected.length > 0 || allMatching) && (
            <SelectionBar
              label={t`Selected accounts`}
              count={selCount}
              busy={busy}
              onClear={() => {
                setSel([]);
                setAllOf(null);
              }}
            >
              {progress ? (
                <span className="min-w-[6rem] px-1.5 text-xs tabular-nums text-ink3" aria-live="polite">
                  <Trans>
                    {progressDone} of {progressOf}…
                  </Trans>
                </span>
              ) : (
                allOn &&
                !allMatching &&
                total > rows.length && (
                  <button
                    type="button"
                    className="btn-ghost h-8 px-2 text-xs"
                    onClick={() => setAllOf({ id: null, filter, label: t`every matching account`, total, covers: () => true })}
                  >
                    <Trans>Select all {totalText}</Trans>
                  </button>
                )
              )}
              <button
                type="button"
                className="btn-ghost h-8"
                disabled={bulkOff("approve")}
                title={bulkTitle("approve", (what) => t`Approve ${what}`, t`None of the selected accounts is waiting for approval`)}
                onClick={() => (allMatching ? setBulkConfirm("approve") : void runBulk("approve").catch(() => {}))}
              >
                <Trans>Approve</Trans>
              </button>
              <button
                type="button"
                className="btn-ghost h-8"
                disabled={bulkOff("suspend")}
                title={bulkTitle("suspend", (what) => t`Suspend ${what}`, t`The selected accounts are already suspended`)}
                onClick={() => {
                  setBanReason("");
                  setBulkConfirm("suspend");
                }}
              >
                <Trans>Suspend…</Trans>
              </button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <MoreButton aria-label={t`More actions for the selection`} />
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content side="top" align="end" sideOffset={8} className="menu w-[220px]">
                    <DropdownMenu.Item className="menu-item" disabled={bulkOff("reinstate")} onSelect={() => void runBulk("reinstate").catch(() => {})}>
                      <Trans>Reinstate</Trans>
                      {bulkOff("reinstate") && !busy && (
                        <span className="menu-hint">
                          <Trans>none suspended</Trans>
                        </span>
                      )}
                    </DropdownMenu.Item>
                    <DropdownMenu.Item className="menu-item" disabled={bulkOff("hold")} onSelect={() => window.setTimeout(() => setBulkConfirm("hold"), 0)}>
                      <Trans>Require approval…</Trans>
                      {bulkOff("hold") && !busy && (
                        <span className="menu-hint">
                          <Trans>none active</Trans>
                        </span>
                      )}
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator className="mx-1.5 my-1 h-px bg-line" />
                    <DropdownMenu.Item
                      className="menu-item-danger"
                      disabled={bulkOff("delete")}
                      onSelect={() => window.setTimeout(() => setBulkConfirm("delete"), 0)}
                    >
                      <Trans>Delete accounts…</Trans>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </SelectionBar>
          )}
        </section>
      )}

      {limitsFor && <LimitsDialog row={limitsFor} onClose={() => setLimitsFor(null)} />}
      {ruleFor && <RuleFromUserDialog user={ruleFor} onClose={() => setRuleFor(null)} />}
      <ConfirmDialog
        open={bulkConfirm === "approve"}
        onOpenChange={(o) => !o && setBulkConfirm(null)}
        title={t`Approve ${approveScope}?`}
        body={t`Every one of them that is waiting can use the app right away and is told by email. Accounts already approved stay as they are.`}
        confirm={t`Approve`}
        onConfirm={() => runBulk("approve")}
      />
      <ConfirmDialog
        open={bulkConfirm === "hold"}
        onOpenChange={(o) => !o && setBulkConfirm(null)}
        title={t`Require approval for ${holdScope}?`}
        body={t`From their next request they see “waiting for approval” and cannot use the app, their API keys or MCP until approved again. They are not told why, and their projects stay. Admins and your own account are left out.`}
        confirm={t`Require approval`}
        onConfirm={() => runBulk("hold")}
      />
      <ConfirmDialog
        open={bulkConfirm === "suspend"}
        onOpenChange={(o) => !o && setBulkConfirm(null)}
        title={t`Suspend ${suspendScope}?`}
        body={
          <>
            <Trans>
              They are signed out now and cannot use the app, their API keys or MCP until reinstated. Their projects stay. Your own account and the last admin
              are left out.
            </Trans>
            <input
              className="input mt-3"
              placeholder={t`Reason (shown to them, optional)`}
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
              maxLength={300}
              aria-label={t`Reason`}
            />
          </>
        }
        confirm={t`Suspend`}
        danger
        onConfirm={() => runBulk("suspend", banReason)}
      />
      <ConfirmDialog
        open={bulkConfirm === "delete"}
        onOpenChange={(o) => !o && setBulkConfirm(null)}
        title={t`Delete ${deleteScope} forever?`}
        body={
          allMatching
            ? t`${allLabelSentence} (${allTotalText}), with all their projects, clips and files, is deleted permanently. Your own account and the last admin are left out. This cannot be undone.`
            : t`${deleteAccounts}, with ${deleteProjects} projects and all their clips and files, are deleted permanently. This cannot be undone.`
        }
        confirm={t`Delete accounts forever`}
        danger
        onConfirm={() => runBulk("delete")}
      />
      <ConfirmDialog
        open={confirm?.kind === "delete"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirmEmail ? t`Delete ${confirmEmail} forever?` : t`Delete this account forever?`}
        body={plural(confirm?.row.projects ?? 0, {
          one: "Their # project, clips and files are deleted permanently. This cannot be undone.",
          other: "Their # projects, clips and files are deleted permanently. This cannot be undone.",
        })}
        confirm={t`Delete account forever`}
        danger
        onConfirm={() => (confirm ? remove.mutateAsync({ id: confirm.row.id }) : Promise.resolve())}
      />
      <ConfirmDialog
        open={confirm?.kind === "role"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={
          confirm?.row.role === "admin"
            ? t`Remove admin from ${confirmEmail}?`
            : confirmEmail
              ? t`Make ${confirmEmail} an admin?`
              : t`Make this account an admin?`
        }
        body={
          confirm?.row.role === "admin"
            ? t`They lose user management and instance settings right away. Their account and projects stay.`
            : t`Right away, they can manage every account and change instance settings, models and provider keys.`
        }
        confirm={confirm?.row.role === "admin" ? t`Remove admin` : t`Make admin`}
        danger={confirm?.row.role !== "admin"}
        onConfirm={() => (confirm ? setRole.mutateAsync({ id: confirm.row.id, role: confirm.row.role === "admin" ? "user" : "admin" }) : Promise.resolve())}
      />
      <ConfirmDialog
        open={confirm?.kind === "hold"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirmEmail ? t`Require approval for ${confirmEmail}?` : t`Require approval for this account?`}
        body={t`From their next request they see “waiting for approval” and cannot use the app, their API keys or MCP until you approve them again. They are not told why, and their projects stay.`}
        confirm={t`Require approval`}
        onConfirm={() => (confirm ? hold.mutateAsync({ id: confirm.row.id }) : Promise.resolve())}
      />
      <ConfirmDialog
        open={confirm?.kind === "ban"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirmEmail ? t`Suspend ${confirmEmail}?` : t`Suspend this account?`}
        body={
          <>
            <Trans>They are signed out now and cannot use the app, their API keys or MCP until reinstated. Their projects stay.</Trans>
            <input
              className="input mt-3"
              placeholder={t`Reason (shown to them, optional)`}
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
              maxLength={300}
              aria-label={t`Reason`}
            />
          </>
        }
        confirm={t`Suspend`}
        danger
        onConfirm={() => (confirm ? ban.mutateAsync({ id: confirm.row.id, reason: banReason || undefined }) : Promise.resolve())}
      />
    </ListPage>
  );
}

/** What every section of the grouped list takes from the page, at any depth. */
type SectionShared = {
  /** folded section ids */
  closed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onRows: (id: string, rows: Row[] | null) => void;
  /** the page's sort, sent with the section's own list query so every section pages in that order */
  order: SortInput;
  renderRow: (r: Row, key: string) => ReactNode;
  skeletonRow: (i: number, key?: string | number) => ReactNode;
  /** visible columns below and above the fold width: a spanning cell must not span hidden ones */
  colCount: { folded: number; full: number };
  pageSize: number;
  isChecked: (r: Row) => boolean;
  /** what "every match" is: undefined = nothing picked that way, null = the whole list, else a section id */
  allOfId: string | null | undefined;
  onSetMany: (ids: string[], on: boolean) => void;
  onSelectAll: (a: AllOf) => void;
  /** narrow the page to one sign-up address (the "ip" filter) */
  onlyAddress: (ip: string) => void;
  disabled: boolean;
};

/**
 * One section of the grouped list: a header row with what it is (a flag, or a sign-up address), how many accounts
 * it holds over the whole filter, a fold toggle and a checkbox, then its rows, paged on their own with the
 * section's filter from the server, so "Load more" and "Select all 120" mean this section only. A folded section
 * loads nothing until opened. Rows render through the page's `renderRow`, so a grouped row is the flat row.
 *
 * `split` (group by flag, shared ip and signup burst): instead of one list, the section holds one sub-section per
 * sign-up address, so the accounts behind each address read together. Its checkbox then selects the whole section.
 */
function UserGroupSection({
  id,
  section,
  covers,
  split = false,
  address = false,
  depth = 0,
  selectLabel,
  shared,
}: {
  /** unique among every section on the page, at any depth ("flag:shared_ip", "flag:shared_ip/ip:203.0.113.7") */
  id: string;
  section: SectionData;
  /** which loaded rows this section holds, for "Select all" */
  covers: (r: Row) => boolean;
  split?: boolean;
  /** the key is a sign-up address: shown as one, with "Only this address" */
  address?: boolean;
  depth?: 0 | 1;
  /** what the selection bar calls this section when it is all selected (default: its label) */
  selectLabel?: string;
  shared: SectionShared;
}) {
  const { closed, onToggle, onRows, order, renderRow, skeletonRow, colCount, pageSize, isChecked, allOfId, onSetMany, onSelectAll, onlyAddress, disabled } =
    shared;
  const { t } = useLingui();
  const trpc = useTRPC();
  const open = !closed.has(id);
  const list = useInfiniteQuery(
    trpc.admin.users.list.infiniteQueryOptions(
      { ...section.filter, ...order, limit: PAGE },
      { getNextPageParam: (last) => last.nextCursor ?? undefined, placeholderData: keepPreviousData, enabled: open && !split },
    ),
  );
  const loaded = useMemo(() => (list.data?.pages.flatMap((pg) => pg.items) ?? []) as Row[], [list.data]);
  const { key, label, help, total } = section;
  // a split section's rows are its address sections' rows, reported by them
  useEffect(() => {
    if (!split) onRows(id, loaded);
  }, [id, split, loaded, onRows]);
  useEffect(() => () => onRows(id, null), [id, onRows]);
  const rows = loaded;
  const ids = rows.map((r) => r.id);
  const allOfHere = allOfId === id;
  /** "every match" is the whole list or another section: the header box reads its rows, a click starts over */
  const allOfOther = allOfId !== undefined && allOfId !== id;
  const on = allOfHere || (!split && ids.length > 0 && rows.every(isChecked));
  const some = !on && !split && rows.some(isChecked);
  const selectAll = () => onSelectAll({ id, filter: section.filter, label: selectLabel ?? label, total, covers });
  const flagged = !address && key !== "none" && key !== IP_GROUP_REST;
  const nested = depth > 0;
  // top-level headers stick under the column header; an address header inside a flag scrolls with its rows
  const headCell = nested ? "h-9 border-t border-line bg-panel align-middle" : "sticky top-9 z-[5] h-10 border-t border-line bg-sunk align-middle";
  // as many placeholders as the section will show, so the rows land where the skeleton was
  const expected = Math.min(total, pageSize);
  const totalText = formatNumber(total);
  const shownText = formatNumber(rows.length);
  const nextText = formatNumber(Math.min(PAGE, total - rows.length));
  return (
    <>
      <tr>
        <td className={`${headCell} relative !p-0`}>
          <label className="absolute inset-0 flex cursor-pointer items-center justify-center">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--acc)]"
              checked={on}
              ref={(el) => {
                if (el) el.indeterminate = some;
              }}
              disabled={disabled || (split ? total === 0 : !open || !ids.length)}
              onChange={() => {
                if (split) return allOfHere ? onSetMany([], false) : selectAll();
                onSetMany(ids, allOfOther ? true : !on);
              }}
              aria-label={
                split
                  ? on
                    ? t`Clear the accounts in ${label}`
                    : t`Select all ${totalText} in ${label}`
                  : on
                    ? t`Clear the accounts in ${label}`
                    : t`Select the loaded accounts in ${label}`
              }
            />
          </label>
        </td>
        <SpanCells cols={colCount} minus={1} className={`${headCell} ${nested ? "ps-8 pe-3" : "px-3"}`}>
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className="flex min-w-0 items-center gap-2 text-start"
              aria-expanded={open}
              onClick={() => onToggle(id)}
              title={sentence(help)}
            >
              <ChevronRight aria-hidden className={`h-3.5 w-3.5 shrink-0 text-ink3 transition-transform ${open ? "rotate-90" : ""}`} />
              {address ? (
                <span className="min-w-0 truncate font-mono text-xs font-semibold text-ink">{label}</span>
              ) : (
                <span className={`chip shrink-0 ${flagged ? "bg-warn-soft text-warn" : "bg-panel text-ink2"}`}>
                  {flagged ? "⚑ " : ""}
                  {label}
                </span>
              )}
              <span className="shrink-0 text-xs tabular-nums text-ink2">{accountsCount(total)}</span>
              <span className="hidden min-w-0 truncate text-xs text-ink3 sm:inline">{split ? t`${help}, by address` : help}</span>
            </button>
            <span className="ms-auto flex shrink-0 items-center gap-1 text-xs">
              {allOfHere ? (
                <span className="text-ink2">
                  <Trans>All {totalText} selected</Trans>
                </span>
              ) : (
                !split &&
                on &&
                total > rows.length && (
                  <button type="button" className="btn-ghost h-7 px-2 text-xs" disabled={disabled} onClick={selectAll}>
                    <Trans>Select all {totalText}</Trans>
                  </button>
                )
              )}
              {address && (
                <button
                  type="button"
                  className="btn-ghost h-7 px-2 text-xs"
                  onClick={() => onlyAddress(key)}
                  title={t`List only the accounts that signed up from ${key}, whatever their flags`}
                >
                  <Trans>Only this address</Trans>
                </button>
              )}
            </span>
          </div>
        </SpanCells>
      </tr>
      {open && split && <AddressSections parentId={id} parent={section} parentCovers={covers} shared={shared} />}
      {open && !split && list.isPending && Array.from({ length: expected }, (_, i) => skeletonRow(i, `${id}-sk-${i}`))}
      {open && !split && rows.map((r) => renderRow(r, `${id}-${r.id}`))}
      {open && !split && list.hasNextPage && (
        <tr>
          <SpanCells cols={colCount} className={`h-11 border-t border-line text-xs text-ink3 ${nested ? "ps-8 pe-3" : "px-3"}`}>
            <div className="flex items-center justify-between gap-3">
              <span className="tabular-nums">
                <Trans>
                  {shownText} of {totalText} in {label}
                </Trans>
              </span>
              <button type="button" className="btn-ghost h-8 min-w-[8rem]" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {list.isFetchingNextPage ? t`Loading…` : t`Load ${nextText} more`}
              </button>
            </div>
          </SpanCells>
        </tr>
      )}
    </>
  );
}

/**
 * A split flag section's contents: the same accounts grouped by sign-up address (the server's group by ip over the
 * section's filter), busiest address first, each its own section with its own paging and "Select all".
 */
function AddressSections({
  parentId,
  parent,
  parentCovers,
  shared,
}: {
  parentId: string;
  parent: SectionData;
  parentCovers: (r: Row) => boolean;
  shared: SectionShared;
}) {
  const trpc = useTRPC();
  const groups = useQuery(trpc.admin.users.groups.queryOptions({ ...parent.filter, by: "ip", limit: 0 }, { placeholderData: keepPreviousData }));
  const subs: SectionData[] = groups.data?.groups ?? [];
  if (groups.error)
    return (
      <tr>
        <SpanCells cols={shared.colCount} className="h-11 border-t border-line ps-8 pe-3 text-xs text-err">
          {groups.error.message}
        </SpanCells>
      </tr>
    );
  if (groups.isPending)
    return <>{Array.from({ length: Math.min(parent.total, LIST_SKELETON_ROWS) }, (_, i) => shared.skeletonRow(i, `${parentId}-sk-${i}`))}</>;
  return (
    <>
      {subs.map((g) => {
        const own = sectionCovers("ip", g.key, subs);
        return (
          <UserGroupSection
            key={g.key}
            id={`${parentId}/ip:${g.key}`}
            section={g}
            address={g.key !== IP_GROUP_REST}
            depth={1}
            selectLabel={`${parent.label} · ${g.label}`}
            covers={(r) => parentCovers(r) && own(r)}
            shared={shared}
          />
        );
      })}
      {!!groups.data?.moreSections && <MoreAddresses n={groups.data.moreSections} cols={shared.colCount} nested />}
    </>
  );
}

/** Group by address lists the busiest MAX_IP_GROUPS addresses; this row says how many were left out. */
function MoreAddresses({ n, cols, nested = false }: { n: number; cols: { folded: number; full: number }; nested?: boolean }) {
  return (
    <tr>
      <SpanCells cols={cols} className={`h-11 border-t border-line text-xs text-ink3 ${nested ? "ps-8 pe-3" : "px-3"}`}>
        {plural(n, {
          one: "# more shared address not shown. Search or filter to narrow the list.",
          other: "# more shared addresses not shown. Search or filter to narrow the list.",
        })}
      </SpanCells>
    </tr>
  );
}

/**
 * A cell across the rest of a row. The list hides its `full` columns below 1040px, and a colSpan wider than the
 * visible columns adds phantom columns that squeeze the others, so there is one cell per layout.
 */
function SpanCells({
  cols,
  minus = 0,
  className,
  children,
}: {
  cols: { folded: number; full: number };
  minus?: number;
  className: string;
  children: ReactNode;
}) {
  return (
    <>
      <td colSpan={cols.folded - minus} className={`${className} min-[1040px]:hidden`}>
        {children}
      </td>
      <td colSpan={cols.full - minus} className={`${className} hidden min-[1040px]:table-cell`}>
        {children}
      </td>
    </>
  );
}

type LimitKey =
  | "MAX_PROJECTS_PER_USER"
  | "MAX_SOURCE_MINUTES_PER_DAY"
  | "MAX_SOURCE_MINUTES_PER_MONTH"
  | "MAX_NEW_PROJECTS_PER_HOUR"
  | "MAX_LIVE_JOBS_PER_USER"
  | "MAX_RERENDERS_PER_HOUR"
  | "MAX_STORAGE_MB"
  | "MAX_REQUESTS_PER_MINUTE"
  | "MAX_REQUESTS_PER_HOUR"
  | "MAX_WEBHOOKS_PER_USER"
  | "MAX_MANUAL_CLIPS_PER_USER";
const LIMITS: Array<{ key: LimitKey; label: MessageDescriptor; window: MessageDescriptor; unit: MessageDescriptor | string }> = [
  { key: "MAX_PROJECTS_PER_USER", label: msg`Projects kept`, window: msg`all projects the account has now`, unit: msg`projects` },
  { key: "MAX_SOURCE_MINUTES_PER_DAY", label: msg`Minutes of video per day`, window: msg`since 00:00 UTC today`, unit: msg`minutes` },
  { key: "MAX_SOURCE_MINUTES_PER_MONTH", label: msg`Minutes of video per month`, window: msg`this billing period, or the calendar month`, unit: msg`minutes` },
  { key: "MAX_NEW_PROJECTS_PER_HOUR", label: msg`New projects per hour`, window: msg`the last 60 minutes`, unit: msg`projects` },
  { key: "MAX_LIVE_JOBS_PER_USER", label: msg`Jobs at once`, window: msg`queued or running now`, unit: msg`jobs` },
  { key: "MAX_RERENDERS_PER_HOUR", label: msg`Renders asked for per hour`, window: msg`re-renders and new clips, the last 60 minutes`, unit: msg`renders` },
  { key: "MAX_STORAGE_MB", label: msg`Storage`, window: msg`sources, uploads, renders and intros/outros kept now`, unit: "MB" },
  { key: "MAX_REQUESTS_PER_MINUTE", label: msg`Changes per minute`, window: msg`API mutations and MCP tool calls, this minute`, unit: msg`requests` },
  { key: "MAX_REQUESTS_PER_HOUR", label: msg`Changes per hour`, window: msg`the last 60 minutes`, unit: msg`requests` },
  { key: "MAX_WEBHOOKS_PER_USER", label: msg`Webhooks`, window: msg`endpoints the account has now`, unit: msg`webhooks` },
  { key: "MAX_MANUAL_CLIPS_PER_USER", label: msg`Clips made by hand`, window: msg`every clip the account added by hand, deleted ones too`, unit: msg`clips` },
];

/** Where the watermark decision in force comes from, as the hint names it. */
const wmWhyOf = (src: string | undefined) =>
  src === "admin" ? t`admins never get one` : src === "plan" ? t`from the plan` : src === "override" ? t`your choice` : t`instance setting`;

const WATERMARK_OPTIONS = [
  { value: "default", label: msg`Follow`, title: msg`Follow the plan and the instance setting` },
  { value: "on", label: msg`Always`, title: msg`Always burn the watermark into this account's renders` },
  { value: "off", label: msg`Never`, title: msg`Never burn the watermark into this account's renders` },
] as const;

/**
 * Per-user quota overrides, each next to what the account has used and where the value in force comes from
 * (instance, plan, override); the watermark decision; the queue priority; and, on a hosted instance, a complimentary plan.
 * Empty = the instance setting or the plan (0 = unlimited).
 */
function LimitsDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const { t } = useLingui();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = useQuery(trpc.admin.users.limits.queryOptions({ id: row.id }));
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [wmDraft, setWmDraft] = useState<string | null>(null);
  const [planDraft, setPlanDraft] = useState<string | null>(null);
  const [prioDraft, setPrioDraft] = useState<string | null>(null);
  const prioCurrent = q.data?.queuePriority.override == null ? "" : String(q.data.queuePriority.override);
  const prio = prioDraft ?? prioCurrent;
  const prioValue = prio.trim() === "" ? null : Number(prio);
  const prioInvalid = prioValue !== null && (!Number.isInteger(prioValue) || prioValue < QUEUE_PRIORITY_MIN || prioValue > QUEUE_PRIORITY_MAX);
  // resource ceiling (hosted plans only; q.data.resources is null self-hosted): both fields, or both empty to follow the plan
  const [resDraft, setResDraft] = useState<{ cores: string; mem: string } | null>(null);
  const resOverride = q.data?.resources?.override ?? null;
  const resCurrent = { cores: resOverride ? String(resOverride.maxCores) : "", mem: resOverride ? String(resOverride.maxMemMB) : "" };
  const res = resDraft ?? resCurrent;
  const resCores = res.cores.trim() === "" ? null : Number(res.cores);
  const resMem = res.mem.trim() === "" ? null : Number(res.mem);
  const resInvalid =
    (resCores === null) !== (resMem === null) ||
    (resCores !== null && (!Number.isInteger(resCores) || resCores < 1 || resCores > RESOURCE_CEILING_MAX_CORES)) ||
    (resMem !== null && (!Number.isInteger(resMem) || resMem < 1 || resMem > RESOURCE_CEILING_MAX_MEM_MB));
  const resChanged = resDraft !== null && (res.cores.trim() !== resCurrent.cores || res.mem.trim() !== resCurrent.mem);
  const values = draft ?? Object.fromEntries(Object.entries(q.data?.overrides ?? {}).map(([k, v]) => [k, String(v)]));
  const wmCurrent = q.data?.watermark.override === true ? "on" : q.data?.watermark.override === false ? "off" : "default";
  const wm = wmDraft ?? wmCurrent;
  const hasPlans = row.plan !== null;
  const rowEmail = row.email;
  const planCurrent = q.data?.plan ?? "free";
  const plan = planDraft ?? planCurrent;
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: trpc.admin.users.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.admin.billing.pathKey() });
  };
  const fail = (e: { message: string }) => toast.error(e.message);
  const wmWhyText = wmWhyOf(q.data?.watermark.source);
  const save = useMutation({ ...trpc.admin.users.setLimits.mutationOptions(), onError: fail });
  const saveWm = useMutation({ ...trpc.admin.users.setWatermark.mutationOptions(), onError: fail });
  const savePlan = useMutation({ ...trpc.admin.billing.setPlan.mutationOptions(), onError: fail });
  const savePrio = useMutation({ ...trpc.admin.users.setQueuePriority.mutationOptions(), onError: fail });
  const saveRes = useMutation({ ...trpc.admin.users.setResources.mutationOptions(), onError: fail });
  const busy = save.isPending || saveWm.isPending || savePlan.isPending || savePrio.isPending || saveRes.isPending;
  const resPlan = q.data?.resources?.plan;
  const maxCores = RESOURCE_CEILING_MAX_CORES;
  const maxMem = RESOURCE_CEILING_MAX_MEM_MB;
  const coresOf = (n: number) => plural(n, { one: "# core", other: "# cores" });
  const resOverrideText = resCores !== null ? coresOf(resCores) : "";
  const resMemText = resMem ?? 0;
  const resPlanCores = resPlan ? coresOf(resPlan.maxCores) : "";
  const resPlanMem = resPlan?.maxMemMB ?? 0;
  const resHint = !q.data?.resources
    ? ""
    : resInvalid
      ? t`Both, in whole numbers: 1 to ${maxCores} cores and 1 to ${maxMem} MB. Leave both empty to follow the plan.`
      : [
          resCores !== null ? t`Override: ${resOverrideText} / ${resMemText} MB.` : t`Following the plan.`,
          resPlan ? t`The plan gives ${resPlanCores} / ${resPlanMem} MB.` : "",
          t`A scan past it gets fewer threads, a render waits in the queue.`,
        ]
          .filter(Boolean)
          .join(" ");
  const prioMin = QUEUE_PRIORITY_MIN;
  const prioMax = QUEUE_PRIORITY_MAX;
  const prioShown = prioValue !== null ? formatPriority(prioValue) : "";
  const prioAbs = Math.abs(prioValue ?? 0);
  const planPrio = q.data?.queuePriority.plan ? formatPriority(q.data.queuePriority.plan) : "";
  const prioHint = !q.data
    ? ""
    : prioInvalid
      ? t`A whole number from ${prioMin} to ${prioMax}.`
      : prioValue !== null
        ? [
            prioValue >= 0
              ? t`${prioShown}: next jobs start as if this account had ${prioAbs} fewer queued.`
              : t`${prioShown}: next jobs start as if this account had ${prioAbs} more queued.`,
            planPrio ? t`The plan gives ${planPrio}.` : "",
          ]
            .filter(Boolean)
            .join(" ")
        : planPrio
          ? t`Following the plan: ${planPrio}, ahead of Free.`
          : t`Following the plan: no priority (0). Negative holds an account back.`;
  const planName = q.data?.plan;
  const planPrioOrZero = formatPriority(q.data?.queuePriority.plan ?? 0);
  const planWord = planName ? t`${planName} plan` : t`plan`;
  const sourceWord = (k: LimitKey) => (q.data?.source[k] === "plan" ? planWord : q.data?.source[k] === "override" ? t`override` : t`instance`);
  const wmHint =
    wm === "on"
      ? t`Next render: watermark on (always).`
      : wm === "off"
        ? t`Next render: no watermark (never).`
        : !q.data
          ? ""
          : wmDraft === "default" && q.data.watermark.override != null
            ? t`Next render: follow the plan and instance setting (after save).`
            : q.data.watermark.effective
              ? t`Next render: watermark on (${wmWhyText}).`
              : t`Next render: no watermark (${wmWhyText}).`;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={t`Limits for ${rowEmail}`} width={460}>
      <form
        className="flex min-h-0 flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const limits = Object.fromEntries(LIMITS.map(({ key }) => [key, values[key]?.trim() ? Number(values[key]) : null])) as Record<
            LimitKey,
            number | null
          >;
          try {
            if (draft) await save.mutateAsync({ id: row.id, limits });
            if (wmDraft !== null && wm !== wmCurrent) await saveWm.mutateAsync({ id: row.id, watermark: wm === "default" ? null : wm === "on" });
            if (hasPlans && planDraft !== null && plan !== planCurrent) await savePlan.mutateAsync({ id: row.id, plan: plan === "free" ? null : plan });
            if (prioDraft !== null && prio.trim() !== prioCurrent) await savePrio.mutateAsync({ id: row.id, priority: prioValue });
            if (resChanged)
              await saveRes.mutateAsync({ id: row.id, resources: resCores !== null && resMem !== null ? { maxCores: resCores, maxMemMB: resMem } : null });
          } catch {
            return; // the toast said why; keep the dialog open
          }
          toast(t`Saved`);
          invalidate();
          onClose();
        }}
      >
        <ScrollArea className="max-h-[min(60dvh,calc(90dvh-8rem))]">
          <div className="flex flex-col gap-4 pe-3">
            {hasPlans && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="limit-plan" className="text-xs font-semibold text-ink2">
                  <Trans>Plan</Trans>
                </label>
                {q.isPending ? (
                  <Skeleton className="h-[38px] w-full rounded-[10px]" />
                ) : (
                  <Select
                    value={plan}
                    onValueChange={setPlanDraft}
                    ariaLabel={t`Plan`}
                    options={[
                      { value: "free", label: t`Free (no grant)` },
                      { value: "starter", label: t`Starter, complimentary` },
                      { value: "creator", label: t`Creator, complimentary` },
                      { value: "pro", label: t`Pro, complimentary` },
                    ]}
                  />
                )}
                <span className="min-h-4 text-xs text-ink3">
                  {q.data
                    ? q.data.plan && q.data.plan !== "free"
                      ? t`In force: ${planName}. A complimentary grant is refused while the account pays through Stripe.`
                      : t`Free. A complimentary grant gives a plan without Stripe.`
                    : ""}
                </span>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-ink2">
                <Trans>Watermark</Trans>
              </span>
              {q.isPending ? (
                <Skeleton className="h-[38px] w-full rounded-[10px]" />
              ) : (
                <Segmented
                  ariaLabel={t`Watermark`}
                  value={wm}
                  onChange={setWmDraft}
                  className="w-full"
                  options={WATERMARK_OPTIONS.map((o) => ({ value: o.value, label: i18n._(o.label), title: i18n._(o.title) }))}
                />
              )}
              <span className="min-h-4 text-xs text-ink3">{wmHint}</span>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="limit-queue-priority" className="flex items-baseline justify-between text-xs font-semibold text-ink2">
                <Trans>Queue priority</Trans>
                <span className="font-normal text-ink3">{q.data && !prio.trim() ? (q.data.queuePriority.plan ? planWord : t`default`) : ""}</span>
              </label>
              {q.isPending ? (
                <Skeleton className="h-[38px] w-full rounded-[10px]" />
              ) : (
                <input
                  id="limit-queue-priority"
                  className="input"
                  type="number"
                  step={1}
                  min={QUEUE_PRIORITY_MIN}
                  max={QUEUE_PRIORITY_MAX}
                  value={prio}
                  aria-invalid={prioInvalid || undefined}
                  placeholder={q.data ? t`plan: ${planPrioOrZero}` : ""}
                  onChange={(e) => setPrioDraft(e.target.value)}
                />
              )}
              <span className={`min-h-4 text-xs ${prioInvalid ? "text-err" : "text-ink3"}`}>{prioHint}</span>
            </div>
            {q.data?.resources && (
              <div className="flex flex-col gap-1.5">
                <span className="flex items-baseline justify-between text-xs font-semibold text-ink2">
                  <Trans>Resource ceiling</Trans>
                  <span className="font-normal text-ink3">{resCores === null && resMem === null ? planWord : t`override`}</span>
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    className="input"
                    type="number"
                    step={1}
                    min={1}
                    max={RESOURCE_CEILING_MAX_CORES}
                    aria-label={t`Most cores at once`}
                    aria-invalid={resInvalid || undefined}
                    value={res.cores}
                    placeholder={resPlan ? t`plan: ${resPlanCores}` : t`cores`}
                    onChange={(e) => setResDraft({ ...res, cores: e.target.value })}
                  />
                  <input
                    className="input"
                    type="number"
                    step={1}
                    min={1}
                    max={RESOURCE_CEILING_MAX_MEM_MB}
                    aria-label={t`Most memory at once, MB`}
                    aria-invalid={resInvalid || undefined}
                    value={res.mem}
                    placeholder={resPlan ? t`plan: ${resPlanMem} MB` : "MB"}
                    onChange={(e) => setResDraft({ ...res, mem: e.target.value })}
                  />
                </div>
                <span className={`min-h-4 text-xs ${resInvalid ? "text-err" : "text-ink3"}`}>{resHint}</span>
              </div>
            )}
            {LIMITS.map(({ key, label: labelMsg, window: windowMsg, unit: unitMsg }) => {
              const label = i18n._(labelMsg);
              const window = i18n._(windowMsg);
              const unit = typeof unitMsg === "string" ? unitMsg : i18n._(unitMsg);
              const used = q.data?.usage?.[key];
              const typed = values[key]?.trim();
              const cap = typed ? Number(typed) : (q.data?.effective?.[key] ?? 0);
              const ratio = used === undefined || !cap ? 0 : used / cap;
              const state =
                ratio >= 1
                  ? { glyph: "✕", word: t`Over the limit`, tone: "text-err", bar: "bg-err" }
                  : ratio >= 0.8
                    ? { glyph: "◷", word: t`Near the limit`, tone: "text-warn", bar: "bg-warn" }
                    : null;
              const usedText = formatNumber(used ?? 0);
              const capText = formatNumber(cap);
              const src = q.data?.source[key] === "plan" ? t`plan` : t`instance`;
              const inForce = !q.data
                ? ""
                : q.data.effective[key] === 0 && !q.data.overrides[key]
                  ? t`unlimited`
                  : q.data.source[key] === "override"
                    ? q.data.instance[key] === 0
                      ? t`unlimited`
                      : String(q.data.instance[key])
                    : String(q.data.effective[key]);
              return (
                <div key={key} className="flex flex-col gap-1.5">
                  <label htmlFor={`limit-${key}`} className="flex items-baseline justify-between text-xs font-semibold text-ink2">
                    {label}
                    <span className="font-normal text-ink3">{q.data && !typed ? sourceWord(key) : ""}</span>
                  </label>
                  {q.isPending ? (
                    <Skeleton className="h-[38px] w-full rounded-[10px]" />
                  ) : (
                    <input
                      id={`limit-${key}`}
                      className="input"
                      type="number"
                      min={0}
                      value={values[key] ?? ""}
                      placeholder={q.data ? `${src}: ${inForce}` : ""}
                      onChange={(e) => setDraft({ ...values, [key]: e.target.value })}
                    />
                  )}
                  {q.isPending ? (
                    <Skeleton className="h-1 w-full rounded-full" />
                  ) : (
                    <div className="h-1 w-full overflow-hidden rounded-full bg-sunk" aria-hidden>
                      <div className={`h-full rounded-full ${state?.bar ?? "bg-acc"}`} style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }} />
                    </div>
                  )}
                  <div className="flex min-h-4 items-center justify-between gap-2 text-xs tabular-nums text-ink3">
                    <span>
                      {used === undefined ? (
                        <Skeleton className="inline-block h-3 w-32 align-middle" />
                      ) : cap ? (
                        t`${usedText} of ${capText} ${unit}`
                      ) : (
                        t`${usedText} ${unit}, no cap`
                      )}{" "}
                      · {window}
                    </span>
                    <span className={`shrink-0 ${state?.tone ?? ""}`}>{state ? `${state.glyph} ${state.word}` : ""}</span>
                  </div>
                </div>
              );
            })}
            <p className="text-xs text-ink3">
              <Trans>0 = unlimited. Empty = the plan's value, else the instance setting. An override wins over the plan.</Trans>
            </p>
          </div>
        </ScrollArea>
        <div className="flex shrink-0 justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </button>
          <button className="btn-ink min-w-[5rem]" disabled={busy || !q.data || prioInvalid || resInvalid}>
            {busy ? "…" : t`Save`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
