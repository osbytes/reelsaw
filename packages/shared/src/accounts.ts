/**
 * Sentences for sign-up and sign-in. The waiting page, the sign-up form and the sign-in refusal
 * all use these, so a pending account does not hear a different story on each step.
 */

/** The waiting page (`Pending.tsx`) and every refusal that means the same thing. */
export const PENDING_APPROVAL_MESSAGE = "Your account is waiting for an admin to approve it.";

/** Shown when a sign-up created the account but did not start a session (email confirmation is required). */
export const CONFIRM_EMAIL_THEN_SIGN_IN = "Confirm the link we sent to your email, then sign in.";

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
