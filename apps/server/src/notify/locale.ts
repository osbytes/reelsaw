/**
 * An account's language and time zone (docs/I18N.md): which locale its emails, notices, MCP sentences and errors use,
 * and which zone the days in them are read in. Null follows the browser (the web app) and English / UTC (mail and jobs).
 * Settings → Account, tRPC `me.localePrefs` / `me.updateLocalePrefs`, MCP `get_locale_preferences` /
 * `set_locale_preferences` and `reelsaw locale-prefs` all go through here.
 */
import { isLocale, type LocalePrefs, type LocalePrefsPatch } from "@reelsaw/shared";
import { eq } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { msg } from "@lingui/core/runtime-macro";
import { AppError } from "../i18n.js";
import type { Services } from "../services.js";

export async function localePrefs(db: Db, userId: string): Promise<LocalePrefs> {
  const [row] = await db.select({ locale: schema.user.locale, timeZone: schema.user.timeZone }).from(schema.user).where(eq(schema.user.id, userId));
  if (!row) throw new AppError("NOT_FOUND", msg({ id: "account.not_found", message: "No such account" }));
  return { locale: isLocale(row.locale) ? row.locale : null, timeZone: row.timeZone };
}

export async function setLocalePrefs(svc: Pick<Services, "tx">, userId: string, patch: LocalePrefsPatch): Promise<{ ok: true } & LocalePrefs> {
  return svc.tx(async (u) => {
    const set: { locale?: string | null; timeZone?: string | null; updatedAt: Date } = { updatedAt: new Date() };
    if (patch.locale !== undefined) set.locale = patch.locale;
    if (patch.timeZone !== undefined) set.timeZone = patch.timeZone;
    const done = await u.db.update(schema.user).set(set).where(eq(schema.user.id, userId)).returning({ id: schema.user.id });
    if (!done.length) throw new AppError("NOT_FOUND", msg({ id: "account.not_found", message: "No such account" }));
    return { ok: true as const, ...(await localePrefs(u.db, userId)) };
  });
}
