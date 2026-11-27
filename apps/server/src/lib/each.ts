/**
 * The one way a selection bar's action runs over several items: each item through its own existing service
 * (own transaction), one failure never rolls the others back, and the caller gets a per-item result with a reason
 * written for people. When every item failed, the first item's own error is thrown instead, so its code
 * (NOT_FOUND, CONFLICT) and a quota refusal's actions reach the caller unchanged. Used by the Deleted page
 * (`deleted.restore` / `purge`) and the Projects page (`projects.deleteMany` / `retryMany` / `rerenderMany`).
 */
import { TRPCError } from "@trpc/server";
import { msg } from "@lingui/core/runtime-macro";
import { AppError } from "../i18n.js";
import type { Services } from "../services.js";
import { uniqBy } from "lodash-es";

/** Most items one bulk call takes; the selection bars never send more. */
export const BULK_CAP = 200;

export type EachResult<T, R> = { item: T; ok: true; value: R } | { item: T; ok: false; error: string };

/**
 * A per-item reason for the caller. A TRPCError's message is written for people (and a QuotaError carries the
 * upgrade/free-space actions); anything else is an internal failure whose text (SQL, storage paths) stays in the log.
 */
function failMessage(svc: Services, e: unknown, module: string, action: string, item: unknown): string {
  if (e instanceof TRPCError) return e.message;
  svc.log.child({ module }).error({ err: e, item, action }, "bulk item action failed");
  return "Something went wrong. Try again in a moment.";
}

/** First `BULK_CAP` distinct items by `key`, in the order given. */
export function uniqueBy<T>(items: readonly T[], key: (t: T) => string): T[] {
  return uniqBy(items, key).slice(0, BULK_CAP);
}

/**
 * Run `fn` for each item in order. Throws BAD_REQUEST for an empty list, and the first error when nothing succeeded.
 * `module` and `action` label the log line of an unexpected failure.
 */
export async function eachItem<T, R>(
  svc: Services,
  o: { module: string; action: string; empty: string },
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<Array<EachResult<T, R>>> {
  if (!items.length) throw new TRPCError({ code: "BAD_REQUEST", message: o.empty });
  const out: Array<EachResult<T, R>> = [];
  let first: unknown;
  for (const item of items) {
    try {
      out.push({ item, ok: true, value: await fn(item) });
    } catch (e) {
      first ??= e;
      out.push({ item, ok: false, error: failMessage(svc, e, o.module, o.action, item) });
    }
  }
  if (!out.some((r) => r.ok)) {
    if (first instanceof TRPCError) throw first;
    throw new AppError("INTERNAL_SERVER_ERROR", msg({ id: "batch.all_failed", message: "Something went wrong. Try again in a moment." }));
  }
  return out;
}
