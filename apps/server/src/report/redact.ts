/**
 * Redaction for issue reports: secrets never leave the machine.
 *  - config: every setting in full unless it's secret (secrets → "set" / "unset"); model and
 *    provider settings are kept because which models ran is often the cause; URLs lose their
 *    userinfo and query string.
 *  - free text (logs, events): every configured secret value, bearer tokens, cookies, emails and
 *    signed-URL query strings are replaced with [redacted].
 */
import type { Config } from "../config.js";

const SECRET_KEY = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|COOKIE|DATABASE_URL|AUTHORIZATION|OTEL_EXPORTER_OTLP_HEADERS/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** "https://user:pass@host:1/path?sig=…" → "https://host:1/path" (non-URLs pass through). */
export function stripUrl(value: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  try {
    const u = new URL(value);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return "[unparseable url]";
  }
}

export function configForReport(config: Config): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config).sort(([a], [b]) => a.localeCompare(b))) {
    if (value === undefined || value === null || value === "") out[key] = isSecretKey(key) ? "unset" : value ?? null;
    else if (isSecretKey(key)) out[key] = "set";
    else if (typeof value === "string") out[key] = stripUrl(value);
    else out[key] = value;
  }
  return out;
}

/**
 * Values shorter than this are placeholders, not credentials ("local", "ollama" for keyless local
 * providers); scrubbing them would mangle ordinary words. They still show only as set/unset.
 */
export const MIN_SECRET_LENGTH = 8;

/** Every secret value in the config (and parts of secret URLs), longest first, for text scrubbing. */
export function secretValues(config: Config): string[] {
  const vals = new Set<string>();
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== "string" || !value) continue;
    if (isSecretKey(key)) vals.add(value);
    // credentials embedded in any URL setting
    if (/:\/\//.test(value)) {
      try {
        const u = new URL(value);
        if (u.password) vals.add(decodeURIComponent(u.password));
        if (u.username && u.password) vals.add(decodeURIComponent(u.username));
      } catch {
        /* not a url */
      }
    }
  }
  return [...vals].filter((v) => v.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

const PATTERNS: Array<[RegExp, string]> = [
  [/(authorization["']?\s*[:=]\s*["']?)(bearer|basic)\s+[^"'\s,}]+/gi, "$1$2 [redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer [redacted]"],
  [/((?:set-)?cookie["']?\s*[:=]\s*["']?)[^"'\n]+/gi, "$1[redacted]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted email]"],
  // presigned URL signatures (S3 / R2 / GCS) and similar tokens in query strings
  [/([?&](?:X-Amz-[A-Za-z-]+|Signature|sig|token|access_token|key|api_key|apikey|expires)=)[^&"'\s]+/gi, "$1[redacted]"],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[redacted key]"],
  [/\b(sk-ant|sk-proj|gsk|xai|AIza)[A-Za-z0-9_-]{12,}/g, "[redacted key]"],
];

/**
 * `extra` carries secrets that live outside the environment, such as provider API keys an admin
 * entered in the UI (stored encrypted, decrypted in memory only).
 */
export function makeRedactor(config: Config, extra: Iterable<string> = []): (text: string) => string {
  const secrets = [...new Set([...secretValues(config), ...[...extra].filter((v) => v.length >= MIN_SECRET_LENGTH)])].sort((a, b) => b.length - a.length);
  // also match each secret as it appears inside JSON text (quotes/backslashes escaped)
  const forms = [...new Set(secrets.flatMap((v) => [v, JSON.stringify(v).slice(1, -1)]))].sort((a, b) => b.length - a.length);
  return (text) => {
    let s = text;
    for (const v of forms) if (s.includes(v)) s = s.split(v).join("[redacted]");
    for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
    return s;
  };
}
