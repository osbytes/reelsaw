import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

/**
 * Message catalogues (docs/I18N.md). English is the source and the only shipped locale; `en-XA` is the pseudo-locale
 * (accented, lengthened, bracketed) for spotting unwrapped strings and clipped text: open the app with `?locale=en-XA`.
 * `pnpm --filter @reelsaw/web i18n:extract` after changing copy; CI runs `i18n:check`.
 */
export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "en-XA"],
  pseudoLocale: { locale: "en-XA" },
  fallbackLocales: { "en-XA": "en", default: "en" },
  catalogs: [{ path: "<rootDir>/src/locales/{locale}", include: ["<rootDir>/src"] }],
  format: formatter({ lineNumbers: false }),
});
