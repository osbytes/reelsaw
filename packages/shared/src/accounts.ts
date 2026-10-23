/**
 * Sentences for sign-up and sign-in. The waiting page, the sign-up form and the sign-in refusal
 * all use these, so a pending account does not hear a different story on each step.
 */

/** The waiting page (`Pending.tsx`) and every refusal that means the same thing. */
export const PENDING_APPROVAL_MESSAGE = "Your account is waiting for an admin to approve it.";

/** Shown when a sign-up created the account but did not start a session (email confirmation is required). */
export const CONFIRM_EMAIL_THEN_SIGN_IN = "Confirm the link we sent to your email, then sign in.";

/** Where a confirmation link sends the browser after Better Auth accepts or refuses the JWT. */
export const VERIFY_EMAIL_CALLBACK_PATH = "/login";

/** Better Auth puts this on callbackURL when the confirmation JWT is expired or invalid. */
export const VERIFY_EMAIL_ERROR_CODES = ["TOKEN_EXPIRED", "INVALID_TOKEN", "USER_NOT_FOUND"] as const;

/** Expired or superseded confirmation link: the recovery page, not an error. */
export const VERIFY_EMAIL_EXPIRED_NOTICE = "This confirmation link has expired. Send a new one and we will email it. It works for 24 hours.";

/** After /send-verification-email. Same sentence whether the address exists, so we do not leak accounts. */
export const VERIFY_EMAIL_SENT_NOTICE = "If this address still needs confirming, we sent a new link. It works for 24 hours.";

/** Sign-in codes that mean the password matched but the mailbox is not confirmed yet. */
export const UNVERIFIED_SIGN_IN_CODES = ["EMAIL_NOT_VERIFIED", "ACCOUNT_PENDING"] as const;

export function verifyLinkFailed(code: string | null | undefined): boolean {
  return !!code && (VERIFY_EMAIL_ERROR_CODES as readonly string[]).includes(code);
}

export function shouldOfferResendVerification(opts: { errorCode: string | null; expiredLink: boolean; afterSignUp: boolean }): boolean {
  if (opts.expiredLink || opts.afterSignUp) return true;
  return !!opts.errorCode && (UNVERIFIED_SIGN_IN_CODES as readonly string[]).includes(opts.errorCode);
}

/** Query string from an expired confirmation redirect (`/login?error=TOKEN_EXPIRED&email=`). */
export function verifyEmailErrorFromSearch(search: string): { expired: boolean; email: string | null } {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const expired = verifyLinkFailed(q.get("error"));
  const raw = (q.get("email") ?? "").trim().toLowerCase();
  const email = raw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
  return { expired, email };
}

/**
 * A later sign-up does not write a new password, and a sign-in that a password manager filled with
 * a newly generated one is a different password. The first sign-up is the one on the account.
 */
export const REPEAT_SIGN_UP_KEEPS_FIRST_PASSWORD = "The password from your first sign-up is the one on the account. Sign in with that, or reset it.";

/** Same sentence as the mailbox-key guard (`abuse.ts`). */
export const ACCOUNT_EXISTS_MESSAGE = "An account already exists for this email address. Sign in, or reset your password.";

export type AccountBlock = { kind: "pending" | "banned"; reason: string } | null;

/** Someone submitted sign-up for an email that already has an account. Nothing was changed. */
export function repeatSignUpMessage(blocked: AccountBlock): string {
  if (blocked?.kind === "pending") return `${blocked.reason} ${REPEAT_SIGN_UP_KEEPS_FIRST_PASSWORD}`;
  if (blocked) return blocked.reason;
  return ACCOUNT_EXISTS_MESSAGE;
}

/**
 * Sign-in password was correct, and Better Auth refused because the email is not confirmed yet.
 * Pending and suspended accounts hear their own sentence. An approved account keeps "Email not verified".
 */
export function unverifiedSignInMessage(blocked: AccountBlock): string | null {
  if (!blocked) return null;
  if (blocked.kind === "pending") return `${blocked.reason} ${CONFIRM_EMAIL_THEN_SIGN_IN}`;
  return blocked.reason;
}

/** First sign-up succeeded and there is no session yet. Not an error: the account exists. */
export function signupCreatedNotice(mode: "open" | "approval" | "closed"): string {
  const rest = `${CONFIRM_EMAIL_THEN_SIGN_IN} ${REPEAT_SIGN_UP_KEEPS_FIRST_PASSWORD}`;
  return mode === "approval" ? `${PENDING_APPROVAL_MESSAGE} ${rest}` : rest;
}
