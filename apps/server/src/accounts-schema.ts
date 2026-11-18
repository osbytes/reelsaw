/**
 * Inputs of the admin's account list and bulk actions, shared by tRPC (admin.users.list / bulk), the MCP
 * catalogue (list_users, manage_users) and the CLI. Only zod here, so `mcp-tools.ts` (also loaded by the
 * stdio bridge) can import it without the services behind it.
 */
import { z } from "zod";
import { ABUSE_FLAGS, FLAG_GROUPS, MAX_IP_GROUPS, SORT_DIRS, USER_GROUP_BY, USER_SORT_KEYS } from "@reelsaw/shared";

export const USER_STATUSES = ["pending", "active", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Which accounts: the Users page's search and filters. Every field narrows; none = every account. */
export const userFilterSchema = z.object({
  q: z.string().max(200).optional().describe("Name or email words, typo-tolerant (every word must match)"),
  flagged: z.boolean().optional().describe("Only accounts the hourly abuse pass flagged, for any reason"),
  flag: z
    .enum(ABUSE_FLAGS)
    .optional()
    .describe(
      "Only accounts flagged for this reason: shared_ip (3+ sign-ups from one address in 7 days), signup_burst (5+ in an hour), disposable_email (temporary-address domain)",
    ),
  status: z.enum(USER_STATUSES).optional().describe("pending = waiting for approval, active, suspended"),
  verified: z.boolean().optional().describe("true = email address confirmed, false = not confirmed yet"),
  heldBy: z
    .string()
    .max(240)
    .optional()
    .describe(
      'Only accounts a sign-up rule held for approval, by the rule as list_signup_rules shows it (kind and pattern: "ip 203.0.113.0/24"), whatever their status now',
    ),
  signupIp: z.string().min(1).max(64).optional().describe("Only accounts that signed up from exactly this address (203.0.113.7)"),
  sharedIp: z
    .boolean()
    .optional()
    .describe(
      "true = another account signed up from the same address; false = the only account from its address, or no address recorded (the rest section of groupBy ip)",
    ),
  group: z
    .object({
      by: z
        .literal("flag")
        .describe("flag: the sections of list_users groupBy flag (an address section of groupBy ip filters with signupIp or sharedIp instead)"),
      key: z.enum(FLAG_GROUPS).describe("The section: an abuse flag, or none for the accounts with no flag"),
    })
    .optional()
    .describe(
      "Only the accounts in one section of list_users groupBy, on top of the other fields: by flag, key = shared_ip, signup_burst, disposable_email or none (not flagged). Each group list_users returns carries its own filter with this set",
    ),
});
export type UserFilter = z.infer<typeof userFilterSchema>;

/** The order of the list, applied by the server to every match before paging (never to one loaded page). */
export const userSortShape = {
  sort: z
    .enum(USER_SORT_KEYS)
    .optional()
    .describe(
      "Order every matching account by: name (name, else email), status, projects, sourceMinutes, clipsRendered, storedBytes (all time), lastActive, created. Omitted = pending first, then newest (a search: best match first)",
    ),
  dir: z.enum(SORT_DIRS).optional().describe("asc or desc; default asc for name and status, desc for the rest. Only with sort"),
};

export const userListInput = userFilterSchema.extend({
  ...userSortShape,
  cursor: z
    .string()
    .max(300)
    .optional()
    .describe("nextCursor from the previous page, with the same filter and sort (ignored with q and no sort: a search returns its best 100 in one page)"),
  limit: z.number().int().min(1).max(100).default(50).describe("Page size (1-100, default 50)"),
});

/**
 * The filtered list split into sections (accounts-list.ts `userGroups`): each with its count and the filter that
 * pages or acts on it. `limit` 0 = counts only (the Users page loads each open section itself).
 */
export const userGroupsInput = userFilterSchema.extend({
  ...userSortShape,
  by: z
    .enum(USER_GROUP_BY)
    .describe(
      `flag = one section per abuse reason (shared_ip, signup_burst, disposable_email), then none (not flagged); ip = one section per sign-up address more than one account shares, most accounts first (up to ${MAX_IP_GROUPS}), then rest`,
    ),
  limit: z.number().int().min(0).max(100).default(20).describe("Accounts listed per section (0-100, default 20; 0 = counts only)"),
});

/** list_users over MCP: the list, or with groupBy the same list in sections (one tool, one filter). */
export const userListToolInput = userListInput.extend({
  groupBy: z
    .enum(USER_GROUP_BY)
    .optional()
    .describe(
      `Split the matching accounts into sections instead of one page: flag = one per abuse reason, then none (not flagged), and an account with two flags is in both; ip = one per sign-up address shared by more than one account (key = the address, most accounts first, up to ${MAX_IP_GROUPS}; moreSections says how many were left out), then rest. Combine ip with flag shared_ip to see which accounts share which address. Returns { by, total, moreSections, groups: [{ key, label, help, total, filter, items, nextCursor }] }: limit accounts per section; pass a section's filter fields to list_users with its nextCursor for more, or its filter to manage_users to act on that section`,
    ),
});

/** What a bulk action does to each account; each one is the single-account transition in accounts.ts. */
export const BULK_USER_ACTIONS = ["approve", "hold", "suspend", "reinstate", "delete"] as const;
export type BulkUserAction = (typeof BULK_USER_ACTIONS)[number];
/** Accounts per call: each is its own unit of work (a delete purges every project), so a call stays short. */
export const BULK_USERS = 50;

export const bulkUsersShape = {
  action: z
    .enum(BULK_USER_ACTIONS)
    .describe(
      "approve a waiting account; hold = send an active account back to waiting for approval (it is not told why; approve undoes it); suspend (signs them out now, keeps their projects); reinstate a suspended one; delete the account and everything it owns, forever",
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
