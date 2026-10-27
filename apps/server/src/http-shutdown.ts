/**
 * Closing the HTTP listener on SIGTERM. `server.close()` alone only stops accepting: it waits for
 * every open connection, and an SSE stream (project events) or a keep-alive socket never ends by
 * itself, so the call hangs for the whole shutdown grace. This ends the streams with a final comment
 * line (the browser's EventSource reconnects to the next instance), drops idle keep-alive sockets
 * and waits a bounded time for requests still running.
 */
import { Server, ServerResponse } from "node:http";

export interface HttpCloser {
  /** Stop accepting, end open SSE responses, close idle sockets; resolves `true` once closed, `false` at the cap. */
  close(timeoutMs: number): Promise<boolean>;
}

export function trackHttpServer(server: unknown): HttpCloser {
  const streams = new Set<ServerResponse>();
  if (!(server instanceof Server)) {
    // HTTP/2 (not used by the app's own listener): nothing to track, close() is plain server.close()
    return { close: async () => true };
  }
  server.on("request", (req, res) => {
    if (!String(req.headers.accept ?? "").includes("text/event-stream")) return;
    streams.add(res);
    res.once("close", () => streams.delete(res));
  });
  return {
    close(timeoutMs) {
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          resolve(true);
        });
        for (const res of streams) {
          if (res.writableEnded || res.destroyed) continue;
          try {
            res.write(": server shutting down\n\n");
            res.end();
          } catch {
            res.destroy();
          }
        }
        server.closeIdleConnections();
      });
    },
  };
}
