/**
 * The app's one fuzzy search (Fuse.js) lives in @reelsaw/shared, so the server searches listings it
 * holds (the model catalog) the same way the command palette filters what the browser holds. This
 * module adds the browser part: `Highlight` bolds the matched characters of one key in a result.
 */
import type { ReactNode } from "react";
import type { FuseResultMatch } from "@reelsaw/shared";

export { createFuzzy, type Fuzzy, type FuseResult, type FuseResultMatch } from "@reelsaw/shared";

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
