/** Keyset pagination helpers: opaque cursors and LIKE escaping. Pure, no database. */
import { z } from "zod";
import { TRPCError } from "@trpc/server";

/** Opaque cursor: the sort-key tuple of the last row on a page, as base64url JSON. */
export function encodeCursor(parts: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

/** The tuple back, or null when the cursor is not one this module made (tampered, truncated, wrong arity). */
export function decodeCursor(cursor: string, arity: number): (string | number)[] | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length !== arity) return null;
    return v.every((x) => typeof x === "string" || (typeof x === "number" && Number.isFinite(x))) ? (v as (string | number)[]) : null;
  } catch {
    return null;
  }
}

/** Lists that used to return everything (library, layer templates): a page is 100 rows unless asked for more, at most 500. */
export const LIST_LIMIT_DEFAULT = 100;
export const LIST_LIMIT_MAX = 500;
/** The `{ limit, cursor }` input of those lists; omitted = the first page of the default size. */
export const listPageInput = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIST_LIMIT_MAX)
      .default(LIST_LIMIT_DEFAULT)
      .describe(`Items per page (1-${LIST_LIMIT_MAX}, default ${LIST_LIMIT_DEFAULT})`),
    cursor: z.string().max(300).optional().describe("nextCursor from the previous page; omit for the first page"),
  })
  .optional();

/** The tuple of a page cursor, or a plain BAD_REQUEST when it is not one this server made. */
export function pageCursor(cursor: string | undefined, arity: number): (string | number)[] | null {
  if (!cursor) return null;
  const c = decodeCursor(cursor, arity);
  if (!c) throw new TRPCError({ code: "BAD_REQUEST", message: "That page link is not valid. Start again from the first page." });
  return c;
}

/** Escape LIKE wildcards so user text matches literally (use with `escape '\'`). */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => "\\" + c);
}

/** Trim a fetched page of `limit + 1` rows to `limit` and say where the next page starts. */
export function pageOf<T>(rows: T[], limit: number, key: (last: T) => readonly (string | number)[]): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: encodeCursor(key(items[items.length - 1]!)) };
}
