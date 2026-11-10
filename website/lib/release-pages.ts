/**
 * The changelog's pages beyond the list: one release (`/releases/v0.19.1`), a set of releases
 * (`/releases/v0.17.0..v0.19.1`, `/releases/v0.15.0,v0.18.2`) or the releases on some days
 * (`/releases/2026-11-05..2026-11-10`). A release, not a day, is the unit: several can ship in
 * one day, so the day is only a heading. Website-only; the feed itself is `releases-data.ts`.
 */
import { addUtcDays, formatUtcDate, type Release } from "./releases-data";

export function releasePath(tag: string): string {
  return `/releases/${tag}`;
}

/** A release's one-line headline: its first note's first sentence (Changesets has no titles). */
export function releaseTitle(r: Release): string {
  return headline(r.summary || r.name);
}

/** A sentence as a headline: no closing period or colon. */
function headline(text: string): string {
  return text.replace(/[.:]$/, "");
}

/** The UTC day a release shipped, `YYYY-MM-DD`. */
export function releaseDay(r: Release): string {
  return r.publishedAt.slice(0, 10);
}

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

function parts(day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
}

/** "10 November 2026", "5 – 10 November 2026", "28 October – 3 November 2026". */
export function formatDayRange(from: string, to: string): string {
  if (from === to) return formatLongDay(from);
  const a = parts(from);
  const b = parts(to);
  if (a.y === b.y && a.m === b.m) return `${a.d} – ${b.d} ${MONTHS_LONG[b.m]} ${b.y}`;
  if (a.y === b.y) return `${a.d} ${MONTHS_LONG[a.m]} – ${b.d} ${MONTHS_LONG[b.m]} ${b.y}`;
  return `${formatLongDay(from)} – ${formatLongDay(to)}`;
}

export function formatLongDay(day: string): string {
  const { y, m, d } = parts(day);
  return `${d} ${MONTHS_LONG[m]} ${y}`;
}

export function releaseCount(n: number): string {
  return n === 1 ? "1 release" : `${n} releases`;
}

export interface ReleaseDayGroup {
  /** `YYYY-MM-DD`, also the section's anchor. */
  date: string;
  /** "November 2026" */
  monthLabel: string;
  /** "10" */
  dayOfMonth: string;
  /** "10 Nov 2026" */
  dayLabel: string;
  releases: Release[];
}

/** Newest-first releases under the day they shipped. */
export function groupReleasesByDay(releases: readonly Release[]): ReleaseDayGroup[] {
  const groups: ReleaseDayGroup[] = [];
  for (const r of releases) {
    const date = releaseDay(r);
    const current = groups.at(-1);
    if (current?.date === date) {
      current.releases.push(r);
      continue;
    }
    const { y, m, d } = parts(date);
    groups.push({ date, monthLabel: `${MONTHS_LONG[m]} ${y}`, dayOfMonth: String(d), dayLabel: formatUtcDate(date), releases: [r] });
  }
  return groups;
}

export const SELECTION_MAX_PARTS = 20;
export const SET_HIGHLIGHT_LIMIT = 3;

// A tag with an optional pre-release (`v1.0.0-rc.1`); its dots never come in pairs, so `..` splits a range.
const TAG = String.raw`(v\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)`;
const TAG_ONLY = new RegExp(`^${TAG}$`);
const TAG_PART = new RegExp(`^${TAG}(?:\\.\\.${TAG})?$`);
// Months and days may skip their leading zero (`2026-11-5`), as people type them.
const DAY = String.raw`(\d{4})-(\d{1,2})-(\d{1,2})`;
const DAY_PART = new RegExp(`^${DAY}(?:\\.\\.${DAY})?$`);

/** A selection's comma-separated parts, or null when it can't be one. Next passes segments still encoded (`%2C`). */
function splitSelection(param: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(param);
  } catch {
    return null;
  }
  const list = decoded.split(",").map((p) => p.trim());
  return list.length === 0 || list.length > SELECTION_MAX_PARTS ? null : list;
}

/**
 * The releases a selection of tags names, newest first, like git's `a..b`: both ends included,
 * either first; parts mix (`v0.15.0,v0.17.0..v0.19.1`). Null when a tag is not a published release.
 */
export function parseTagSelection(param: string, releases: readonly Release[]): Release[] | null {
  const list = splitSelection(param);
  if (!list) return null;
  const index = new Map(releases.map((r, i) => [r.tag, i]));
  const picked = new Set<number>();
  for (const part of list) {
    const m = TAG_PART.exec(part);
    if (!m?.[1]) return null;
    const first = index.get(m[1]);
    const last = index.get(m[2] ?? m[1]);
    if (first === undefined || last === undefined) return null;
    for (let i = Math.min(first, last); i <= Math.max(first, last); i++) picked.add(i);
  }
  return [...picked].sort((a, b) => a - b).map((i) => releases[i]!);
}

/** The one spelling of a tag selection: runs of consecutive releases become `older..newer`, oldest first. */
export function formatTagSelection(selected: readonly Release[], releases: readonly Release[]): string {
  const index = new Map(releases.map((r, i) => [r.tag, i]));
  const idx = selected
    .map((r) => index.get(r.tag))
    .filter((i): i is number => i !== undefined)
    .sort((a, b) => b - a);
  const runs: number[][] = [];
  for (const i of idx) {
    const run = runs.at(-1);
    if (run && run[run.length - 1]! - 1 === i) run.push(i);
    else runs.push([i]);
  }
  return runs
    .map((run) => {
      const oldest = releases[run[0]!]!.tag;
      const newest = releases[run[run.length - 1]!]!.tag;
      return run.length === 1 ? oldest : `${oldest}..${newest}`;
    })
    .join(",");
}

/** Both ends included, `from` never after `to`. */
export type DaySpan = { from: string; to: string };

function realDay(y: string, m: string, d: string): string | null {
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Days instead of tags: `2026-11-06`, `2026-11-05..2026-11-10`, or a mix. Sorted, with spans that
 * overlap or touch merged. Null when a part is not a real date. Days and tags don't mix in one link.
 */
export function parseDaySelection(param: string): DaySpan[] | null {
  const list = splitSelection(param);
  if (!list) return null;
  const spans: DaySpan[] = [];
  for (const part of list) {
    const m = DAY_PART.exec(part);
    if (!m) return null;
    const first = realDay(m[1]!, m[2]!, m[3]!);
    const last = m[4] === undefined ? first : realDay(m[4], m[5]!, m[6]!);
    if (!first || !last) return null;
    spans.push(first <= last ? { from: first, to: last } : { from: last, to: first });
  }
  spans.sort((a, b) => a.from.localeCompare(b.from));
  const merged: DaySpan[] = [];
  for (const span of spans) {
    const current = merged.at(-1);
    if (current && span.from <= addUtcDays(current.to, 1)) {
      if (span.to > current.to) current.to = span.to;
    } else merged.push({ ...span });
  }
  return merged;
}

export function formatDaySelection(spans: readonly DaySpan[]): string {
  return spans.map((s) => (s.from === s.to ? s.from : `${s.from}..${s.to}`)).join(",");
}

const isFeature = (r: Release) => r.kinds.includes("major") || r.kinds.includes("minor");

/**
 * Highlights for a set: each release's first note in turn (major and minor releases before
 * patches, newest first), then second notes, until `limit`.
 */
export function mergeHighlights(selected: readonly Release[], limit = SET_HIGHLIGHT_LIMIT): string[] {
  const ordered = [...selected].sort((a, b) => Number(isFeature(b)) - Number(isFeature(a)));
  const lists = ordered.map((r) => {
    const notes = [...r.notes].sort((a, b) => Number(b.kind !== "patch") - Number(a.kind !== "patch"));
    return notes.length ? notes.map((n) => firstSentence(n.text)) : [releaseTitle(r)];
  });
  const out: string[] = [];
  for (let round = 0; out.length < limit && lists.some((l) => l.length > round); round++) {
    for (const list of lists) {
      const h = list[round];
      if (h !== undefined && !out.includes(h)) out.push(h);
      if (out.length === limit) break;
    }
  }
  return out;
}

function firstSentence(text: string): string {
  const s = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
  return headline(s.length > 140 ? `${s.slice(0, 137).trimEnd()}…` : s);
}

export type ResolvedReleases =
  | { kind: "release"; release: Release; newer: Release | null; older: Release | null; sameDay: Release[] }
  | {
      kind: "set";
      by: "tags" | "days";
      /** The canonical spelling; the page redirects any other to it. */
      selection: string;
      /** Newest first. */
      releases: Release[];
      /** "v0.17.0 to v0.19.1", "3 releases", "5 – 10 November 2026" */
      label: string;
      /** "What shipped in v0.17.0 to v0.19.1", "What shipped on 6 November 2026" */
      heading: string;
      dayRange: string;
      highlights: string[];
    }
  | {
      /** Real days, but nothing shipped on them. */
      kind: "empty";
      selection: string;
      label: string;
      heading: string;
      /** The last release before those days and the first after. */
      older: Release | null;
      newer: Release | null;
    };

/** What `/releases/<param>` shows, or null (404). `releases` is newest first. */
export function resolveReleasesParam(param: string, releases: readonly Release[]): ResolvedReleases | null {
  let decoded = param;
  try {
    decoded = decodeURIComponent(param);
  } catch {
    return null;
  }
  if (TAG_ONLY.test(decoded)) {
    const i = releases.findIndex((r) => r.tag === decoded);
    if (i === -1) return null;
    const release = releases[i]!;
    const day = releaseDay(release);
    return {
      kind: "release",
      release,
      newer: releases[i - 1] ?? null,
      older: releases[i + 1] ?? null,
      sameDay: releases.filter((r) => r.tag !== release.tag && releaseDay(r) === day),
    };
  }

  const selected = parseTagSelection(param, releases);
  if (selected?.length) {
    const selection = formatTagSelection(selected, releases);
    const range = /^(v[^,]+?)\.\.(v[^,]+)$/.exec(selection);
    const label = range ? `${range[1]} to ${range[2]}` : releaseCount(selected.length);
    return describeSet(selected, { by: "tags", selection, label, heading: `What shipped in ${label}` });
  }

  const spans = parseDaySelection(param);
  if (!spans?.length) return null;
  const selection = formatDaySelection(spans);
  const label = spans.length === 1 ? formatDayRange(spans[0]!.from, spans[0]!.to) : `${spans.length} date ranges`;
  // "5 – 10 November 2026", but "on 6 November 2026" and "on 3 date ranges".
  const when = spans.length === 1 && spans[0]!.from !== spans[0]!.to ? label : `on ${label}`;
  const inDays = releases.filter((r) => {
    const day = releaseDay(r);
    return spans.some((s) => day >= s.from && day <= s.to);
  });
  if (!inDays.length) {
    const firstDay = spans[0]!.from;
    const lastDay = spans[spans.length - 1]!.to;
    return {
      kind: "empty",
      selection,
      label,
      heading: `Nothing shipped ${when}`,
      older: releases.find((r) => releaseDay(r) < firstDay) ?? null,
      newer: releases.filter((r) => releaseDay(r) > lastDay).at(-1) ?? null,
    };
  }
  return describeSet(inDays, { by: "days", selection, label, heading: `What shipped ${when}` });
}

function describeSet(selected: Release[], naming: { by: "tags" | "days"; selection: string; label: string; heading: string }): ResolvedReleases {
  return {
    kind: "set",
    ...naming,
    releases: selected,
    dayRange: formatDayRange(releaseDay(selected[selected.length - 1]!), releaseDay(selected[0]!)),
    highlights: mergeHighlights(selected),
  };
}
