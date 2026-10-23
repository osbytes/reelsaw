import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideEmailVerifyGate,
  hashEmailVerifyToken,
  readVerifyJwt,
  withLoginCallback,
  emailVerifyIdentifier,
} from "../src/email-verify.js";

function jwtPayload(claims: object): string {
  const b64 = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `hdr.${b64}.sig`;
}

describe("readVerifyJwt", () => {
  it("reads the email and treats a past exp as expired", () => {
    const token = jwtPayload({ email: "Ada@Example.com", exp: Math.floor(Date.now() / 1000) - 10 });
    assert.deepEqual(readVerifyJwt(token), { email: "ada@example.com", expired: true });
  });

  it("accepts a live token", () => {
    const token = jwtPayload({ email: "ada@example.com", exp: Math.floor(Date.now() / 1000) + 3600 });
    assert.deepEqual(readVerifyJwt(token), { email: "ada@example.com", expired: false });
  });

  it("rejects garbage", () => {
    assert.deepEqual(readVerifyJwt(""), { email: null, expired: true });
    assert.deepEqual(readVerifyJwt("not-a-jwt"), { email: null, expired: true });
  });
});

describe("withLoginCallback", () => {
  it("points the confirmation URL at /login so an expired JWT lands on the resend page", () => {
    const url = withLoginCallback("https://app.example.com/api/auth/verify-email?token=abc&callbackURL=%2F");
    assert.equal(new URL(url).searchParams.get("callbackURL"), "/login");
    assert.equal(new URL(url).searchParams.get("token"), "abc");
  });
});

describe("decideEmailVerifyGate", () => {
  const live = { email: "ada@example.com", expired: false };
  const hash = hashEmailVerifyToken("current");

  it("refuses an expired JWT and keeps the email for the resend form", () => {
    const r = decideEmailVerifyGate({ jwt: { email: "ada@example.com", expired: true }, token: "x", emailVerified: false, currentHash: hash, currentExpired: false });
    assert.deepEqual(r, { ok: false, error: "TOKEN_EXPIRED", email: "ada@example.com" });
  });

  it("lets an already-confirmed account through so a second click is not an error", () => {
    const r = decideEmailVerifyGate({ jwt: live, token: "old", emailVerified: true, currentHash: hash, currentExpired: false });
    assert.equal(r.ok, true);
  });

  it("lets a legacy JWT through when no nonce was stored yet", () => {
    const r = decideEmailVerifyGate({ jwt: live, token: "legacy", emailVerified: false, currentHash: null, currentExpired: false });
    assert.equal(r.ok, true);
  });

  it("refuses a superseded token after a newer one was sent", () => {
    const r = decideEmailVerifyGate({ jwt: live, token: "old", emailVerified: false, currentHash: hash, currentExpired: false });
    assert.deepEqual(r, { ok: false, error: "TOKEN_EXPIRED", email: "ada@example.com" });
  });

  it("accepts the current unexpired token", () => {
    const r = decideEmailVerifyGate({ jwt: live, token: "current", emailVerified: false, currentHash: hash, currentExpired: false });
    assert.equal(r.ok, true);
  });
});

describe("emailVerifyIdentifier", () => {
  it("is one row per mailbox", () => {
    assert.equal(emailVerifyIdentifier("Ada@Example.com"), "email-verify:ada@example.com");
  });
});
