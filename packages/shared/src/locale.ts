/**
 * Which languages Reelsaw speaks, and which one a person gets (docs/I18N.md). One list for the web app, the server
 * (errors, emails, MCP and CLI sentences) and the account setting, so a locale ships everywhere at once.
 *
 * A locale ships when its catalogues are translated: `apps/web/src/locales/<locale>.po` and
 * `apps/server/src/locales/<locale>.po`. `en-XA` is the pseudo-locale (accented, lengthened text for spotting
 * unwrapped strings and clipped labels): available on request, never matched from a browser or an Accept-Language.
 */
import { z } from "zod";

export const SHIPPED_LOCALES = ["en", "ru"] as const;
export const PSEUDO_LOCALE = "en-XA";
export const DEFAULT_LOCALE = "en";
export type ShippedLocale = (typeof SHIPPED_LOCALES)[number];
export type Locale = ShippedLocale | typeof PSEUDO_LOCALE;

const RTL_LANGUAGES = new Set(["ar", "fa", "he", "ur", "ps", "sd", "ug", "yi", "dv"]);

export function isLocale(x: unknown): x is Locale {
  return x === PSEUDO_LOCALE || SHIPPED_LOCALES.some((l) => l === x);
}

/** The account setting: a locale Reelsaw ships, or null to follow the browser. */
export const localeSchema = z.enum([...SHIPPED_LOCALES, PSEUDO_LOCALE]);

/** "ltr" or "rtl" for `<html dir>` and for mail. */
export function localeDir(locale: string): "ltr" | "rtl" {
  return RTL_LANGUAGES.has(locale.toLowerCase().split("-")[0] ?? "") ? "rtl" : "ltr";
}

/**
 * The first shipped locale among `languages` (a browser's `navigator.languages`, or the tags of an Accept-Language
 * header in order). A tag matches exactly or on its primary subtag (`en-GB` → `en`); the pseudo-locale is never
 * matched this way. Undefined when none ships.
 */
export function matchLocale(languages: readonly string[]): ShippedLocale | undefined {
  for (const lang of languages) {
    const tag = lang.trim().toLowerCase();
    const exact = SHIPPED_LOCALES.find((l) => l.toLowerCase() === tag);
    if (exact) return exact;
    const base = tag.split("-")[0];
    const hit = SHIPPED_LOCALES.find((l) => l === base);
    if (hit) return hit;
  }
  return undefined;
}

/** The language tags of an Accept-Language header, best first (`q=0` dropped). */
export function acceptLanguages(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part, i) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { tag: tag.trim(), q: q ? Number(q.slice(2)) : 1, i };
    })
    .filter((x) => x.tag && x.tag !== "*" && Number.isFinite(x.q) && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map((x) => x.tag);
}

/** The locale `Intl` formats with: the pseudo-locale formats as English. */
export function intlLocale(locale: string): string {
  return locale === PSEUDO_LOCALE ? DEFAULT_LOCALE : locale;
}

/** An IANA time zone the runtime knows ("Europe/Berlin"); the account setting is one of these or null (the browser's own). */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const timeZoneSchema = z.string().refine(isTimeZone, { message: "Not a time zone this server knows (an IANA name such as Europe/Berlin)" });

/** Where a person's language and time zone come from when they did not choose: the browser (web) or UTC and English (mail, jobs). */
export interface LocalePrefs {
  /** null = follow the browser (web) or English (mail, jobs) */
  locale: Locale | null;
  /** null = the browser's own (web) or UTC (mail, jobs) */
  timeZone: string | null;
}

export const localePrefsPatchSchema = z.object({
  locale: localeSchema
    .nullable()
    .optional()
    .describe(`Language of the app, emails and messages: ${[...SHIPPED_LOCALES].join(", ")}; null follows the browser`),
  timeZone: timeZoneSchema
    .nullable()
    .optional()
    .describe("IANA time zone for dates in emails and notices (e.g. Europe/Berlin); null uses the browser's own on screen and UTC in mail"),
});
export type LocalePrefsPatch = z.infer<typeof localePrefsPatchSchema>;
