import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

/**
 * reelsaw.com's message catalogue, the same .po format as the app (docs/I18N.md). Copy is written with Lingui's runtime
 * `msg` (`@lingui/core/runtime-macro`): no SWC or Babel plugin in Next, and `experimental.runtimeMacro` lets the
 * extractor read it. English is the source; `en-XA` is the pseudo-locale (`SITE_LOCALE=en-XA pnpm dev`).
 * `pnpm i18n:extract` after changing copy; CI runs `pnpm i18n:check`. `pnpm dev`, `build` and `typecheck` compile the
 * catalogues to `locales/<locale>.ts` (generated, not committed) first.
 */
export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "ru", "en-XA"],
  pseudoLocale: { locale: "en-XA" },
  fallbackLocales: { "en-XA": "en", default: "en" },
  experimental: { runtimeMacro: true },
  catalogs: [{ path: "<rootDir>/locales/{locale}", include: ["<rootDir>/app", "<rootDir>/components", "<rootDir>/content", "<rootDir>/lib"] }],
  format: formatter({ lineNumbers: false }),
});
