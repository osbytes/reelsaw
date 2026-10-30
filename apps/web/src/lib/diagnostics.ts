// Recent client-side errors for issue reports: uncaught errors, unhandled rejections and
// console.error/warn, kept in a small ring buffer in memory (never sent anywhere on their own).
type Entry = { at: string; kind: string; message: string; stack?: string | undefined };
const MAX = 100;
const buf: Entry[] = [];

function push(kind: string, message: unknown, stack?: string) {
  const text = message instanceof Error ? message.message : typeof message === "string" ? message : safeJson(message);
  buf.push({ at: new Date().toISOString(), kind, message: text.slice(0, 4000), stack: (stack ?? (message instanceof Error ? message.stack : undefined))?.slice(0, 8000) });
  if (buf.length > MAX) buf.shift();
}

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

let sentAt: number[] = [];
/**
 * Record a caught error for issue reports and, with `send`, tell the server (POST /api/client-log, a
 * warn line with the user and route) so a problem seen in the browser shows up in the server logs.
 * At most 5 a minute from this tab; the server limits per user as well. Failures are swallowed.
 */
export function reportClientError(kind: "render" | "error" | "unhandledrejection" | "network", err: unknown, opts: { send?: boolean } = {}) {
  push(`app.${kind}`, err);
  if (!opts.send) return;
  const now = Date.now();
  sentAt = sentAt.filter((t) => now - t < 60_000);
  if (sentAt.length >= 5) return;
  sentAt.push(now);
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : safeJson(err);
  void fetch("/api/client-log", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, message: message.slice(0, 500), stack: err instanceof Error ? err.stack?.slice(0, 2048) : undefined, route: location.pathname }),
    keepalive: true,
  }).catch(() => {});
}

let installed = false;
export function installDiagnostics() {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (e) => push("error", e.error ?? e.message));
  window.addEventListener("unhandledrejection", (e) => push("rejection", e.reason));
  for (const level of ["error", "warn"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(`console.${level}`, args.map((a) => (a instanceof Error ? `${a.message}` : typeof a === "string" ? a : safeJson(a))).join(" "), args.find((a): a is Error => a instanceof Error)?.stack);
      orig(...args);
    };
  }
}

export function clientContext() {
  return {
    route: location.pathname + location.hash,
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    theme: document.documentElement.dataset.theme ?? "system",
    errors: buf.slice(),
  };
}
