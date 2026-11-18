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

describe("paged lists sort on the server", () => {
  it("no component that pages with useInfiniteQuery sorts rows in the browser", () => {
    const offenders = sources(web).filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      return /\buseInfiniteQuery\b|\binfiniteQueryOptions\b/.test(src) && /\.(sort|toSorted)\(/.test(src);
    });
    assert.deepEqual(
      offenders.map((f) => path.relative(web, f)),
      [],
      "pass the sort to the server query (sort/dir input, keyset by sort value) instead of sorting the loaded rows",
    );
  });
});
