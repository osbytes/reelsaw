/**
 * One fuzzy search for the whole app (Fuse.js): the command palette, the model picker and anything
 * else that filters a list as the user types. `createFuzzy` builds an index once; `search` handles
 * both shapes of query, the whole string as one pattern ("chia jm") and words that each match
 * somewhere, typos and all ("revnge sucess"), and returns the best score per item. `Highlight`
 * bolds the matched characters of one key in a result.
 */
import type { ReactNode } from "react";
import Fuse, { type FuseResult, type FuseResultMatch, type IFuseOptions } from "fuse.js";

export type { FuseResult, FuseResultMatch };

export interface Fuzzy<T> {
  search(q: string, limit?: number): FuseResult<T>[];
  /** items in rank order, or all of them (in input order) for an empty query */
  filter(q: string, limit?: number): T[];
}

export function createFuzzy<T>(items: T[], keys: Array<string | { name: string; weight: number }>, options: Partial<IFuseOptions<T>> = {}): Fuzzy<T> {
  const base: IFuseOptions<T> = { keys, includeMatches: true, includeScore: true, ignoreLocation: true, threshold: 0.38, minMatchCharLength: 2, ...options };
  const whole = new Fuse(items, base);
  const words = new Fuse(items, { ...base, useExtendedSearch: true });
  const search = (q: string, limit?: number) => {
    const best = new Map<T, FuseResult<T>>();
    const add = (rs: FuseResult<T>[]) => {
      for (const r of rs) {
        const prev = best.get(r.item);
        if (!prev || (r.score ?? 1) < (prev.score ?? 1)) best.set(r.item, r);
      }
    };
    add(whole.search(q));
    if (/\s/.test(q.trim())) add(words.search(q.trim().replace(/[!'=^$|]/g, " ")));
    const out = [...best.values()].sort((a, b) => (a.score ?? 1) - (b.score ?? 1));
    return limit ? out.slice(0, limit) : out;
  };
  return {
    search,
    filter: (q, limit) => (q.trim() ? search(q, limit).map((r) => r.item) : limit ? items.slice(0, limit) : items),
  };
}

/** Bold the characters Fuse matched in one key of a result. */
export function Highlight({ text, matches, k }: { text: string; matches?: readonly FuseResultMatch[] | undefined; k: string }) {
  const m = matches?.find((x) => x.key === k && x.value === text);
  if (!m?.indices.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  // ignore single-letter scatter; keep runs of 2+ so highlights read as words
  for (const [a, b] of m.indices.filter(([a, b]) => b - a >= 1)) {
    if (a > at) parts.push(text.slice(at, a));
    parts.push(
      <mark key={a} className="rounded-[3px] bg-acc-soft text-acc-text">
        {text.slice(a, b + 1)}
      </mark>,
    );
    at = b + 1;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}
