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
  metricsUrl: string;
  headers: Record<string, string>;
  metrics: boolean;
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
    metricsUrl: `${endpoint}/v1/metrics`,
    headers,
    // Sentry's OTLP ingest is traces-only
    metrics: metricsWanted && !toSentry,
    sentry: toSentry,
    serviceName,
  };
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
