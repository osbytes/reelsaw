/**
 * Server-side messages for people (docs/I18N.md): tRPC errors, notices, emails, MCP result sentences and CLI lines.
 *
 * Copy is written with Lingui's runtime `msg` (`@lingui/core/runtime-macro`, no build step):
 *   msg`Project ${{ title }} is gone`                                  hash id, for sentences
 *   msg({ id: "project.not_found", message: msg`No project ${{ id }}` }) explicit id, for errors (a stable code)
 *   msg({ id: "clips.ready", message: plural({ n }, { one: "# clip is ready", other: "# clips are ready" }) })
 * and rendered with `t(descriptor)` in the locale of the current scope. `pnpm --filter @reelsaw/server i18n:extract`
 * writes the catalogue (`assets/locales/<locale>.po`) from the code; CI runs `i18n:check`.
 *
 * The scope: an HTTP request runs in one (`localeMiddleware`), read from the web app's `x-reelsaw-locale` header,
 * else the account's locale (set once the requester is known, `scopeAccount`), else Accept-Language, else English.
 * Mail and jobs render for the recipient: `inLocaleOf(user, fn)`. The CLI takes `REELSAW_LOCALE` or `LANG`.
 *
 * Stays English, as contracts or for operators: log lines, config keys, API fields, MCP tool names and descriptions,
 * CLI commands and flags, `--json` output, metric and event names.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { type I18n, type MessageDescriptor, setupI18n } from "@lingui/core";
import { formatter } from "@lingui/format-po";
import { compileMessage } from "@lingui/message-utils/compileMessage";
import { acceptLanguages, DEFAULT_LOCALE, isLocale, isTimeZone, type Locale, matchLocale, setFormatLocale, setFormatTimeZone } from "@reelsaw/shared";
import { TRPCError } from "@trpc/server";
import type { MiddlewareHandler } from "hono";
import { bundledAssetPath } from "./lib/assets.js";

export type { MessageDescriptor } from "@lingui/core";
// `msg` / `plural` are imported straight from "@lingui/core/runtime-macro" in each file, never re-exported: the extractor
// only reads messages from that import.

/** The header the web app sends with its active locale (apps/web/src/lib/trpc.ts). */
export const LOCALE_HEADER = "x-reelsaw-locale";

interface LocaleScope {
  locale: Locale;
  /** IANA zone dates in this scope are read in; null = UTC */
  timeZone: string | null;
  /** the locale came from the request itself (header): an account setting does not override it */
  explicit: boolean;
}

const scope = new AsyncLocalStorage<LocaleScope>();

/** The locale messages render in right now: the scope's, else `REELSAW_LOCALE` / `LANG` (the CLI), else English. */
export function currentLocale(): Locale {
  return scope.getStore()?.locale ?? processLocale();
}

/** The time zone dates render in right now: the scope's (the account's), else null (UTC in mail and jobs). */
function currentTimeZone(): string | null {
  return scope.getStore()?.timeZone ?? null;
}

let cachedProcessLocale: Locale | undefined;
function processLocale(): Locale {
  if (cachedProcessLocale) return cachedProcessLocale;
  const asked = process.env["REELSAW_LOCALE"];
  if (isLocale(asked)) return (cachedProcessLocale = asked);
  // LANG=de_DE.UTF-8 → de-DE
  const lang = (process.env["LC_ALL"] || process.env["LC_MESSAGES"] || process.env["LANG"] || "").split(".")[0]?.replace("_", "-");
  cachedProcessLocale = (lang && matchLocale([lang])) || DEFAULT_LOCALE;
  return cachedProcessLocale;
}

setFormatLocale(currentLocale);
// days in mail, notices and messages are read in the account's zone, else UTC (never the server's own)
setFormatTimeZone(() => currentTimeZone() ?? "UTC");

/** Run `fn` with messages and dates in `locale` / `timeZone` (a job, a mail, a test). */
export function withLocale<T>(locale: string | null | undefined, timeZone: string | null | undefined, fn: () => T): T {
  return scope.run({ locale: isLocale(locale) ? locale : DEFAULT_LOCALE, timeZone: isTimeZone(timeZone) ? timeZone : null, explicit: true }, fn);
}

/** Run `fn` in the account's own locale and time zone: mail, notices and jobs render for the recipient, not the actor. */
export function inLocaleOf<T>(user: { locale?: string | null; timeZone?: string | null }, fn: () => T): T {
  return withLocale(user.locale, user.timeZone, fn);
}

/** The scope for one request: the web app's header, else Accept-Language, else English. The account refines it (`scopeAccount`). */
export function requestLocale(headers: Headers): LocaleScope {
  const asked = headers.get(LOCALE_HEADER);
  if (isLocale(asked)) return { locale: asked, timeZone: null, explicit: true };
  return { locale: matchLocale(acceptLanguages(headers.get("accept-language"))) ?? DEFAULT_LOCALE, timeZone: null, explicit: false };
}

/** Hono middleware: every request runs in its own locale scope. */
export function localeMiddleware(): MiddlewareHandler {
  return (c, next) => scope.run(requestLocale(c.req.raw.headers), next);
}

/**
 * Once the requester is known: their account's locale wins over Accept-Language (an agent or a script asked in the
 * account's language), not over the web app's own header (which already follows the account). The time zone is the account's.
 */
export function scopeAccount(user: { locale?: string | null; timeZone?: string | null }): void {
  const s = scope.getStore();
  if (!s) return;
  if (!s.explicit && isLocale(user.locale)) s.locale = user.locale;
  if (isTimeZone(user.timeZone)) s.timeZone = user.timeZone;
}

// ---------- catalogues ----------

const instances = new Map<Locale, I18n>();

function loadCatalogue(locale: Locale): Record<string, string> {
  const file = bundledAssetPath(`locales/${locale}.po`);
  if (!existsSync(file)) return {};
  const po = formatter({ lineNumbers: false });
  // format-po's parse is synchronous for a string; awaited types aside, the result is the catalogue
  const parsed = po.parse(readFileSync(file, "utf8"), { locale, sourceLocale: DEFAULT_LOCALE, filename: file }) as unknown as Record<
    string,
    { translation?: string; message?: string }
  >;
  const out: Record<string, string> = {};
  for (const [id, m] of Object.entries(parsed)) {
    const text = m.translation || m.message;
    if (text) out[id] = text;
  }
  return out;
}

function i18nFor(locale: Locale): I18n {
  let i = instances.get(locale);
  if (!i) {
    i = setupI18n();
    i.setMessagesCompiler(compileMessage);
    // a message missing from the locale's catalogue falls back to the English in the code
    i.load(locale, locale === DEFAULT_LOCALE ? {} : loadCatalogue(locale));
    i.activate(locale);
    instances.set(locale, i);
  }
  return i;
}

/** Render a message in the current scope's locale. */
export function t(descriptor: MessageDescriptor): string {
  return i18nFor(currentLocale())._(descriptor);
}

// ---------- errors ----------

type Param = string | number | boolean | null;

/**
 * A refusal or error for a person: a stable code (`messageId`, the message's explicit id), its parameters, and the
 * sentence rendered in the requester's locale. tRPC sends `data.messageId` and `data.params` beside the message, so
 * a client can render its own copy; MCP and the CLI show the sentence.
 *
 *   throw new AppError("NOT_FOUND", msg({ id: "project.not_found", message: "Project not found" }))
 */
export class AppError extends TRPCError {
  /** the message's explicit id; undefined for an error built from text already rendered (no code is better than a wrong one) */
  readonly messageId: string | undefined;
  readonly params: Record<string, Param>;
  constructor(code: TRPCError["code"], descriptor: MessageDescriptor | string, opts: { cause?: unknown } = {}) {
    super({ code, message: typeof descriptor === "string" ? descriptor : t(descriptor), ...(opts.cause === undefined ? {} : { cause: opts.cause }) });
    this.params = {};
    if (typeof descriptor === "string") {
      this.messageId = undefined;
      return;
    }
    this.messageId = descriptor.id;
    for (const [k, v] of Object.entries(descriptor.values ?? {})) {
      if (v === null || ["string", "number", "boolean"].includes(typeof v)) this.params[k] = v as Param;
    }
  }
}

/** The code and parameters a tRPC error carries to the client (errorFormatter), when it has them. */
export function errorMessageData(err: unknown): { messageId?: string; params?: Record<string, Param> } {
  const e = err instanceof AppError ? err : err instanceof TRPCError && err.cause instanceof AppError ? err.cause : null;
  return e?.messageId ? { messageId: e.messageId, ...(Object.keys(e.params).length ? { params: e.params } : {}) } : {};
}
