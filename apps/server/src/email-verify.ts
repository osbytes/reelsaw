/**
 * Email-confirmation links. Better Auth mints a JWT (default 1 hour, reusable until it expires).
 * We keep a hash of the current token in `verification` so a resend invalidates older links, and
 * so a used link cannot confirm again. Expired or superseded links redirect to /login with a
 * resend button instead of a dead error.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { looksLikeEmail, VERIFY_EMAIL_CALLBACK_PATH } from "@reelsaw/shared";
import { schema, type Db } from "./db/index.js";

/** Better Auth `emailVerification.expiresIn` (seconds). 24 hours is the usual mailbox delay. */
export const EMAIL_VERIFY_EXPIRES_IN_SEC = 60 * 60 * 24;

export type VerifyJwt = { email: string | null; expired: boolean };
export type VerifyGate = { ok: true } | { ok: false; error: "TOKEN_EXPIRED"; email: string | null };

export function emailVerifyIdentifier(email: string): string {
  return `email-verify:${email.trim().toLowerCase()}`;
}

export function hashEmailVerifyToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Untrusted claims for the recovery page (email) and our expiry gate. Better Auth still verifies the signature. */
export function readVerifyJwt(token: string): VerifyJwt {
  if (!token) return { email: null, expired: true };
  try {
    const parts = token.split(".");
    if (parts.length < 2 || !parts[1]) return { email: null, expired: true };
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as { email?: unknown; exp?: unknown };
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : null;
    const looks = email && looksLikeEmail(email) ? email : null;
    const expired = typeof payload.exp === "number" && payload.exp * 1000 < Date.now();
    return { email: looks, expired };
  } catch {
    return { email: null, expired: true };
  }
}

/** Point the confirmation URL at /login so an expired JWT lands on the resend page, not `/`. */
export function withLoginCallback(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("callbackURL", VERIFY_EMAIL_CALLBACK_PATH);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Missing `currentHash` is a link minted before we stored a nonce: Better Auth still checks the JWT.
 * A stored hash that does not match is a superseded link (a newer one was sent).
 */
export function decideEmailVerifyGate(input: {
  jwt: VerifyJwt;
  token: string;
  emailVerified: boolean;
  currentHash: string | null;
  currentExpired: boolean;
}): VerifyGate {
  const email = input.jwt.email;
  if (!input.token || input.jwt.expired) return { ok: false, error: "TOKEN_EXPIRED", email };
  if (input.emailVerified) return { ok: true };
  if (input.currentHash == null) return { ok: true };
  if (input.currentExpired || input.currentHash !== hashEmailVerifyToken(input.token)) {
    return { ok: false, error: "TOKEN_EXPIRED", email };
  }
  return { ok: true };
}

export async function rememberEmailVerifyToken(db: Db, email: string, token: string, now = new Date()): Promise<void> {
  const identifier = emailVerifyIdentifier(email);
  const expiresAt = new Date(now.getTime() + EMAIL_VERIFY_EXPIRES_IN_SEC * 1000);
  await db.transaction(async (tx) => {
    await tx.delete(schema.verification).where(eq(schema.verification.identifier, identifier));
    await tx.insert(schema.verification).values({
      id: randomUUID(),
      identifier,
      value: hashEmailVerifyToken(token),
      expiresAt,
    });
  });
}

export async function consumeEmailVerifyToken(db: Db, email: string, token: string, now = new Date()): Promise<boolean> {
  const deleted = await db
    .delete(schema.verification)
    .where(
      and(
        eq(schema.verification.identifier, emailVerifyIdentifier(email)),
        eq(schema.verification.value, hashEmailVerifyToken(token)),
        gt(schema.verification.expiresAt, now),
      ),
    )
    .returning({ id: schema.verification.id });
  return deleted.length > 0;
}

export async function gateEmailVerification(db: Db, token: string): Promise<VerifyGate> {
  const jwt = readVerifyJwt(token);
  const email = jwt.email;
  const user = email ? await db.query.user.findFirst({ where: eq(schema.user.email, email), columns: { emailVerified: true } }) : undefined;
  const row = email ? await db.query.verification.findFirst({ where: eq(schema.verification.identifier, emailVerifyIdentifier(email)) }) : undefined;
  const now = Date.now();
  const decision = decideEmailVerifyGate({
    jwt,
    token,
    emailVerified: user?.emailVerified ?? false,
    currentHash: row?.value ?? null,
    currentExpired: row ? row.expiresAt.getTime() <= now : false,
  });
  if (!decision.ok) return decision;
  if (user?.emailVerified || !email || !row) return decision;
  if (row.value !== hashEmailVerifyToken(token) || row.expiresAt.getTime() <= now) return decision;
  const consumed = await consumeEmailVerifyToken(db, email, token);
  if (consumed) return decision;
  const again = await db.query.user.findFirst({ where: eq(schema.user.email, email), columns: { emailVerified: true } });
  if (again?.emailVerified) return { ok: true };
  return { ok: false, error: "TOKEN_EXPIRED", email };
}
