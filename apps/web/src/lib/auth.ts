import { createAuthClient } from "better-auth/react";
import { apiKeyClient } from "@better-auth/api-key/client";
import { t } from "@lingui/core/macro";
import {
  CONFIRM_EMAIL_THEN_SIGN_IN,
  MUST_CHANGE_PASSWORD_COPY,
  MUST_CHANGE_PASSWORD_MESSAGE,
  MUST_CHANGE_PASSWORD_REUSE,
  PENDING_APPROVAL_MESSAGE,
  REPEAT_SIGN_UP_KEEPS_FIRST_PASSWORD,
  RESET_PASSWORD_DONE_NOTICE,
  RESET_PASSWORD_EXPIRED_NOTICE,
  RESET_PASSWORD_SENT_NOTICE,
  RESET_PASSWORD_UNAVAILABLE,
  VERIFY_EMAIL_EXPIRED_NOTICE,
  VERIFY_EMAIL_SENT_NOTICE,
} from "@reelsaw/shared";

export const authClient = createAuthClient({ baseURL: window.location.origin, plugins: [apiKeyClient()] });
export const { useSession, signIn, signUp, signOut, sendVerificationEmail, requestPasswordReset, resetPassword } = authClient;

/**
 * The sign-in and reset sentences @reelsaw/shared keeps in English (one story for the server and the app), in the
 * active locale. A notice built from several of them (`signupCreatedNotice`) is translated sentence by sentence;
 * text that is none of them (a server message, already in the requester's locale) comes back as it is.
 */
export function accountNotice(text: string): string;
export function accountNotice(text: string | null): string | null;
export function accountNotice(text: string | null): string | null {
  if (!text) return text;
  const known: Array<[string, () => string]> = [
    [PENDING_APPROVAL_MESSAGE, () => t`Your account is waiting for an admin to approve it.`],
    [CONFIRM_EMAIL_THEN_SIGN_IN, () => t`Confirm the link we sent to your email, then sign in.`],
    [REPEAT_SIGN_UP_KEEPS_FIRST_PASSWORD, () => t`The password from your first sign-up is the one on the account. Sign in with that, or reset it.`],
    [VERIFY_EMAIL_EXPIRED_NOTICE, () => t`This confirmation link has expired. Send a new one and we will email it. It works for 24 hours.`],
    [VERIFY_EMAIL_SENT_NOTICE, () => t`If this address still needs confirming, we sent a new link. It works for 24 hours.`],
    [RESET_PASSWORD_SENT_NOTICE, () => t`If this address has an account, we sent a reset link. It works for 24 hours.`],
    [RESET_PASSWORD_EXPIRED_NOTICE, () => t`This reset link has expired. Send a new one and we will email it. It works for 24 hours.`],
    [RESET_PASSWORD_DONE_NOTICE, () => t`Your password is changed. Sign in with the new one; other devices are signed out.`],
    [RESET_PASSWORD_UNAVAILABLE, () => t`Password reset needs email on this instance. Ask an admin, or sign in if you still know the password.`],
    [MUST_CHANGE_PASSWORD_MESSAGE, () => t`Choose a new password before using this account.`],
    [MUST_CHANGE_PASSWORD_COPY, () => t`An operator set a temporary password. Choose yours to continue; you will not need the temporary one after this.`],
    [MUST_CHANGE_PASSWORD_REUSE, () => t`Choose a different password from the temporary one.`],
    ["Use at least 8 characters.", () => t`Use at least 8 characters.`],
    ["Use at most 128 characters.", () => t`Use at most 128 characters.`],
  ];
  let out = text;
  for (const [en, local] of known) if (out.includes(en)) out = out.split(en).join(local());
  return out;
}
