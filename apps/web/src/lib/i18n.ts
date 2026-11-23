/**
 * The active locale and its messages (docs/I18N.md). One precedence chain: `?locale=` (development and support; it is
 * remembered on this browser, so `?locale=en` switches back), then the account's own choice (Settings → Account →
 * Language and region, applied once the account is known), then the locale chosen on this browser, then
 * `navigator.languages` matched against the shipped locales, then English. `<html lang dir>` follows it, so screen
 * readers pick the right voice (WCAG 3.1.1). Every API call sends it (`x-reelsaw-locale`, lib/trpc.ts), so errors
 * and notices come back in the same language; `@reelsaw/shared` formatting reads it too.
 */
import { i18n } from "@lingui/core";
import { DEFAULT_LOCALE, isLocale, type Locale, localeDir, matchLocale, setFormatLocale } from "@reelsaw/shared";

const STORAGE_KEY = "reelsaw.locale";

function stored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // private mode: fall through to the browser's languages
  }
}

function remember(locale: Locale | null): void {
  try {
    if (locale) localStorage.setItem(STORAGE_KEY, locale);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // private mode: the choice lasts for this page only
  }
}

function askedInUrl(search: string = window.location.search): Locale | undefined {
  const asked = new URLSearchParams(search).get("locale");
  return isLocale(asked) ? asked : undefined;
}

/** The first match in the chain before the account is known; a browser language matches on its primary subtag (`en-GB` → `en`). */
function resolveLocale(search: string = window.location.search, languages: readonly string[] = navigator.languages): Locale {
  const asked = askedInUrl(search);
  if (asked) {
    remember(asked);
    return asked;
  }
  const chosen = stored();
  if (isLocale(chosen)) return chosen;
  return matchLocale(languages) ?? DEFAULT_LOCALE;
}

/** The locale the app shows and sends right now. */
export function activeLocale(): Locale {
  return isLocale(i18n.locale) ? i18n.locale : DEFAULT_LOCALE;
}

setFormatLocale(activeLocale);

/** Load the catalogue for `locale` (compiled on import by @lingui/vite-plugin) and make it active. */
export async function activateLocale(locale: Locale = resolveLocale()): Promise<void> {
  if (i18n.locale === locale) return;
  const { messages } = await import(`../locales/${locale}.po`);
  i18n.load(locale, messages);
  i18n.activate(locale);
  document.documentElement.lang = locale;
  document.documentElement.dir = localeDir(locale);
}

/**
 * The account's choice joins the chain once `me` loads: it wins over this browser's own, not over `?locale=`. Null
 * (follow the browser) leaves the chain as it was. Remembered here too, so the next visit starts in it before sign-in.
 */
export function applyAccountLocale(locale: string | null | undefined): void {
  if (askedInUrl() || !isLocale(locale)) return;
  remember(locale);
  void activateLocale(locale);
}

/** After a change in Settings: the new choice, or null to go back to the browser's languages. */
export function chooseLocale(locale: Locale | null): void {
  remember(locale);
  void activateLocale(locale ?? matchLocale(navigator.languages) ?? DEFAULT_LOCALE);
}

export { i18n };
