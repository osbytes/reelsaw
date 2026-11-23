/**
 * How long a soft delete stays restorable, in the words every delete confirm and toast uses. The
 * numbers come from `deleted.list` (the Deleted page's keepDays / libraryDays / templateDays), so
 * they follow DELETED_RETENTION_DAYS; 0 means kept until deleted forever.
 */
import { useQuery } from "@tanstack/react-query";
import type { DeletedKind } from "@reelsaw/shared";
import { useTRPC } from "./trpc";
import { plural, t } from "@lingui/core/macro";

/** "You can restore it from Deleted for 7 days." ("at any time" when kept forever; no window while it loads). */
export function restoreHint(days: number | undefined, many = false) {
  if (days === undefined) return many ? t`You can restore them from Deleted.` : t`You can restore it from Deleted.`;
  if (days <= 0) return many ? t`You can restore them from Deleted at any time.` : t`You can restore it from Deleted at any time.`;
  return many
    ? plural(days, { one: "You can restore them from Deleted for # day.", other: "You can restore them from Deleted for # days." })
    : plural(days, { one: "You can restore it from Deleted for # day.", other: "You can restore it from Deleted for # days." });
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
    restorable: days === undefined ? undefined : days > 0 ? plural(days, { one: "for # day", other: "for # days" }) : t`until you delete it forever`,
  };
}
