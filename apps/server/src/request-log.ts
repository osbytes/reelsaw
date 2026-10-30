/**
 * Request logging for the Hono app: one line per request with its id, plus the id on the response so a
 * user-visible failure can be traced (`x-request-id` -> http line -> trpc error -> the job it started).
 *
 *  - `/api/*`: info (health at debug); 4xx that are not routine at warn; 5xx at error with `err`
 *  - `/media/*` and static files: debug, because a page load fetches dozens
 *  - tRPC failures are logged once, by `logTrpcError` (the access line stays at info)
 */
import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Logger } from "./log.js";

export type AppEnv = { Variables: { requestId: string; log: Logger; userId?: string } };

export const REQUEST_ID_HEADER = "x-request-id";

/** Keep a caller's request id when it looks like one (so a proxy's id flows through); else make one. */
export function resolveRequestId(incoming: string | null | undefined): string {
  return incoming && /^[\w.-]{8,64}$/.test(incoming) ? incoming : randomUUID();
}

type Level = "debug" | "info" | "warn" | "error";

/** A request slower than this is worth a warn; faster ones carry no duration (the http span has it). */
export const SLOW_REQUEST_MS = 2000;
// long by nature: media streams, the event subscription, uploads, and zip downloads
const STREAMING = /^\/(media\/|api\/upload|api\/trpc\/.*(subscription|events)|api\/projects\/[^/]+\/(export\.zip|report))/;

/** The level of the access line for a finished request. */
export function accessLevel(method: string, path: string, status: number, ms = 0): Level {
  if (status >= 500) return path.startsWith("/api/trpc/") ? "info" : "error"; // tRPC reports its own 5xx with the cause
  const api = path.startsWith("/api/");
  if (!api || method === "OPTIONS") return "debug";
  if (path === "/api/health") return "debug";
  if (status >= 400) {
    if (path.startsWith("/api/trpc/")) return "info"; // onError logs these at the right level
    return status === 401 || status === 404 ? "info" : "warn";
  }
  return ms >= SLOW_REQUEST_MS && !STREAMING.test(path) ? "warn" : "info";
}

export function requestLogger(root: Logger): MiddlewareHandler<AppEnv> {
  const httpLog = root.child({ module: "http" });
  return async (c, next) => {
    const t0 = performance.now();
    const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
    c.set("requestId", requestId);
    c.set("log", httpLog.child({ requestId }));
    c.header(REQUEST_ID_HEADER, requestId);
    await next();
    const path = redactPath(c.req.path);
    const status = c.res.status;
    const ms = Math.round(performance.now() - t0);
    const level = accessLevel(c.req.method, path, status, ms);
    // durations belong to the http span/metrics; the line carries one only when it is an anomaly
    const entry = { requestId, method: c.req.method, path, route: c.req.routePath, status, userId: c.get("userId"), ...(level === "warn" && status < 400 ? { ms } : {}) };
    if (c.error) httpLog.error({ ...entry, err: c.error }, "request failed");
    else httpLog[level](entry, status >= 500 ? "request failed" : level === "warn" && status < 400 ? "slow request" : "request");
  };
}

/** Reset and verification links carry their token in the path; the access log keeps the route, not the secret. */
export function redactPath(p: string): string {
  return p.replace(/(\/(?:reset-password|verify-email)\/)[^/]+/g, "$1…");
}

/** tRPC error code -> level: our bugs at error, forbidden/limits at warn, ordinary client mistakes at debug. */
export function trpcLogLevel(code: string): Level {
  switch (code) {
    case "BAD_REQUEST":
    case "NOT_FOUND":
    case "UNAUTHORIZED":
    case "PARSE_ERROR":
    case "METHOD_NOT_SUPPORTED":
    case "CLIENT_CLOSED_REQUEST":
      return "debug";
    case "FORBIDDEN":
    case "TOO_MANY_REQUESTS":
    case "CONFLICT":
    case "PRECONDITION_FAILED":
    case "PAYLOAD_TOO_LARGE":
    case "UNPROCESSABLE_CONTENT":
    case "TIMEOUT":
      return "warn";
    default:
      return "error"; // INTERNAL_SERVER_ERROR and anything unknown
  }
}

export function logTrpcError(log: Logger, e: { path?: string | undefined; type?: string; code: string; requestId?: string | undefined; userId?: string | undefined; err: Error }) {
  const level = trpcLogLevel(e.code);
  const fields = { procedure: e.path, type: e.type, code: e.code, requestId: e.requestId, userId: e.userId, ...(level === "error" ? { err: e.err } : { reason: e.err.message.slice(0, 300) }) };
  log[level](fields, "trpc error");
}
