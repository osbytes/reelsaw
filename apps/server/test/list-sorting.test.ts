/**
 * PRINCIPLES "Sorting happens in the database": a screen that pages a list from the server never sorts the rows it
 * has loaded, since that orders one page and passes it off as the whole list. The sort goes into the query instead
 * (the Users page: `sort`/`dir` on admin.users.list). Stack-free: reads the web sources.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/src");
const sources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });

/** A file that pages a list from the server, or renders sortable list headers. */
const paged = (src: string) =>
  /\buseInfiniteQuery\b|\binfiniteQueryOptions\b|\bnextCursor\b|\bgetNextPageParam\b/.test(src) || (/\bListColumn\b/.test(src) && /\bsort:\s*\w/.test(src));
/**
 * Reordering rows in the browser: Array sort, toSorted, or a sortBy/orderBy helper. A line that orders something
 * other than the list's rows (a handful of tag names) says so with a `sort-ok: <why>` comment and is skipped.
 */
const sortsLocally = (src: string) => src.split("\n").some((l) => /\.(sort|toSorted)\(|\b(sortBy|orderBy)\(/.test(l) && !l.includes("sort-ok:"));

describe("paged lists sort on the server", () => {
  it("no component that pages a list or has sortable headers sorts rows in the browser", () => {
    const offenders = sources(web).filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      return paged(src) && sortsLocally(src);
    });
    assert.deepEqual(
      offenders.map((f) => path.relative(web, f)),
      [],
      "pass the sort to the server query (sort/dir input, keyset by sort value) instead of sorting the loaded rows",
    );
  });

  it("catches the shapes it is meant to", () => {
    assert.ok(paged("const q = useInfiniteQuery(o)") && sortsLocally("[...rows].sort((a, b) => a.n - b.n)"));
    assert.ok(paged("const cols: ListColumn[] = [{ label: 'A', sort: sortable('a') }]") && sortsLocally("rows.toSorted(cmp)"));
    assert.ok(paged("getNextPageParam: (l) => l.nextCursor") && sortsLocally("sortBy(rows, 'n')"));
    assert.ok(!paged("const clips = useQuery(o); clips.sort()"));
  });
});
