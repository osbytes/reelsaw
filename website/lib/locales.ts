/**
 * The site's locales: the one list lingui.config.ts extracts for and lib/i18n.ts loads (its catalogue map must cover
 * every entry, so a locale added here without a catalogue fails the typecheck). `en-XA` is the pseudo-locale.
 * Keep the translated ones in step with `SHIPPED_LOCALES` (packages/shared/src/locale.ts); the server's
 * test/locale-catalogues.test.ts checks it.
 */
export const SITE_LOCALES = ["en", "ru", "en-XA"] as const;
export type SiteLocale = (typeof SITE_LOCALES)[number];
