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

/** Where the reset-password email sends the browser (`redirectTo`); Better Auth adds `?token=` or `?error=INVALID_TOKEN`. */
export const RESET_PASSWORD_CALLBACK_PATH = "/reset-password";

/** Better Auth puts this on redirectTo when the reset token is expired or already used. */
export const RESET_PASSWORD_ERROR_CODES = ["INVALID_TOKEN", "TOKEN_EXPIRED"] as const;

/** After /request-password-reset. Same sentence whether the address exists, so we do not leak accounts. */
export const RESET_PASSWORD_SENT_NOTICE = "If this address has an account, we sent a reset link. It works for 24 hours.";

/** Expired or already-used reset link: the recovery page, not an error. */
export const RESET_PASSWORD_EXPIRED_NOTICE = "This reset link has expired. Send a new one and we will email it. It works for 24 hours.";

/** After a successful reset. Other sessions are revoked (`revokeSessionsOnPasswordReset`). */
export const RESET_PASSWORD_DONE_NOTICE = "Your password is changed. Sign in with the new one; other devices are signed out.";

/** Sign-in and the reset page when this instance has no email driver. */
export const RESET_PASSWORD_UNAVAILABLE = "Password reset needs email on this instance. Ask an admin, or sign in if you still know the password.";

/** Same bounds Better Auth uses for email/password (`minPasswordLength` / `maxPasswordLength`). */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export function passwordLengthError(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return "Use at least 8 characters.";
  if (password.length > PASSWORD_MAX_LENGTH) return "Use at most 128 characters.";
  return null;
}

/**
 * Browser session while `user.mustChangePassword` is set: the only page they see, and the sentence
 * every other route answers with. API keys still work (an agent should not be locked out with the person).
 */
export const MUST_CHANGE_PASSWORD_MESSAGE = "Choose a new password before using this account.";

/** Body copy on that page: why there is no current-password field. */
export const MUST_CHANGE_PASSWORD_COPY = "An operator set a temporary password. Choose yours to continue; you will not need the temporary one after this.";

/** Completing must-change with the same secret the operator (or they) just set. */
export const MUST_CHANGE_PASSWORD_REUSE = "Choose a different password from the temporary one.";

export function resetLinkFailed(code: string | null | undefined): boolean {
  return !!code && (RESET_PASSWORD_ERROR_CODES as readonly string[]).includes(code.toUpperCase());
}

/** `/reset-password`, with the address from the sign-in form when it looks like an email. */
export function resetPasswordPath(email?: string): string {
  const e = (email ?? "").trim().toLowerCase();
  return looksLikeEmail(e) ? `${RESET_PASSWORD_CALLBACK_PATH}?email=${encodeURIComponent(e)}` : RESET_PASSWORD_CALLBACK_PATH;
}

/** Query string from the reset email redirect (`/reset-password?token=` or `?error=INVALID_TOKEN`). */
export function resetPasswordFromSearch(search: string): { expired: boolean; token: string | null; email: string | null } {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const expired = resetLinkFailed(q.get("error"));
  const rawToken = (q.get("token") ?? "").trim();
  const token = !expired && rawToken.length > 0 && !rawToken.includes(" ") ? rawToken : null;
  const raw = (q.get("email") ?? "").trim().toLowerCase();
  return { expired, token, email: looksLikeEmail(raw) ? raw : null };
}

/** Sign-in codes that mean the password matched but the mailbox is not confirmed yet. */
export const UNVERIFIED_SIGN_IN_CODES = ["EMAIL_NOT_VERIFIED", "ACCOUNT_PENDING"] as const;

export function verifyLinkFailed(code: string | null | undefined): boolean {
  return !!code && (VERIFY_EMAIL_ERROR_CODES as readonly string[]).includes(code);
}

export function shouldOfferResendVerification(opts: { errorCode: string | null; expiredLink: boolean; afterSignUp: boolean }): boolean {
  if (opts.expiredLink || opts.afterSignUp) return true;
  return !!opts.errorCode && (UNVERIFIED_SIGN_IN_CODES as readonly string[]).includes(opts.errorCode);
}

/** Prefill-only: one `@`, a dot in the domain, no spaces. Linear so a long query string cannot stall the login page. */
export function looksLikeEmail(s: string): boolean {
  if (s.length < 3 || s.length > 254) return false;
  const at = s.indexOf("@");
  if (at < 1 || at !== s.lastIndexOf("@")) return false;
  if (s.includes(" ")) return false;
  const domain = s.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1;
}

/** Query string from an expired confirmation redirect (`/login?error=TOKEN_EXPIRED&email=`). */
export function verifyEmailErrorFromSearch(search: string): { expired: boolean; email: string | null } {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const expired = verifyLinkFailed(q.get("error"));
  const raw = (q.get("email") ?? "").trim().toLowerCase();
  return { expired, email: looksLikeEmail(raw) ? raw : null };
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
