/**
 * The sorts of the user's own lists (Projects, Templates), shared by the screen, tRPC and the MCP tools. Like the
 * Users list (`USER_SORT_KEYS` in accounts.ts), the server orders every match and pages the result by a keyset on
 * (sort value, id); a screen never sorts only the rows it has loaded (PRINCIPLES: "Sorting happens in the database").
 * Omitted = `updated`, newest first.
 */
import type { SortDir } from "./accounts.js";

export const PROJECT_SORT_KEYS = ["updated", "created", "title", "duration"] as const;
export type ProjectSortKey = (typeof PROJECT_SORT_KEYS)[number];
export const isProjectSortKey = (v: unknown): v is ProjectSortKey => PROJECT_SORT_KEYS.some((k) => k === v);

export const TEMPLATE_SORT_KEYS = ["updated", "created", "name"] as const;
export type TemplateSortKey = (typeof TEMPLATE_SORT_KEYS)[number];
export const isTemplateSortKey = (v: unknown): v is TemplateSortKey => TEMPLATE_SORT_KEYS.some((k) => k === v);

/** The direction a list sort takes when first picked: words A to Z, numbers and dates biggest or newest first. */
export const listSortFirstDir = (k: ProjectSortKey | TemplateSortKey): SortDir => (k === "title" || k === "name" ? "asc" : "desc");
