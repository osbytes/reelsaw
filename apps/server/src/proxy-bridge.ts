/**
 * A localhost HTTP proxy that tunnels every request over TLS to one HTTPS proxy, for ffmpeg.
 *
 * yt-dlp hands `--download-sections` to ffmpeg, and ffmpeg only honours a proxy whose URL starts with `http://`
 * (libavformat tls.c): with an `https://` proxy it silently connects straight to the media host. yt-dlp's own
 * requests still went through the proxy, so the media URL is signed for the proxy's exit IP and the direct fetch
 * from this server is refused. Giving yt-dlp this bridge instead keeps both on the same exit.
 *
 * Bound to 127.0.0.1 with a random credential, open for one yt-dlp process (`withFfmpegProxy` in ytdlp-proxy.ts).
 */
import { randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

interface ProxyBridge {
  /** `http://user:token@127.0.0.1:port`, for `--proxy` */
  url: string;
  close(): Promise<void>;
}

const MAX_HEAD_BYTES = 16 * 1024;
const HEAD_END = "\r\n\r\n";

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/** The request head up to the blank line, and whatever arrived after it; null when the client hung up or sent too much. */
function readHead(socket: net.Socket): Promise<{ head: string; rest: Buffer } | null> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const done = (v: { head: string; rest: Buffer } | null) => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.pause();
      resolve(v);
    };
    const onEnd = () => done(null);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const at = buf.indexOf(HEAD_END);
      if (at >= 0) return done({ head: buf.subarray(0, at).toString("latin1"), rest: buf.subarray(at + HEAD_END.length) });
      if (buf.length > MAX_HEAD_BYTES) done(null);
    };
    socket.on("data", onData);
    socket.on("end", onEnd);
  });
}

/**
 * Open a bridge to `upstream` (an `https://` proxy URL, userinfo percent-encoded as in any URL). `tlsOptions` is for
 * tests (a self-signed upstream); production uses the system trust store.
 */
export async function openProxyBridge(upstream: string, tlsOptions: tls.ConnectionOptions = {}): Promise<ProxyBridge> {
  const u = new URL(upstream);
  if (u.protocol !== "https:") throw new Error("openProxyBridge: the upstream must be an https:// proxy");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const port = Number(u.port || 443);
  const upstreamAuth = u.username || u.password ? basic(decodeURIComponent(u.username), decodeURIComponent(u.password)) : null;
  const token = randomBytes(16).toString("hex");
  const expected = basic("reelsaw", token);
  const open = new Set<net.Socket>();
  const track = (s: net.Socket) => {
    open.add(s);
    s.once("close", () => open.delete(s));
  };

  const server = net.createServer((client) => {
    track(client);
    client.on("error", () => client.destroy());
    void readHead(client).then((req) => {
      if (!req) {
        client.destroy();
        return;
      }
      const [requestLine = "", ...headers] = req.head.split("\r\n");
      const kept = headers.filter((h) => !/^(proxy-authorization|proxy-connection|connection):/i.test(h));
      const given = headers.find((h) => /^proxy-authorization:/i.test(h))?.replace(/^[^:]*:\s*/, "");
      if (given !== expected) {
        // ffmpeg asks without credentials first and answers the challenge on a new connection
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="reelsaw"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
      const isConnect = /^CONNECT\s/i.test(requestLine);
      // a plain-HTTP request carries its credential per request: one request per connection keeps every one authorised
      const head = [requestLine, ...kept, ...(upstreamAuth ? [`Proxy-Authorization: ${upstreamAuth}`] : []), ...(isConnect ? [] : ["Connection: close"])];
      const up = tls.connect({ host, port, ...(net.isIP(host) ? {} : { servername: host }), ...tlsOptions });
      track(up);
      up.once("secureConnect", () => {
        up.write(head.join("\r\n") + HEAD_END);
        if (req.rest.length) up.write(req.rest);
        client.pipe(up);
        up.pipe(client);
        client.resume();
      });
      up.on("error", (err: NodeJS.ErrnoException) => {
        // before the tunnel: say why in the words the error classifier reads as a path fault
        if (!client.destroyed && client.bytesWritten === 0) {
          client.end(
            `HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\nX-Reelsaw-Proxy-Bridge: unable to connect to proxy (${err.code ?? "error"})\r\n\r\n`,
          );
        } else client.destroy();
      });
      up.on("close", () => client.destroy());
      client.on("close", () => up.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port: local } = server.address() as net.AddressInfo;
  return {
    url: `http://reelsaw:${token}@127.0.0.1:${local}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of open) s.destroy();
        server.close(() => resolve());
      }),
  };
}
