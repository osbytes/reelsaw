/**
 * Small fuzzy matcher for pickers: every character of the query must appear in order in the text
 * ("gpt4m" finds "openai:gpt-4o-mini"), and a score ranks the hits: an exact substring beats a
 * word-start match beats a scattered one, consecutive characters score more, earlier is better.
 * Each whitespace-separated word of the query must match on its own, so "haiku gateway" works.
 * Returns 0 for no match.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  let total = 0;
  for (const word of q.split(/\s+/)) {
    const s = scoreWord(word, t);
    if (!s) return 0;
    total += s;
  }
  return total;
}

function scoreWord(word: string, t: string): number {
  const at = t.indexOf(word);
  if (at >= 0) {
    // exact substring: best, better when it starts a token
    const boundary = at === 0 || /[^a-z0-9]/.test(t[at - 1]!);
    return 1000 + (boundary ? 200 : 0) + word.length * 10 - Math.min(at, 50);
  }
  // subsequence
  let ti = 0;
  let score = 0;
  let run = 0;
  for (let wi = 0; wi < word.length; wi++) {
    const c = word[wi]!;
    const found = t.indexOf(c, ti);
    if (found < 0) return 0;
    const boundary = found === 0 || /[^a-z0-9]/.test(t[found - 1]!);
    run = found === ti ? run + 1 : 0;
    score += 10 + (boundary ? 15 : 0) + run * 8 - Math.min(found - ti, 20);
    ti = found + 1;
  }
  return Math.max(1, score);
}

/** Filter and rank `items` by `fuzzyScore` over the text `key` returns; stable for equal scores. */
export function fuzzyFilter<T>(query: string, items: T[], key: (item: T) => string, limit = 60): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item, i) => ({ item, i, s: fuzzyScore(query, key(item)) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item);
}
