/**
 * EventSource that uses fetch, so the OpenTelemetry fetch instrumentation can add `traceparent`.
 * The browser EventSource API cannot set headers, which left live tRPC subscriptions on their own trace.
 * Reconnects the way EventSource does (including Last-Event-ID). A 4xx response stops.
 */
type Listener = (event: Event) => void;

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
  private retryMs = 3000;
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
      await this.sleep(this.retryMs);
    }
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
    // 4xx and 204 will not start working on a retry. A 5xx or a dropped connection will.
    if (res.status === 204 || (res.status >= 400 && res.status < 500)) {
      this.readyState = this.CLOSED;
      this.emit("error", "", this.lastId ?? "");
      return true;
    }
    if (!res.ok || !res.body) return false;
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
