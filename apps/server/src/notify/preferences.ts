/**
 * What mail an account wants beyond the mail it must get (password reset, verification, approval).
 * Today that is the ready email. Settings → Account, tRPC `me.updateEmailPreferences`, MCP
 * `get_email_preferences` / `set_email_preferences`, `reelsaw email-prefs` and the email's own
 * unsubscribe link all go through here.
 *
 * The unsubscribe link follows RFC 8058 (what Gmail and Yahoo ask of senders since 2024): the mail
 * carries `List-Unsubscribe: <url>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and a
 * POST to the URL turns the email off with no sign-in. The URL holds the account id and an HMAC of
 * it, keyed from BETTER_AUTH_SECRET, so it cannot be forged for another account. A GET only shows a
 * confirm button: link scanners and prefetchers open links, and must not unsubscribe anyone.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import type { Services } from "../services.js";

export interface EmailPreferences {
  /** one note when projects finish and the account has stepped away */
  readyEmail: boolean;
}

export const DEFAULT_EMAIL_PREFERENCES: EmailPreferences = { readyEmail: true };

export async function emailPreferences(db: Db, userId: string): Promise<EmailPreferences> {
  const [row] = await db.select({ readyEmail: schema.userSettings.readyEmail }).from(schema.userSettings).where(eq(schema.userSettings.userId, userId));
  return row ? { readyEmail: row.readyEmail } : { ...DEFAULT_EMAIL_PREFERENCES };
}

export async function setEmailPreferences(svc: Pick<Services, "tx">, userId: string, patch: Partial<EmailPreferences>): Promise<{ ok: true; emailPreferences: EmailPreferences }> {
  return svc.tx(async (u) => {
    if (patch.readyEmail !== undefined) {
      await u.db
        .insert(schema.userSettings)
        .values({ userId, readyEmail: patch.readyEmail })
        .onConflictDoUpdate({ target: schema.userSettings.userId, set: { readyEmail: patch.readyEmail, updatedAt: new Date() } });
    }
    return { ok: true as const, emailPreferences: await emailPreferences(u.db, userId) };
  });
}

/** Which mail a link turns off. One topic today; the topic is part of what is signed. */
export type UnsubscribeTopic = "ready";

export const UNSUBSCRIBE_PATH = "/api/email/unsubscribe";

export function unsubscribeToken(secret: string, userId: string, topic: UnsubscribeTopic): string {
  return createHmac("sha256", secret).update(`unsubscribe:${topic}:${userId}`).digest("base64url");
}

export function verifyUnsubscribeToken(secret: string, userId: string, topic: UnsubscribeTopic, token: string): boolean {
  const want = Buffer.from(unsubscribeToken(secret, userId, topic));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function unsubscribeUrl(appUrl: string, secret: string, userId: string, topic: UnsubscribeTopic): string {
  const q = new URLSearchParams({ u: userId, topic, t: unsubscribeToken(secret, userId, topic) });
  return `${appUrl.replace(/\/$/, "")}${UNSUBSCRIBE_PATH}?${q}`;
}

/** The RFC 2369 / 8058 headers for a mail that may be turned off with one click. */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}
