/**
 * Inputs of the user's own lists (Projects, Templates), shared by tRPC (projects.list, layerTemplates.list) and the MCP
 * catalogue (list_projects, list_layer_templates). Only zod here, like accounts-schema.ts, so `mcp-tools.ts` (also
 * loaded by the stdio bridge) can import it without the services behind it.
 *
 * Every list has the same three controls: `q` filters (every word, literally or close to it), the filters narrow,
 * `sort` / `dir` order every match in SQL. Results page by `cursor`, which names its sort.
 */
import { z } from "zod";
import { LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX } from "./pagination.js";
import { PROJECT_SORT_KEYS, PROJECT_STATUSES, SORT_DIRS, TEMPLATE_SORT_KEYS } from "@reelsaw/shared";

const cursor = z.string().max(300).optional().describe("nextCursor from the previous page (same q, filters and sort); omit for the first page");
const q = (what: string) => z.string().trim().max(200).optional().describe(`Only ${what} with every word (a typo within a word still matches)`);
const dir = z.enum(SORT_DIRS).optional().describe("asc or desc; default: names A to Z, dates and lengths newest or longest first");

export const projectListShape = {
  cursor,
  limit: z.number().int().min(1).max(100).default(24).describe("Projects per page (1-100, default 24)"),
  q: q("projects whose title has"),
  status: z
    .enum([...PROJECT_STATUSES, "processing"])
    .optional()
    .describe("Only projects in this status; processing = any of queued, ingesting, transcribing, refining, analyzing, rendering"),
  deleted: z.boolean().optional().describe("true = only deleted projects that can still be restored"),
  sort: z.enum(PROJECT_SORT_KEYS).optional().describe("Order: updated (default), created, title or duration"),
  dir,
};
export const projectListInput = z.object(projectListShape);

export const templateListShape = {
  cursor,
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIST_LIMIT_MAX)
    .default(LIST_LIMIT_DEFAULT)
    .describe(`Templates per page (1-${LIST_LIMIT_MAX}, default ${LIST_LIMIT_DEFAULT})`),
  q: q("templates whose name has"),
  sort: z.enum(TEMPLATE_SORT_KEYS).optional().describe("Order: updated (default), created or name"),
  dir,
};
export const templateListInput = z.object(templateListShape);
