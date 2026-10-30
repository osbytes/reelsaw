/**
 * Quota refusals the UI, MCP and CLI all read: a sentence plus the actions (upgrade, request more
 * capacity, free space). The server builds this; clients must not invent a different story.
 */

/** Old Projects deep link (`/?deleted=1`); the app redirects it to `DELETED_PATH`. */
export const DELETED_PARAM = "deleted";
/** Restorable deletes and remove-for-good: projects, clips, library items, templates. */
export const DELETED_PATH = "/deleted";
export const DELETED_KINDS = ["project", "clip", "asset", "template"] as const;
export type DeletedKind = (typeof DELETED_KINDS)[number];
export const deletedProjectsPath = () => DELETED_PATH;
/** Deep link to one row on Deleted (`#clip=<id>` and the other kinds). */
export const deletedItemPath = (kind: DeletedKind, id: string) => `${DELETED_PATH}#${kind}=${encodeURIComponent(id)}`;

export type QuotaAction =
  | { kind: "upgrade"; label: string; href: string }
  | { kind: "request"; label: string }
  | { kind: "free_space"; label: string; href: string };

export interface QuotaRefusal {
  key: string;
  /** Upgrade when a next plan exists; request more capacity on the top plan; free space for storage. */
  primary?: QuotaAction | undefined;
  secondary?: QuotaAction | undefined;
}

export function formatBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${Math.max(1, Math.round(n / 1_048_576))} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
