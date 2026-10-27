/**
 * EventSource that uses fetch, so the OpenTelemetry fetch instrumentation can add `traceparent`.
 * The browser EventSource API cannot set headers, which left live tRPC subscriptions on their own trace.
 * Reconnects the way EventSource does (including Last-Event-ID), with exponential backoff and jitter
 * (1 s up to 30 s, reset when a connection opens). Only 401 and 403 (and 204) stop it; a 404, 429, other
 * 4xx or any 5xx is retried, since a deploy, a proxy or a rate limit clears on its own.
 */
type Listener = (event: Event) => void;

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

let onUnauthorized: () => void = () => {};
/** Called when the stream is refused with 401: the app refetches the session, which sends it to /login. */
export function setSseUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export class FetchEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = FetchEventSource.CONNECTING;

  private listeners = new Map<string, Set<Listener>>();
  private abort = new AbortController();
  private retryMs = 0; // a server `retry:` field raises the floor of the backoff
  private attempt = 0;
  private buf = "";
  private eventName = "message";
  private dataLines: string[] = [];
  private sawData = false;
  private lastId: string | undefined;
  private readonly withCredentials: boolean;

  constructor(url: string, init?: { withCredentials?: boolean; headers?: Record<string, string> }) {
    this.withCredentials = !!init?.withCredentials;
    void this.run(url, { ...(init?.headers ?? {}) });
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.abort.abort();
  }

  private emit(type: string, data: string, lastEventId: string): void {
    const ev = type === "error" ? new Event("error") : new MessageEvent(type, { data, lastEventId });
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  private async run(url: string, headers: Record<string, string>): Promise<void> {
    while (this.readyState !== this.CLOSED) {
      this.abort = new AbortController();
      this.readyState = this.CONNECTING;
      const stop = await this.connect(url, headers);
      if (stop || this.readyState === this.CLOSED) return;
      this.readyState = this.CONNECTING;
      this.emit("error", "", this.lastId ?? "");
      await this.sleep(this.nextDelay());
    }
  }

  private nextDelay(): number {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(this.attempt, 10));
    this.attempt++;
    return Math.max(this.retryMs, base * (0.5 + Math.random() * 0.5));
  }

  /** True when the connection must not be retried (closed, or the server refused it). */
  private async connect(url: string, headers: Record<string, string>): Promise<boolean> {
    this.buf = "";
    this.eventName = "message";
    this.dataLines = [];
    this.sawData = false;
    const h: Record<string, string> = { Accept: "text/event-stream", ...headers };
    if (this.lastId) h["Last-Event-ID"] = this.lastId;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        headers: h,
        credentials: this.withCredentials ? "include" : "same-origin",
        signal: this.abort.signal,
      });
    } catch {
      return this.readyState === this.CLOSED;
    }
    if (this.readyState === this.CLOSED) return true;
    // 204 (the server asks us to stop), 401 and 403 will not start working on a retry. Anything else will.
    if (res.status === 204 || res.status === 401 || res.status === 403) {
      this.readyState = this.CLOSED;
      this.emit("error", "", this.lastId ?? "");
      if (res.status === 401) onUnauthorized();
      return true;
    }
    if (!res.ok || !res.body) return false;
    this.attempt = 0;
    this.readyState = this.OPEN;
    this.emit("open", "", this.lastId ?? "");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (this.readyState !== this.CLOSED) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buf += decoder.decode(value, { stream: true });
        this.drain();
      }
    } catch {
      return this.readyState === this.CLOSED;
    }
    return this.readyState === this.CLOSED;
  }

  private drain(): void {
    for (;;) {
      const idx = this.buf.search(/\r\n|\n|\r/);
      if (idx < 0) return;
      const nl = this.buf.charCodeAt(idx) === 13 && this.buf.charCodeAt(idx + 1) === 10 ? 2 : 1;
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + nl);
      if (line === "") {
        this.dispatch();
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.eventName = value || "message";
      else if (field === "data") {
        this.dataLines.push(value);
        this.sawData = true;
      } else if (field === "id" && !value.includes("\0")) this.lastId = value;
      else if (field === "retry" && /^\d+$/.test(value)) this.retryMs = Number(value);
    }
  }

  private dispatch(): void {
    const name = this.eventName;
    const data = this.dataLines.join("\n");
    const id = this.lastId ?? "";
    this.eventName = "message";
    this.dataLines = [];
    const saw = this.sawData;
    this.sawData = false;
    if (saw) this.emit(name, data, id);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.abort.signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }
}
