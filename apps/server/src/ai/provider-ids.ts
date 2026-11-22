/**
 * Model-id prefixes that borrow another provider's credentials. One OpenCode Console key serves
 * both plans: pay-per-token Zen (`opencode:`) and the Go subscription (`opencode-go:`). The prefix
 * records which plan pays; the key is stored once, under the owner. Every credential lookup goes
 * through `credentialOwner`, so no layer can look an alias up on its own.
 *
 * Kept free of imports: the registry, the catalog and provider settings all read it.
 */
const CREDENTIAL_ALIASES: Record<string, string> = { "opencode-go": "opencode" };

/** The provider whose stored or env credentials `provider` uses: itself, unless it is an alias. */
export function credentialOwner(provider: string): string {
  return CREDENTIAL_ALIASES[provider] ?? provider;
}

/** Prefixes that use `owner`'s credentials, besides `owner` itself. */
export function aliasesOf(owner: string): string[] {
  return Object.keys(CREDENTIAL_ALIASES).filter((a) => CREDENTIAL_ALIASES[a] === owner);
}

/** OpenCode's inference root (OPENCODE_BASE_URL's default): chat and model-list paths per plan are OPENCODE_PLANS (ai/opencode.ts). */
export const OPENCODE_DEFAULT_BASE_URL = "https://opencode.ai/inference";
