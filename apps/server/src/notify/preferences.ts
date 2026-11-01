/**
 * What mail an account wants beyond the mail it must get (password reset, verification, approval).
 * Optional mail is split into topics (`EMAIL_TOPICS` in @reelsaw/shared; today `ready`, the note when
 * projects finish), each with its own switch, stored one row per chosen topic in `email_topic_prefs`.
 * Settings → Account, tRPC `me.updateEmailPreferences`, MCP `get_email_preferences` /
 * `set_email_preferences`, `reelsaw email-prefs` and the email's own unsubscribe link all go through here.
 *
 * The unsubscribe link follows RFC 8058 (what Gmail and Yahoo ask of senders since 2024): the mail
 * carries `List-Unsubscribe: <url>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, and a
 * POST to the URL turns that topic off with no sign-in. The URL holds the account id, the topic and an
 * HMAC of both, keyed from BETTER_AUTH_SECRET, so it cannot be forged for another account or topic. A
 * GET only shows a confirm button: link scanners and prefetchers open links, and must not unsubscribe anyone.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { DEFAULT_EMAIL_PREFERENCES, EMAIL_TOPIC_NAMES, type EmailPreferences, type EmailPrefSource, type EmailTopic, isEmailTopic } from "@reelsaw/shared";
import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import type { Services } from "../services.js";

export async function emailPreferences(db: Db, userId: string): Promise<EmailPreferences> {
  const rows = await db
    .select({ topic: schema.emailTopicPrefs.topic, enabled: schema.emailTopicPrefs.enabled })
    .from(schema.emailTopicPrefs)
    .where(eq(schema.emailTopicPrefs.userId, userId));
  const prefs = { ...DEFAULT_EMAIL_PREFERENCES };
  // a row for a topic since removed from EMAIL_TOPIC_NAMES is ignored, not an error
  for (const r of rows) if (isEmailTopic(r.topic)) prefs[r.topic] = r.enabled;
  return prefs;
}

/** Is this topic on for the account right now? Read when the mail is about to go, not when it was queued. */
export async function wantsEmail(db: Db, userId: string, topic: EmailTopic): Promise<boolean> {
  return (await emailPreferences(db, userId))[topic];
}

export async function setEmailPreferences(
  svc: Pick<Services, "tx">,
  userId: string,
  patch: { [T in EmailTopic]?: boolean | undefined },
  source: EmailPrefSource,
): Promise<{ ok: true; emailPreferences: EmailPreferences }> {
  return svc.tx(async (u) => {
    for (const topic of EMAIL_TOPIC_NAMES) {
      const enabled = patch[topic];
      if (enabled === undefined) continue;
      await u.db
        .insert(schema.emailTopicPrefs)
        .values({ userId, topic, enabled, source })
        .onConflictDoUpdate({
          target: [schema.emailTopicPrefs.userId, schema.emailTopicPrefs.topic],
          set: { enabled, source, updatedAt: new Date() },
        });
    }
    return { ok: true as const, emailPreferences: await emailPreferences(u.db, userId) };
  });
}

export const UNSUBSCRIBE_PATH = "/api/email/unsubscribe";

export function unsubscribeToken(secret: string, userId: string, topic: EmailTopic): string {
  return createHmac("sha256", secret).update(`unsubscribe:${topic}:${userId}`).digest("base64url");
}

export function verifyUnsubscribeToken(secret: string, userId: string, topic: EmailTopic, token: string): boolean {
  const want = Buffer.from(unsubscribeToken(secret, userId, topic));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function unsubscribeUrl(appUrl: string, secret: string, userId: string, topic: EmailTopic): string {
  const q = new URLSearchParams({ u: userId, topic, t: unsubscribeToken(secret, userId, topic) });
  return `${appUrl.replace(/\/$/, "")}${UNSUBSCRIBE_PATH}?${q}`;
}

/** The RFC 2369 / 8058 headers for a mail that may be turned off with one click. */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}
