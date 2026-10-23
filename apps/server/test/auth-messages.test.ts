import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_EXISTS_MESSAGE,
  CONFIRM_EMAIL_THEN_SIGN_IN,
  PENDING_APPROVAL_MESSAGE,
  REPEAT_SIGN_UP_KEEPS_FIRST_PASSWORD,
  repeatSignUpMessage,
  shouldOfferResendVerification,
  signupCreatedNotice,
  unverifiedSignInMessage,
  verifyEmailErrorFromSearch,
  verifyLinkFailed,
} from "@reelsaw/shared";

const pending = { kind: "pending" as const, reason: PENDING_APPROVAL_MESSAGE };
const banned = { kind: "banned" as const, reason: "This account is suspended." };

describe("repeat sign-up", () => {
  it("tells a pending account the waiting sentence and that the password did not change", () => {
    const message = repeatSignUpMessage(pending);
    assert.equal(message.startsWith(PENDING_APPROVAL_MESSAGE), true);
    assert.equal(message.includes(REPEAT_SIGN_UP_KEEPS_FIRST_PASSWORD), true);
  });

  it("tells a suspended account why, and everyone else that the account exists", () => {
    assert.equal(repeatSignUpMessage(banned), banned.reason);
    assert.equal(repeatSignUpMessage(null), ACCOUNT_EXISTS_MESSAGE);
  });
});

describe("sign-in while the email is unconfirmed", () => {
  it("uses the waiting sentence for a pending account and leaves an approved account to Better Auth", () => {
    const message = unverifiedSignInMessage(pending);
    assert.equal(message?.startsWith(PENDING_APPROVAL_MESSAGE), true);
    assert.equal(message?.includes(CONFIRM_EMAIL_THEN_SIGN_IN), true);
    assert.equal(unverifiedSignInMessage(null), null);
    assert.equal(unverifiedSignInMessage(banned), banned.reason);
  });
});

describe("sign-up that created an account and no session", () => {
  it("says the account is waiting when sign-up needs approval, and only the confirmation otherwise", () => {
    assert.equal(signupCreatedNotice("approval").startsWith(PENDING_APPROVAL_MESSAGE), true);
    assert.equal(signupCreatedNotice("approval").includes("first sign-up"), true);
    assert.equal(signupCreatedNotice("open").includes(PENDING_APPROVAL_MESSAGE), false);
    assert.equal(signupCreatedNotice("open").includes(CONFIRM_EMAIL_THEN_SIGN_IN), true);
  });
});

describe("expired confirmation link", () => {
  it("reads the error and email Better Auth puts on /login", () => {
    assert.deepEqual(verifyEmailErrorFromSearch("?error=TOKEN_EXPIRED&email=Ada%40Example.com"), { expired: true, email: "ada@example.com" });
    assert.deepEqual(verifyEmailErrorFromSearch("?error=INVALID_TOKEN"), { expired: true, email: null });
    assert.equal(verifyLinkFailed("TOKEN_EXPIRED"), true);
    assert.equal(verifyLinkFailed("INVALID_EMAIL_OR_PASSWORD"), false);
  });

  it("offers a resend after sign-up, an expired link, or an unverified sign-in", () => {
    assert.equal(shouldOfferResendVerification({ errorCode: null, expiredLink: true, afterSignUp: false }), true);
    assert.equal(shouldOfferResendVerification({ errorCode: null, expiredLink: false, afterSignUp: true }), true);
    assert.equal(shouldOfferResendVerification({ errorCode: "EMAIL_NOT_VERIFIED", expiredLink: false, afterSignUp: false }), true);
    assert.equal(shouldOfferResendVerification({ errorCode: "ACCOUNT_PENDING", expiredLink: false, afterSignUp: false }), true);
    assert.equal(shouldOfferResendVerification({ errorCode: "INVALID_EMAIL_OR_PASSWORD", expiredLink: false, afterSignUp: false }), false);
  });
});
