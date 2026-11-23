/**
 * The site's language (docs/I18N.md). One build per locale: `SITE_LOCALE` at build time (default English) picks the
 * catalogue, so copy rendered at import time (content/*.ts) and at request time read the same language, on the server
 * and in client components alike. Only English ships; `en-XA` is the pseudo-locale for spotting unwrapped copy.
 *
 * Write copy with the runtime macro and render it with `t`:
 *   import { msg } from "@lingui/core/runtime-macro";
 *   t(msg`Clips from ${{ name }}`)
 * (`${{ label: value }}` placeholders: the runtime macro cannot see variable names). A sentence with a link or a styled
 * word in it stays one message: `rich(msg`Read <0>the docs</0> first`, { 0: (c) => <a href="/docs">{c}</a> })`, where `<0/>`
 * stands for an element passed whole and `<0>…</0>` for one that wraps the translated words. `pnpm i18n:extract` after a change.
 */
import { type MessageDescriptor, setupI18n } from "@lingui/core";
import { compileMessage } from "@lingui/message-utils/compileMessage";
import { Fragment, type ReactNode, createElement } from "react";
import { messages as en } from "@/locales/en";
import { messages as enXA } from "@/locales/en-XA";

const CATALOGS = { en, "en-XA": enXA } as const;
export type SiteLocale = keyof typeof CATALOGS;

const RTL = new Set(["ar", "fa", "he", "ur"]);

function siteLocale(): SiteLocale {
  // inlined at build time by next.config.ts `env`, so client components read the same value as the server
  const asked = process.env.SITE_LOCALE;
  return asked && asked in CATALOGS ? (asked as SiteLocale) : "en";
}

export const LOCALE: SiteLocale = siteLocale();
/** `<html dir>` */
export const DIR: "ltr" | "rtl" = RTL.has(LOCALE.split("-")[0] ?? "") ? "rtl" : "ltr";
/** Open Graph `locale` ("en_US") */
export const OG_LOCALE = LOCALE.startsWith("en") ? "en_US" : (LOCALE as string).replace("-", "_");

const i18n = setupI18n();
// a message missing from the catalogue falls back to the English in the code, compiled on first use
i18n.setMessagesCompiler(compileMessage);
i18n.load(LOCALE, CATALOGS[LOCALE]);
i18n.activate(LOCALE);

/** Render a message in the site's locale. */
export function t(descriptor: MessageDescriptor): string {
  return i18n._(descriptor);
}

/** The locale numbers and dates are formatted in (`Intl`): the pseudo-locale formats as English. */
export const INTL_LOCALE = LOCALE === "en-XA" ? "en" : LOCALE;

type Part = ReactNode | ((children: ReactNode) => ReactNode);
const TAG = /<(\d+)>([\s\S]*?)<\/\1>|<(\d+)\/>/g;

/** Render a message whose `<n>…</n>` / `<n/>` tags stand for the `parts` (links, code, styled words) of one sentence. */
export function rich(descriptor: MessageDescriptor, parts: Record<number, Part>): ReactNode {
  const text = t(descriptor);
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(TAG)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const part = parts[Number(m[1] ?? m[3])];
    const node = typeof part === "function" ? part(m[2] ?? "") : part;
    out.push(createElement(Fragment, { key: key++ }, node));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length === 1 && typeof out[0] === "string" ? out[0] : createElement(Fragment, null, ...out);
}
