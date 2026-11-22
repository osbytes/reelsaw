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
/** A project's page in the app (`/p/<id>`); links built by hand drifted to a route that does not exist. */
export const projectPath = (id: string) => `/p/${encodeURIComponent(id)}`;
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
  /**
   * The refusal without the offer the error message ends with ("Starter gives …: <link>", for MCP and the CLI, which
   * have no buttons). A screen that shows `primary` as a button shows this instead of the message.
   */
  sentence?: string | undefined;
}

/**
 * An account's queue priority: points added to each of its jobs' fair-share priority (the server's `fairPriority`,
 * minus the owner's live jobs), so one point is worth one job of backlog. The plan grants it (hosted), an admin
 * may override it per account, negative to hold an account back. The bounds keep an override from starving
 * everyone else outright.
 */
export const QUEUE_PRIORITY_MIN = -20;
export const QUEUE_PRIORITY_MAX = 20;

/**
 * Bounds of an account's resource ceiling (hosted plans; docs/specs/resource-leases.md slice 3): the most cores and
 * MB of memory its leases may hold at once. The plan grants it, an admin may override it per account.
 */
export const RESOURCE_CEILING_MAX_CORES = 512;
export const RESOURCE_CEILING_MAX_MEM_MB = 4_194_304;
