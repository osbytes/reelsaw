/**
 * How long a soft delete stays restorable, in the words every delete confirm and toast uses. The
 * numbers come from `deleted.list` (the Deleted page's keepDays / libraryDays / templateDays), so
 * they follow DELETED_RETENTION_DAYS; 0 means kept until deleted forever.
 */
import { useQuery } from "@tanstack/react-query";
import type { DeletedKind } from "@reelsaw/shared";
import { useTRPC } from "./trpc";

/** "You can restore it from Deleted for 7 days." ("at any time" when kept forever; no window while it loads). */
export function restoreHint(days: number | undefined, many = false) {
  const it = many ? "them" : "it";
  if (days === undefined) return `You can restore ${it} from Deleted.`;
  return days > 0 ? `You can restore ${it} from Deleted for ${days} day${days === 1 ? "" : "s"}.` : `You can restore ${it} from Deleted at any time.`;
}

/**
 * The retention window for one kind of delete. Pass `enabled` (e.g. the confirm is open) to avoid
 * fetching the list on pages that never delete. `restorable` is the delete toast's "for N days".
 */
export function useRestoreWindow(kind: DeletedKind, enabled = true) {
  const trpc = useTRPC();
  const q = useQuery({
    ...trpc.deleted.list.queryOptions(),
    enabled,
    staleTime: 5 * 60_000,
    select: (d) => (kind === "asset" ? d.libraryDays : kind === "template" ? d.templateDays : d.keepDays),
  });
  const days = q.data;
  return {
    days,
    hint: (many = false) => restoreHint(days, many),
    restorable: days === undefined ? undefined : days > 0 ? `for ${days} day${days === 1 ? "" : "s"}` : "until you delete it forever",
  };
}
