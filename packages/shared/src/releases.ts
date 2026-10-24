/**
 * GitHub releases + a 90-day commit heatmap. The website, the app, MCP and the CLI all
 * show the same feed; fetch is injected so tests do not hit the network.
 */
import { z } from "zod";

/** Same host as `REPO_URL` in index.ts — kept local so this module does not import the barrel. */
const REPO_URL = "https://github.com/osbytes/reelsaw";

export const RELEASES_WINDOW_DAYS = 90;
export const GITHUB_RELEASES_HTML = `${REPO_URL}/releases`;

const repoPath = new URL(REPO_URL).pathname.replace(/^\//, "").replace(/\/$/, "");
export const GITHUB_RELEASES_API = `https://api.github.com/repos/${repoPath}/releases`;
export const GITHUB_COMMITS_API = `https://api.github.com/repos/${repoPath}/commits`;

export const CHANGE_KINDS = ["major", "minor", "patch"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export type ActivityLevel = 0 | 1 | 2 | 3 | 4;

export interface ReleaseNote {
  kind: ChangeKind;
  text: string;
  pr?: number;
  sha?: string;
}

export interface Release {
  tag: string;
  version: string;
  name: string;
  url: string;
  publishedAt: string;
  prerelease: boolean;
  kinds: ChangeKind[];
  notes: ReleaseNote[];
  summary: string;
}

export interface DayRelease {
  tag: string;
  version: string;
  name: string;
}

export interface ActivityDay {
  /** YYYY-MM-DD in UTC */
  date: string;
  weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  commits: number;
  level: ActivityLevel;
  releases: DayRelease[];
  inWindow: boolean;
  future: boolean;
}

export interface ActivityWeek {
  start: string;
  days: ActivityDay[];
}

export interface ActivityMonth {
  label: string;
  weekIndex: number;
}

export interface ReleasesFeed {
  windowDays: number;
  since: string;
  until: string;
  releases: Release[];
  weeks: ActivityWeek[];
  months: ActivityMonth[];
  commits: number;
  commitDays: number;
  releaseDays: number;
  truncated: boolean;
  fetchedAt: string;
  sourceUrl: string;
}

const githubReleaseSchema = z.object({
  tag_name: z.string(),
  name: z.string().nullable().optional(),
  html_url: z.string(),
  published_at: z.string().nullable(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  body: z.string().nullable().optional(),
});

const githubCommitSchema = z.object({
  sha: z.string(),
  commit: z.object({
    committer: z.object({ date: z.string().nullable().optional() }).nullable().optional(),
    author: z.object({ date: z.string().nullable().optional() }).nullable().optional(),
  }),
});

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

const KIND_HEADING: Record<string, ChangeKind> = {
  major: "major",
  minor: "minor",
  patch: "patch",
};

const FETCH_TIMEOUT_MS = 20_000;
const MAX_RELEASE_PAGES = 3;
const MAX_COMMIT_PAGES = 10;

/** UTC calendar day `YYYY-MM-DD`. */
export function utcDay(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export function addUtcDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Sunday of the week containing `day`, UTC. */
export function utcWeekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(day: string): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  return new Date(`${day}T00:00:00Z`).getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function monthLabel(day: string): string {
  return MONTHS[new Date(`${day}T00:00:00Z`).getUTCMonth()] ?? "";
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Locale-stable UTC date, so Node and the browser do not disagree on "Sep" vs "Sept". */
export function formatUtcDate(isoOrDay: string, withWeekday = false): string {
  const day = isoOrDay.length >= 10 ? isoOrDay.slice(0, 10) : utcDay(isoOrDay);
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoOrDay;
  const body = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return withWeekday ? `${WEEKDAYS[d.getUTCDay()]}, ${body}` : body;
}

/** Strip a leading `v` and keep only a semver-looking tag; otherwise the raw tag. */
export function versionOfTag(tag: string): string {
  const t = tag.trim();
  return /^v\d/i.test(t) ? t.slice(1) : t;
}

function eat(rest: string, re: RegExp): { cap: string; rest: string } | null {
  const m = re.exec(rest);
  if (!m || m.index !== 0) return null;
  return { cap: m[1] ?? "", rest: rest.slice(m[0].length) };
}

function tidyNoteText(raw: string): string {
  return raw
    .replace(/^Thanks\s+\[[^\]]+\]\([^)]*\)!?\s*-+\s*/i, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/** One Changesets bullet: local `#123 \`sha\`` or GitHub's `[#123](url) [\`sha\`](url)` form. */
function parseNoteLine(line: string): { pr?: number; sha?: string; text: string } | null {
  if (!line.startsWith("- ") && !line.startsWith("* ")) return null;
  let rest = line.slice(2).trim();
  if (!rest) return null;
  let pr: number | undefined;
  let sha: string | undefined;
  const prMd = eat(rest, /^\[#(\d+)\]\([^)]*\)\s*/);
  const prPlain = eat(rest, /^#(\d+)\s+/);
  if (prMd) {
    pr = Number(prMd.cap);
    rest = prMd.rest;
  } else if (prPlain) {
    pr = Number(prPlain.cap);
    rest = prPlain.rest;
  }
  const shaMd = eat(rest, /^\[`([0-9a-f]{7,40})`\]\([^)]*\)\s*/i);
  const shaPlain = eat(rest, /^`([0-9a-f]{7,40})`\s+/i);
  if (shaMd) {
    sha = shaMd.cap;
    rest = shaMd.rest;
  } else if (shaPlain) {
    sha = shaPlain.cap;
    rest = shaPlain.rest;
  }
  const text = tidyNoteText(rest);
  if (!text) return null;
  return {
    text,
    ...(pr && Number.isFinite(pr) ? { pr } : {}),
    ...(sha ? { sha } : {}),
  };
}

export function parseReleaseNotes(body: string | null | undefined): { kinds: ChangeKind[]; notes: ReleaseNote[] } {
  const raw = (body ?? "").replace(/\r\n/g, "\n").trim();
  if (!raw) return { kinds: [], notes: [] };
  const cut = raw.search(/\n---\n/);
  const text = (cut >= 0 ? raw.slice(0, cut) : raw).trim();
  const notes: ReleaseNote[] = [];
  let kind: ChangeKind = "patch";
  for (const line of text.split("\n")) {
    const heading = /^###\s+(Major|Minor|Patch)\s+Changes\s*$/i.exec(line.trim());
    if (heading) {
      const k = heading[1]!.toLowerCase();
      kind = KIND_HEADING[k] ?? "patch";
      continue;
    }
    const item = parseNoteLine(line.trim());
    if (!item) continue;
    notes.push({ kind, ...item });
  }
  if (!notes.length && text) {
    const fallback = text
      .split("\n")
      .map((l) => tidyNoteText(l.replace(/^[-*]\s+/, "")))
      .filter((l) => l && !l.startsWith("#"));
    for (const t of fallback.slice(0, 12)) notes.push({ kind: "patch", text: t });
  }
  const kinds = CHANGE_KINDS.filter((k) => notes.some((n) => n.kind === k));
  return { kinds, notes };
}

export function summarizeNotes(notes: ReleaseNote[]): string {
  const first = notes[0]?.text.trim() ?? "";
  if (!first) return "";
  const sentence = /^.*?[.!?](?=\s|$)/.exec(first)?.[0] ?? first;
  return sentence.length > 180 ? `${sentence.slice(0, 177).trimEnd()}…` : sentence;
}

function toRelease(row: z.infer<typeof githubReleaseSchema>): Release | null {
  if (row.draft || !row.published_at) return null;
  const tag = row.tag_name.trim();
  if (!tag) return null;
  const parsed = parseReleaseNotes(row.body);
  const version = versionOfTag(tag);
  const name = (row.name ?? "").trim() || tag;
  return {
    tag,
    version,
    name,
    url: row.html_url,
    publishedAt: row.published_at,
    prerelease: row.prerelease,
    kinds: parsed.kinds,
    notes: parsed.notes,
    summary: summarizeNotes(parsed.notes) || name,
  };
}

/** Quartile-style levels over the non-zero days, GitHub contribution-graph style. */
export function levelsFor(counts: number[]): ActivityLevel[] {
  const nonzero = [...new Set(counts.filter((n) => n > 0))].sort((a, b) => a - b);
  if (!nonzero.length) return counts.map(() => 0);
  const q = (p: number) => nonzero[Math.min(nonzero.length - 1, Math.max(0, Math.ceil(p * nonzero.length) - 1))] ?? nonzero[0]!;
  const t1 = q(0.25);
  const t2 = q(0.5);
  const t3 = q(0.75);
  return counts.map((n) => {
    if (n <= 0) return 0;
    if (n <= t1) return 1;
    if (n <= t2) return 2;
    if (n <= t3) return 3;
    return 4;
  });
}

export function buildActivity(opts: {
  until: string;
  windowDays?: number;
  commitDays: Map<string, number>;
  releases: Release[];
}): { weeks: ActivityWeek[]; months: ActivityMonth[]; commits: number; commitDays: number; releaseDays: number; since: string } {
  const windowDays = opts.windowDays ?? RELEASES_WINDOW_DAYS;
  const until = opts.until;
  const since = addUtcDays(until, -(windowDays - 1));
  const gridStart = utcWeekStart(since);
  const last = utcWeekStart(until);
  const byDay = new Map<string, Release[]>();
  for (const r of opts.releases) {
    const day = utcDay(r.publishedAt);
    if (!day) continue;
    const list = byDay.get(day) ?? [];
    list.push(r);
    byDay.set(day, list);
  }

  const weeks: ActivityWeek[] = [];
  const cells: ActivityDay[] = [];
  for (let start = gridStart; start <= last; start = addUtcDays(start, 7)) {
    const days: ActivityDay[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addUtcDays(start, i);
      const inWindow = date >= since && date <= until;
      const future = date > until;
      const rels = byDay.get(date) ?? [];
      const day: ActivityDay = {
        date,
        weekday: i as 0 | 1 | 2 | 3 | 4 | 5 | 6,
        commits: inWindow && !future ? (opts.commitDays.get(date) ?? 0) : 0,
        level: 0,
        releases: rels.map((r) => ({ tag: r.tag, version: r.version, name: r.name })),
        inWindow,
        future,
      };
      days.push(day);
      cells.push(day);
    }
    weeks.push({ start, days });
  }

  const windowCells = cells.filter((c) => c.inWindow && !c.future);
  const lv = levelsFor(windowCells.map((c) => c.commits));
  windowCells.forEach((c, i) => {
    const level = lv[i];
    if (level !== undefined) c.level = level;
  });

  const months: ActivityMonth[] = [];
  let lastWeek = -3;
  let lastMonth = "";
  weeks.forEach((w, weekIndex) => {
    const firstIn = w.days.find((d) => d.inWindow);
    if (!firstIn) return;
    const label = monthLabel(firstIn.date);
    if (label === lastMonth) return;
    if (weekIndex - lastWeek < 2 && months.length) return;
    months.push({ label, weekIndex });
    lastWeek = weekIndex;
    lastMonth = label;
  });

  const commits = windowCells.reduce((n, c) => n + c.commits, 0);
  const commitDays = windowCells.filter((c) => c.commits > 0).length;
  const releaseDays = windowCells.filter((c) => c.releases.length > 0).length;
  return { weeks, months, commits, commitDays, releaseDays, since };
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/i.exec(part.trim());
    if (m?.[1]) return m[1];
  }
  return null;
}

async function getJson(doFetch: FetchLike, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ body: unknown; next: string | null; status: number }> {
  const res = await doFetch(url, { headers, signal });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return { body: await res.json(), next: nextLink(res.headers.get("link")), status: res.status };
}

export interface LoadReleasesOpts {
  fetch: FetchLike;
  userAgent: string;
  token?: string;
  now?: Date;
  windowDays?: number;
  signal?: AbortSignal;
}

/**
 * Releases list + commit counts for the heatmap. Paginates GitHub; `truncated` is true when a
 * page cap cut the commit walk off.
 */
export async function loadReleasesFeed(opts: LoadReleasesOpts): Promise<ReleasesFeed> {
  const now = opts.now ?? new Date();
  const until = utcDay(now);
  const windowDays = opts.windowDays ?? RELEASES_WINDOW_DAYS;
  const since = addUtcDays(until, -(windowDays - 1));
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": opts.userAgent,
    "x-github-api-version": "2022-11-28",
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const signal = opts.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const doFetch = opts.fetch;

  const rawReleases: unknown[] = [];
  let relUrl: string | null = `${GITHUB_RELEASES_API}?per_page=100`;
  for (let page = 0; relUrl && page < MAX_RELEASE_PAGES; page++) {
    const { body, next } = await getJson(doFetch, relUrl, headers, signal);
    if (!Array.isArray(body)) throw new Error("GitHub releases response was not a list");
    rawReleases.push(...body);
    relUrl = next;
  }
  const releases = rawReleases
    .map((row) => {
      const parsed = githubReleaseSchema.safeParse(row);
      return parsed.success ? toRelease(parsed.data) : null;
    })
    .filter((r): r is Release => r !== null)
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));

  const commitDays = new Map<string, number>();
  let truncated = false;
  let commitUrl: string | null = `${GITHUB_COMMITS_API}?since=${encodeURIComponent(`${since}T00:00:00Z`)}&per_page=100`;
  for (let page = 0; commitUrl && page < MAX_COMMIT_PAGES; page++) {
    const { body, next } = await getJson(doFetch, commitUrl, headers, signal);
    if (!Array.isArray(body)) throw new Error("GitHub commits response was not a list");
    for (const row of body) {
      const parsed = githubCommitSchema.safeParse(row);
      if (!parsed.success) continue;
      const iso = parsed.data.commit.committer?.date ?? parsed.data.commit.author?.date;
      if (!iso) continue;
      const day = utcDay(iso);
      if (!day || day < since || day > until) continue;
      commitDays.set(day, (commitDays.get(day) ?? 0) + 1);
    }
    if (next && page === MAX_COMMIT_PAGES - 1) truncated = true;
    commitUrl = next;
  }

  const activity = buildActivity({ until, windowDays, commitDays, releases });
  return {
    windowDays,
    since: activity.since,
    until,
    releases,
    weeks: activity.weeks,
    months: activity.months,
    commits: activity.commits,
    commitDays: activity.commitDays,
    releaseDays: activity.releaseDays,
    truncated,
    fetchedAt: now.toISOString(),
    sourceUrl: GITHUB_RELEASES_HTML,
  };
}
