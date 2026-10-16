// Recent client-side errors for issue reports: uncaught errors, unhandled rejections and
// console.error/warn, kept in a small ring buffer in memory (never sent anywhere on their own).
type Entry = { at: string; kind: string; message: string; stack?: string };
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
