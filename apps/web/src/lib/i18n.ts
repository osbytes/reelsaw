/**
 * The active locale and its messages (docs/I18N.md). One precedence chain: `?locale=` (development and support; it is
 * remembered on this browser, so `?locale=en` switches back), then the locale chosen on this browser, then `navigator.languages` matched against the shipped
 * locales, then English. `<html lang dir>` follows it, so screen readers pick the right voice (WCAG 3.1.1).
 * The account-level setting (for emails and jobs) joins the chain when a second locale ships.
 */
import { i18n } from "@lingui/core";

/** Locales a person can pick. `en-XA` is the pseudo-locale: available on request, never matched from the browser. */
const SHIPPED_LOCALES = ["en"] as const;
const PSEUDO_LOCALE = "en-XA";
const RTL = new Set(["ar", "fa", "he", "ur"]);
const STORAGE_KEY = "reelsaw.locale";
type Locale = (typeof SHIPPED_LOCALES)[number] | typeof PSEUDO_LOCALE;

function isLocale(x: string | null | undefined): x is Locale {
  return x === PSEUDO_LOCALE || SHIPPED_LOCALES.some((l) => l === x);
}

function stored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // private mode: fall through to the browser's languages
  }
}

/** The first match in the chain; a browser language matches on its primary subtag (`en-GB` → `en`). */
function resolveLocale(search: string = window.location.search, languages: readonly string[] = navigator.languages): Locale {
  const asked = new URLSearchParams(search).get("locale");
  if (isLocale(asked)) {
    try {
      localStorage.setItem(STORAGE_KEY, asked);
    } catch {
      // private mode: the choice lasts for this page only
    }
    return asked;
  }
  const chosen = stored();
  if (isLocale(chosen)) return chosen;
  for (const lang of languages) {
    const base = lang.toLowerCase().split("-")[0];
    const hit = SHIPPED_LOCALES.find((l) => l === base);
    if (hit) return hit;
  }
  return "en";
}

/** Load the catalogue for `locale` (compiled on import by @lingui/vite-plugin) and make it active. */
export async function activateLocale(locale: Locale = resolveLocale()): Promise<void> {
  const { messages } = await import(`../locales/${locale}.po`);
  i18n.load(locale, messages);
  i18n.activate(locale);
  document.documentElement.lang = locale;
  document.documentElement.dir = RTL.has(locale.split("-")[0] ?? "") ? "rtl" : "ltr";
}

export { i18n };
