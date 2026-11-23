/**
 * A catalogue message for modules that must also load outside the app (a Node test imports `clipMeta`, `cutState`):
 * no build-time macro, so the descriptor is written out with an explicit id and marked `/*i18n*\/` for extraction:
 *
 *   tr(/*i18n*\/ { id: "clipmeta.cuts", message: "{cuts, plural, one {# cut} other {# cuts}}", values: { cuts } })
 *
 * In the app the locale is always active (lib/i18n.ts runs first); on its own (a test) English is activated so the
 * source text renders. Components use the `<Trans>` / `t` macros instead.
 */
import { i18n, type MessageDescriptor } from "@lingui/core";

export function tr(descriptor: MessageDescriptor): string {
  if (!i18n.locale) i18n.loadAndActivate({ locale: "en", messages: {} });
  return i18n._(descriptor);
}
