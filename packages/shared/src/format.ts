/**
 * Formatting a number, size, amount or day for people to read: the one `Intl` module (docs/I18N.md), written once for
 * the server (mail, refusals, the CLI) and the web app. A local `plural`, `gb` or `day` is the same helper again:
 * `test/shared-helpers-guard.test.ts` fails on one (docs/PRINCIPLES.md, "A general helper gets a general name in a
 * shared place").
 *
 * Every function formats for the active locale: the web app points `setFormatLocale` at the Lingui locale, the server
 * at the requester's (or the mail recipient's) locale for the current request or job. An explicit `locale` wins.
 * Unit symbols (B, MB, s, min, h) are international and stay as they are; the number around them is localised.
 */
import { DEFAULT_LOCALE, intlLocale } from "./locale.js";

let activeLocale: () => string = () => DEFAULT_LOCALE;
let activeTimeZone: () => string | null | undefined = () => undefined;

/** Where the active locale comes from: a getter, so a request or job scope on the server is read at format time. */
export function setFormatLocale(source: () => string): void {
  activeLocale = source;
}

/**
 * Where the time zone of days and times comes from when a call names none: the server points it at the request's or
 * the recipient's account zone (UTC when unset); the web app leaves it, so a screen shows the browser's own.
 */
export function setFormatTimeZone(source: () => string | null | undefined): void {
  activeTimeZone = source;
}

/** The locale formatting uses right now (`Intl` form: the pseudo-locale reads as English). */
export function formatLocale(locale?: string): string {
  return intlLocale(locale ?? activeLocale());
}

const numberFormats = new Map<string, Intl.NumberFormat>();
function numberFormat(locale: string, o: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(o)}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, o);
    numberFormats.set(key, f);
  }
  return f;
}

/** A count or measure for the locale: "1,200" in English, "1.200" in German. */
export function formatNumber(n: number, o: Intl.NumberFormatOptions & { locale?: string } = {}): string {
  const { locale, ...opts } = o;
  return numberFormat(formatLocale(locale), opts).format(n);
}

/** A share as a percent: `formatPercent(0.42)` -> "42%". */
export function formatPercent(fraction: number, o: { locale?: string; digits?: number } = {}): string {
  return numberFormat(formatLocale(o.locale), { style: "percent", maximumFractionDigits: o.digits ?? 0 }).format(fraction);
}

/**
 * Money held as minor units (cents) plus an ISO 4217 currency code, never a float of dollars: `formatMoney(1900, "USD")`
 * -> "$19" ("19 $US" in French). Whole amounts drop the decimals unless `cents` is set; the minor unit follows the
 * currency's own digits (JPY has none).
 */
export function formatMoney(minor: number, currency: string, o: { locale?: string; cents?: boolean } = {}): string {
  const locale = formatLocale(o.locale);
  const digits = numberFormat(locale, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const amount = minor / 10 ** digits;
  const whole = Number.isInteger(amount) && !o.cents;
  return numberFormat(locale, { style: "currency", currency, ...(whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}) }).format(amount);
}

/** A list joined for the locale: "a, b, and c"; `type: "disjunction"` for "a, b, or c". */
export function formatList(items: readonly string[], o: { locale?: string; type?: "conjunction" | "disjunction" | "unit" } = {}): string {
  return new Intl.ListFormat(formatLocale(o.locale), { style: "long", type: o.type ?? "conjunction" }).format(items);
}

/**
 * English-only count phrase, for text that stays English (logs, operator lines): "1 project", "12 projects"; `many`
 * for a word that does not just take an s ("1 fix", "2 fixes"). Text a person reads is an ICU plural in the
 * catalogue instead (`<Plural>` / `plural()` from Lingui): other languages have other plural forms.
 */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${formatNumber(n)} ${pluralWord(n, word, many)}`;
}

/** The word alone, for a sentence that names the items instead of counting them: "clip 3", "clips 3, 5". */
export function pluralWord(n: number, word: string, many = `${word}s`): string {
  return n === 1 ? word : many;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
/** Whole numbers below a GB, one decimal from there. */
const shown = (v: number, unit: number) => (unit >= 3 ? Number(v.toFixed(1)) : Math.round(v));

/**
 * Bytes in binary units: "512 B", "12 KB", "18 MB", "1.4 GB", "2.1 TB". The unit is picked after rounding, so
 * just under a boundary reads "1 MB", never "1024 KB".
 */
export function formatBytes(n: number): string {
  let v = Math.max(0, n);
  let unit = 0;
  while (unit < BYTE_UNITS.length - 1 && shown(v, unit) >= 1024) {
    v /= 1024;
    unit++;
  }
  return `${formatNumber(shown(v, unit))} ${BYTE_UNITS[unit]}`;
}

/** A size given in MB, as limits and usage are: "0 MB", "512 MB", "2 GB", "10 GB", "1.5 GB" (never smaller than MB). */
export function formatMb(mb: number): string {
  const whole = Math.max(0, Math.round(mb));
  return whole < 1024 ? `${formatNumber(whole)} MB` : formatBytes(mb * 1_048_576);
}

export interface DayFormat {
  /** "December" (default) or "Dec" */
  month?: "long" | "short";
  /** include the year (default true) */
  year?: boolean;
  /** shorthand for `timeZone: "UTC"`: a billing period or a reset day, the same day for every reader */
  utc?: boolean;
  /** IANA zone the day is read in: the recipient's account zone in mail and jobs; unset = the runtime's own (the viewer's, on a screen) */
  timeZone?: string | null | undefined;
  /** overrides the active locale */
  locale?: string;
}

/** A calendar day in the active locale: "December 18, 2026" in English, "18. Dezember 2026" in German. */
export function formatDay(d: Date | string | number, o: DayFormat = {}): string {
  const timeZone = o.utc ? "UTC" : (o.timeZone ?? activeTimeZone() ?? undefined);
  return new Date(d).toLocaleDateString(formatLocale(o.locale), {
    day: "numeric",
    month: o.month ?? "long",
    ...(o.year === false ? {} : { year: "numeric" }),
    ...(timeZone ? { timeZone } : {}),
  });
}

/** A moment with its time: "Dec 18, 2026, 3:04 PM" in English; the same `timeZone` / `utc` rules as `formatDay`. */
export function formatDateTime(d: Date | string | number, o: Omit<DayFormat, "month" | "year"> & { seconds?: boolean } = {}): string {
  const timeZone = o.utc ? "UTC" : (o.timeZone ?? activeTimeZone() ?? undefined);
  return new Date(d).toLocaleString(formatLocale(o.locale), {
    dateStyle: "medium",
    timeStyle: o.seconds ? "medium" : "short",
    ...(timeZone ? { timeZone } : {}),
  });
}

/** How long ago or until, in the locale's words: "3 minutes ago", "in 2 days", "yesterday". */
export function formatRelative(d: Date | string | number, o: { locale?: string; now?: number } = {}): string {
  const diff = (new Date(d).getTime() - (o.now ?? Date.now())) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(formatLocale(o.locale), { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 30 * 86_400) return rtf.format(Math.round(diff / 86_400), "day");
  if (abs < 365 * 86_400) return rtf.format(Math.round(diff / (30 * 86_400)), "month");
  return rtf.format(Math.round(diff / (365 * 86_400)), "year");
}

/** UTC calendar day `YYYY-MM-DD`. */
export function utcDay(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/** A span of seconds as people read a wait: "<1 s", "42 s", "7 min", "2 h 5 min"; "—" when unknown. */
export function formatSeconds(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "—";
  if (sec < 1) return `<${formatNumber(1)} s`;
  // whole seconds first, so 59.7 s reads "1 min", not "60 s"
  const s = Math.round(sec);
  if (s < 60) return `${formatNumber(s)} s`;
  if (s < 3600) return `${formatNumber(Math.floor(s / 60))} min`;
  const m = Math.floor((s % 3600) / 60);
  return `${formatNumber(Math.floor(s / 3600))} h${m ? ` ${formatNumber(m)} min` : ""}`;
}

/** A queue priority as an offset: "+5", "0", "-3" (one point = one job of backlog; QUEUE_PRIORITY_MIN..MAX). */
export function formatPriority(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** `h:mm:ss` (or `m:ss` under an hour) for a time in seconds. */
export function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}
