/**
 * Inputs of the sign-up rules (signup-rules.ts), shared by tRPC (admin.signupRules.*), the MCP catalogue
 * (list_signup_rules, manage_signup_rules) and the CLI. Only zod here, so `mcp-tools.ts` (also loaded by the
 * stdio bridge) can import it without the services behind it.
 */
import { z } from "zod";

/** What a rule looks at: the sign-up address, its email (glob), its email domain, or an abuse flag worked out at sign-up. */
export const SIGNUP_RULE_KINDS = ["ip", "email", "domain", "flag"] as const;
export type SignupRuleKind = (typeof SIGNUP_RULE_KINDS)[number];

/**
 * What a match does. hold: the account waits for approval (it sees the usual "waiting for approval" page, never
 * why); block: the sign-up is refused; allow: approved at once, even with SIGNUP_MODE=approval. When several
 * match, block wins, then allow, then hold.
 */
export const SIGNUP_RULE_ACTIONS = ["hold", "block", "allow"] as const;
export type SignupRuleAction = (typeof SIGNUP_RULE_ACTIONS)[number];

/** Rules an instance may keep: every sign-up reads them all, so the list stays small. */
export const MAX_SIGNUP_RULES = 500;

export const signupRuleInput = z.object({
  kind: z
    .enum(SIGNUP_RULE_KINDS)
    .describe(
      "ip = an address or CIDR range (203.0.113.7, 203.0.113.0/24, 2001:db8::/32); email = an address, * matches any run of characters (spam*@gmail.com); domain = an email domain and its subdomains (example.com); flag = shared_ip, signup_burst or disposable_email, worked out at sign-up",
    ),
  pattern: z.string().trim().min(1).max(200).describe("What to match, in the form the kind expects"),
  action: z.enum(SIGNUP_RULE_ACTIONS).describe("hold = needs approval (the account is not told why); block = sign-up refused; allow = approved at once"),
  note: z.string().trim().max(300).optional().describe("Why the rule exists, for the other admins"),
});
export type SignupRuleInput = z.infer<typeof signupRuleInput>;

export const manageSignupRulesShape = {
  add: z.array(signupRuleInput).max(50).optional().describe("Rules to add (up to 50 per call)"),
  remove: z.array(z.string().min(1).max(80)).max(50).optional().describe("Ids of rules to remove (from list_signup_rules)"),
};
export const manageSignupRulesInput = z
  .object(manageSignupRulesShape)
  .refine((v) => (v.add?.length ?? 0) + (v.remove?.length ?? 0) > 0, { message: "Pass rules to add or ids to remove" });
export type ManageSignupRulesInput = z.infer<typeof manageSignupRulesInput>;

export const testSignupShape = {
  email: z.string().trim().min(3).max(320).describe("The email address a sign-up would use"),
  ip: z.string().trim().max(64).optional().describe("The address it would come from; omitted = unknown (ip rules and address flags do not match)"),
};
export const testSignupInput = z.object(testSignupShape);

export const listSignupRulesShape = {
  test: testSignupInput.optional().describe("Also say what the rules would do to a sign-up with this email (and address), without signing anyone up"),
};
export const listSignupRulesInput = z.object(listSignupRulesShape);
export type ListSignupRulesInput = z.infer<typeof listSignupRulesInput>;
