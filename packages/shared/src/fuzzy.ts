/**
 * One fuzzy search for the whole app (Fuse.js), on both sides of the wire: the command palette and
 * any list the browser already holds, and the server's searches over listings that are not in the
 * database (the model catalog). `createFuzzy` builds an index once; `search` handles both shapes of
 * query, the whole string as one pattern ("chia jm") and words that each match somewhere, typos and
 * all ("revnge sucess"), and returns the best score per item.
 */
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
