/**
 * Inputs of the admin's account list and bulk actions, shared by tRPC (admin.users.list / bulk), the MCP
 * catalogue (list_users, manage_users) and the CLI. Only zod here, so `mcp-tools.ts` (also loaded by the
 * stdio bridge) can import it without the services behind it.
 */
import { z } from "zod";

export const USER_STATUSES = ["pending", "active", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Which accounts: the Users page's search and filters. Every field narrows; none = every account. */
export const userFilterSchema = z.object({
  q: z.string().max(200).optional().describe("Name or email words, typo-tolerant (every word must match)"),
  flagged: z.boolean().optional().describe("Only accounts the hourly abuse pass flagged"),
  status: z.enum(USER_STATUSES).optional().describe("pending = waiting for approval, active, suspended"),
  verified: z.boolean().optional().describe("true = email address confirmed, false = not confirmed yet"),
});
export type UserFilter = z.infer<typeof userFilterSchema>;

export const userListInput = userFilterSchema.extend({
  cursor: z.string().max(300).optional().describe("nextCursor from the previous page (ignored with q: a search returns its best 100 in one page)"),
  limit: z.number().int().min(1).max(100).default(50).describe("Page size (1-100, default 50)"),
});

/** What a bulk action does to each account; each one is the single-account transition in accounts.ts. */
export const BULK_USER_ACTIONS = ["approve", "suspend", "reinstate", "delete"] as const;
export type BulkUserAction = (typeof BULK_USER_ACTIONS)[number];
/** Accounts per call: each is its own unit of work (a delete purges every project), so a call stays short. */
export const BULK_USERS = 50;

export const bulkUsersShape = {
  action: z
    .enum(BULK_USER_ACTIONS)
    .describe(
      "approve a waiting account; suspend (signs them out now, keeps their projects); reinstate a suspended one; delete the account and everything it owns, forever",
    ),
  ids: z
    .array(z.string().min(1).max(80))
    .min(1)
    .max(BULK_USERS)
    .optional()
    .describe(`These account ids (up to ${BULK_USERS}); omit to act on every match of filter`),
  filter: userFilterSchema.optional().describe("Every account matching these (the same filter as list_users); used when ids is omitted"),
  cursor: z.string().max(80).optional().describe("nextCursor of the previous call with the same filter"),
  reason: z.string().max(300).optional().describe("suspend only: the reason shown to them"),
};
export const bulkUsersInput = z.object(bulkUsersShape).refine((v) => !!v.ids !== !!v.filter, { message: "Pass ids or filter, not both" });
export type BulkUsersInput = z.infer<typeof bulkUsersInput>;
