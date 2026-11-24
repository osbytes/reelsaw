import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

/**
 * Server message catalogues (docs/I18N.md, src/i18n.ts): errors, notices, emails, MCP result sentences and CLI lines,
 * written with Lingui's runtime `msg` (no build step; `experimental.runtimeMacro` lets the extractor read it).
 * English is the source. The catalogues live in assets/ so the image ships them beside the bundle.
 * `pnpm --filter @reelsaw/server i18n:extract` after changing copy; CI runs `i18n:check`.
 */
export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "ru", "en-XA"],
  pseudoLocale: { locale: "en-XA" },
  fallbackLocales: { "en-XA": "en", default: "en" },
  experimental: { runtimeMacro: true },
  catalogs: [{ path: "<rootDir>/assets/locales/{locale}", include: ["<rootDir>/src"], exclude: ["**/eval/**", "**/dev/**"] }],
  format: formatter({ lineNumbers: false }),
});
