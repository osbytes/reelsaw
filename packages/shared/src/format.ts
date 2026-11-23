/**
 * Formatting a number, size or day for people to read, written once for the server (mail, refusals, the CLI) and
 * the web app. A local `plural`, `gb` or `day` is the same helper again: `test/shared-helpers-guard.test.ts` fails
 * on one (docs/PRINCIPLES.md, "A general helper gets a general name in a shared place").
 */

/** "1 project", "12 projects", "1,200 minutes"; `many` for a word that does not just take an s ("1 fix", "2 fixes"). */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n.toLocaleString("en-US")} ${pluralWord(n, word, many)}`;
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
  return `${shown(v, unit)} ${BYTE_UNITS[unit]}`;
}

/** A size given in MB, as limits and usage are: "0 MB", "512 MB", "2 GB", "10 GB", "1.5 GB" (never smaller than MB). */
export function formatMb(mb: number): string {
  const whole = Math.max(0, Math.round(mb));
  return whole < 1024 ? `${whole.toLocaleString("en-US")} MB` : formatBytes(mb * 1_048_576);
}

export interface DayFormat {
  /** "December" (default) or "Dec" */
  month?: "long" | "short";
  /** include the year (default true) */
  year?: boolean;
  /**
   * Server text (mail, refusals, the CLI): one fixed English format in UTC, the same for every reader. Off for a
   * screen, which shows the viewer's own locale and time zone.
   */
  utc?: boolean;
}

/** A calendar day: "18 December 2026" on the server (`utc`), the viewer's own form on a screen ("December 18, 2026"). */
export function formatDay(d: Date | string | number, o: DayFormat = {}): string {
  return new Date(d).toLocaleDateString(o.utc ? "en-GB" : undefined, {
    day: "numeric",
    month: o.month ?? "long",
    ...(o.year === false ? {} : { year: "numeric" }),
    ...(o.utc ? { timeZone: "UTC" } : {}),
  });
}

/** UTC calendar day `YYYY-MM-DD`. */
export function utcDay(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/** A span of seconds as people read a wait: "<1 s", "42 s", "7 min", "2 h 5 min"; "—" when unknown. */
export function formatSeconds(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "—";
  if (sec < 1) return "<1 s";
  // whole seconds first, so 59.7 s reads "1 min", not "60 s"
  const s = Math.round(sec);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  const m = Math.floor((s % 3600) / 60);
  return `${Math.floor(s / 3600)} h${m ? ` ${m} min` : ""}`;
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
