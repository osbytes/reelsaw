/**
 * Pure OTLP endpoint resolution for otel.ts (and tests). No SDK side effects.
 * SENTRY_DSN is never used here — OTEL and Sentry error reporting stay independent.
 */

/** What the browser may use to export OTLP (public keys / auth only — never private bearer tokens). */
export type OtelPublic = {
  endpoint: string;
  headers: Record<string, string>;
  metrics: boolean;
  serviceName: string;
} | null;

export function isSentryOtlpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname.includes("/integration/otlp") || (u.hostname.includes("ingest.") && u.hostname.includes("sentry"));
  } catch {
    return false;
  }
}

/** Strip a trailing /v1/{signal} so a pasted full traces URL still works as a base. */
export function otlpBase(url: string): string {
  return url.replace(/\/$/, "").replace(/\/v1\/(traces|metrics|logs)$/i, "");
}

export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function headersAreBrowserSafe(headers: Record<string, string>): boolean {
  const keys = Object.keys(headers).map((k) => k.toLowerCase());
  if (keys.some((k) => k === "authorization" || k.startsWith("proxy-authorization"))) return false;
  return keys.every((k) => k === "x-sentry-auth");
}

export type ResolvedOtlp = {
  endpoint: string;
  tracesUrl: string;
  logsUrl: string;
  metricsUrl: string;
  headers: Record<string, string>;
  /** OTLP `/v1/metrics`. Always false for Sentry, which does not ingest OTLP metrics. */
  metrics: boolean;
  /**
   * Record metrics through the Sentry SDK (DSN) instead of OTLP.
   * Set when the exporter points at Sentry and metrics were not turned off.
   */
  sentryMetrics: boolean;
  sentry: boolean;
  serviceName: string;
};

/** Resolve OTLP endpoint/headers from OTEL_* env only. */
export function resolveOtlp(env: NodeJS.ProcessEnv = process.env): ResolvedOtlp {
  const serviceName = env.OTEL_SERVICE_NAME || "reelsaw";
  const endpoint = otlpBase(env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || "http://localhost:4318");
  const headers = parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
  const toSentry = isSentryOtlpUrl(endpoint);
  const metricsWanted = !["0", "false", "no", "off"].includes((env.OTEL_METRICS_ENABLED ?? "true").toLowerCase());
  return {
    endpoint,
    tracesUrl: `${endpoint}/v1/traces`,
    logsUrl: `${endpoint}/v1/logs`,
    metricsUrl: `${endpoint}/v1/metrics`,
    headers,
    // Sentry's OTLP ingest accepts traces and logs, not metrics. Metrics still requested
    // here go out through the Sentry SDK (see telemetry.ts).
    metrics: metricsWanted && !toSentry,
    sentryMetrics: toSentry && metricsWanted,
    sentry: toSentry,
    serviceName,
  };
}

/**
 * Fields the local log is meant to hold and an export must not: prompt and transcript bodies,
 * and the client address. Secrets are not listed here. pino redacts those by path before this
 * runs, and scrubOutboundText removes secret values wherever they sit.
 */
const LOCAL_ONLY_LOG_KEYS = new Set(["prompt", "response", "transcript", "words", "text", "content", "ip"]);
const SKIP_LINE_KEYS = new Set(["msg", "level", "time", "pid", "hostname", "v"]);

export type OtelLogRecord = {
  severityNumber: number;
  severityText: string;
  body: string;
  attributes: Record<string, string | number | boolean>;
};

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Error);
}

/**
 * One already-serialised pino line as an OTLP log. `scrub` is applied to every string that is
 * exported (the issue-report scrubber). Local-only bodies are removed whole, not scrubbed.
 */
export function otelLogFromLine(line: string, scrub: (value: string) => string = (s) => s): OtelLogRecord | null {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isPlain(row) || typeof row.msg !== "string" || !row.msg) return null;
  const level = typeof row.level === "number" ? row.level : 30;
  const attributes: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(row)) {
    if (SKIP_LINE_KEYS.has(k)) continue;
    addLogAttribute(attributes, k, v, scrub, 1);
  }
  const severity =
    level >= 60 ? { severityNumber: 21, severityText: "FATAL" }
    : level >= 50 ? { severityNumber: 17, severityText: "ERROR" }
    : level >= 40 ? { severityNumber: 13, severityText: "WARN" }
    : level >= 30 ? { severityNumber: 9, severityText: "INFO" }
    : level >= 20 ? { severityNumber: 5, severityText: "DEBUG" }
    : { severityNumber: 1, severityText: "TRACE" };
  return { ...severity, body: scrub(row.msg), attributes };
}

function addLogAttribute(out: Record<string, string | number | boolean>, key: string, value: unknown, scrub: (value: string) => string, depth: number): void {
  const leaf = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  if (!key || LOCAL_ONLY_LOG_KEYS.has(leaf)) return;
  const max = leaf === "stack" ? 2000 : 500;
  if (typeof value === "string") {
    out[key] = scrub(value.length > max ? value.slice(0, max) : value);
    return;
  }
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    out[key] = value;
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((x) => x == null || isScalar(x))) addLogAttribute(out, key, value.filter((x) => x != null).map(String).join(" "), scrub, 0);
    return;
  }
  if (depth > 0 && isPlain(value)) {
    for (const [ck, cv] of Object.entries(value)) addLogAttribute(out, `${key}.${ck}`, cv, scrub, depth - 1);
  }
}

/** Attribute bag for a Sentry span-duration metric. Drops non-scalars so a bad attribute cannot fail the span. */
export function spanMetricAttributes(name: string, ok: boolean, attributes: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = { span: name, status: ok ? "ok" : "error" };
  for (const [k, v] of Object.entries(attributes)) {
    if (typeof v === "string") out[k] = v.length > 200 ? v.slice(0, 200) : v;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function publicFromResolved(r: ResolvedOtlp): OtelPublic {
  if (!headersAreBrowserSafe(r.headers)) return null;
  return {
    endpoint: r.endpoint,
    headers: r.headers,
    metrics: r.metrics,
    serviceName: `${r.serviceName}-web`,
  };
}
