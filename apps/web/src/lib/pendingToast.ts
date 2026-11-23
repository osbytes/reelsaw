import { toast } from "sonner";
import { t } from "@lingui/core/macro";

/**
 * Work started from something that closes at once (a ⋯ menu item, a command palette row) has nowhere of its own to
 * show that it runs, so it gets a loading toast right away that becomes the result (or the failure) in place:
 * "Work in flight shows" (docs/PRINCIPLES.md). Work started from a dialog or a selection bar shows there instead
 * (ConfirmDialog's spinner, SelectionBar's `busy`). Resolves to the result, or undefined after a failure (already shown).
 */
export async function pendingToast<T>(
  loading: string,
  work: Promise<T> | (() => Promise<T>),
  done: string | ((r: T) => string),
  failed: string,
): Promise<T | undefined> {
  const id = toast.loading(loading);
  try {
    const r = await (typeof work === "function" ? work() : work);
    toast(typeof done === "function" ? done(r) : done, { id });
    return r;
  } catch (e) {
    const why = (e instanceof Error ? e.message : t`something went wrong`).slice(0, 120);
    toast.error(t`${failed}: ${why}`, { id });
    return undefined;
  }
}
