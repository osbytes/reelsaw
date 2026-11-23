/**
 * `--download-sections` is fetched by ffmpeg, which honours only `http://` proxies: with an `https://` YTDLP_PROXY it
 * went straight to the media host from this server's IP while yt-dlp had resolved the URL through the proxy, so every
 * range download was refused. Sections now leave through the same exit as yt-dlp (a localhost bridge for https), every
 * caller gets that from its arguments, and ffmpeg's refusal reads as a path fault.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { createMediaTools } from "../src/media.js";
import { createLogger } from "../src/log.js";
import type { Config } from "../src/config.js";
import { openProxyBridge } from "../src/proxy-bridge.js";
import { NoEligibleProxyError, classifyYtdlpError, ffmpegCanUse, withFfmpegProxy } from "../src/ytdlp-proxy.js";
import { describeDownloadFailure } from "../src/pipeline/ingest.js";

const log = createLogger({ LOG_LEVEL: "error", LOG_FORMAT: "json" });

/** A self-signed certificate for 127.0.0.1, made per run (no key in the repository); null without openssl. */
function selfSigned(): { key: string; cert: string } | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reelsaw-cert-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        "k.pem",
        "-out",
        "c.pem",
      ],
      { cwd: dir, stdio: "ignore", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
    );
    return { key: fs.readFileSync(path.join(dir, "k.pem"), "utf8"), cert: fs.readFileSync(path.join(dir, "c.pem"), "utf8") };
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
}

/** Send one CONNECT through `proxyUrl` to `target`, then `payload`; resolves with the status line and what came back. */
function connectThrough(proxyUrl: string, target: string, payload: string, withAuth = true): Promise<{ status: string; body: string }> {
  const u = new URL(proxyUrl);
  const auth = withAuth && u.username ? `Proxy-Authorization: Basic ${Buffer.from(`${u.username}:${u.password}`).toString("base64")}\r\n` : "";
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(u.port), u.hostname, () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`));
    let buf = "";
    let sent = false;
    s.setEncoding("latin1");
    s.on("data", (d: string) => {
      buf += d;
      const at = buf.indexOf("\r\n\r\n");
      if (at < 0) return;
      const status = buf.slice(0, buf.indexOf("\r\n"));
      if (!status.includes(" 200")) {
        s.destroy();
        return resolve({ status, body: "" });
      }
      if (!sent) {
        sent = true;
        s.write(payload);
      }
      const body = buf.slice(at + 4);
      if (body.length >= payload.length) {
        s.destroy();
        resolve({ status, body });
      }
    });
    s.on("error", reject);
  });
}

describe("section downloads go through the same exit as yt-dlp", () => {
  it("ffmpeg can be given direct, http:// and https:// (bridged) candidates, never SOCKS", () => {
    assert.equal(ffmpegCanUse({ url: null }), true);
    assert.equal(ffmpegCanUse({ url: "http://u:p@gw.example:823" }), true);
    assert.equal(ffmpegCanUse({ url: "https://u:p@proxy.example:443" }), true);
    assert.equal(ffmpegCanUse({ url: "socks5h://pi.lan:1080" }), false);
  });

  it("withFfmpegProxy passes http:// and direct through, refuses SOCKS, and bridges https:// for the call only", async () => {
    assert.equal(await withFfmpegProxy(null, async (p) => p), null);
    assert.equal(await withFfmpegProxy("http://u:p@gw.example:823", async (p) => p), "http://u:p@gw.example:823");
    await assert.rejects(
      withFfmpegProxy("socks5h://pi.lan:1080", async (p) => p),
      NoEligibleProxyError,
    );
    const bridged = (await withFfmpegProxy("https://u:p@proxy.example:443", async (p) => p)) ?? "";
    assert.match(bridged, /^http:\/\/reelsaw:[0-9a-f]+@127\.0\.0\.1:\d+$/);
    // closed once the call returned
    await assert.rejects(
      new Promise((resolve, reject) => {
        const s = net.connect(Number(new URL(bridged).port), "127.0.0.1", () => resolve(s.destroy()));
        s.on("error", reject);
      }),
    );
  });

  it("ffmpeg turned away by the media host is a path fault, and the user is told the site refused it", () => {
    const text = `yt-dlp exited with 1: [https @ 0x1] HTTP error 403 Forbidden\nError opening input: Server returned 403 Forbidden (access denied)\nERROR: ffmpeg exited with code 1`;
    assert.equal(classifyYtdlpError(text), "proxy");
    const bare = "Error opening input: Server returned 403 Forbidden (access denied)\nERROR: ffmpeg exited with code 1";
    assert.equal(classifyYtdlpError(bare), "proxy");
    assert.match(describeDownloadFailure(new Error("yt-dlp exited with 1"), bare), /the site blocked the download/);
  });
});

describe("https proxy bridge", () => {
  const cert = selfSigned();
  const skip = cert ? false : "needs openssl for a test certificate";
  let echoPort = 0;
  let upstreamPort = 0;
  const seenAuth: string[] = [];
  const echo = net.createServer((s) => s.pipe(s));
  // an HTTPS proxy that wants Basic auth and tunnels CONNECT, like a Caddy forward proxy
  const upstream = cert
    ? tls.createServer(cert, (c) => {
        let head = "";
        c.setEncoding("latin1");
        const onData = (d: string) => {
          head += d;
          const at = head.indexOf("\r\n\r\n");
          if (at < 0) return;
          c.off("data", onData);
          const auth = /^proxy-authorization:\s*(.*)$/im.exec(head.slice(0, at))?.[1]?.trim() ?? "";
          seenAuth.push(auth);
          if (auth !== `Basic ${Buffer.from("user:p@ss:w%rd").toString("base64")}`) return void c.end("HTTP/1.1 407 No\r\nContent-Length: 0\r\n\r\n");
          const [h = "", p = ""] = (head.split(" ")[1] ?? "").split(":");
          const t = net.connect(Number(p), h, () => {
            c.write("HTTP/1.1 200 Connection established\r\n\r\n");
            const rest = head.slice(at + 4);
            if (rest) t.write(rest, "latin1");
            c.pipe(t).pipe(c);
          });
          t.on("error", () => c.destroy());
        };
        c.on("data", onData);
      })
    : null;

  before(async () => {
    if (!upstream) return;
    echoPort = await listen(echo);
    upstreamPort = await listen(upstream);
  });
  after(() => {
    echo.close();
    upstream?.close();
  });

  it("tunnels a CONNECT over TLS with the upstream's percent-encoded credentials", { skip }, async () => {
    const bridge = await openProxyBridge(`https://user:${encodeURIComponent("p@ss:w%rd")}@127.0.0.1:${upstreamPort}`, { ca: cert?.cert });
    try {
      const got = await connectThrough(bridge.url, `127.0.0.1:${echoPort}`, "hello through the bridge");
      assert.match(got.status, / 200 /);
      assert.equal(got.body, "hello through the bridge");
      assert.equal(seenAuth.at(-1), `Basic ${Buffer.from("user:p@ss:w%rd").toString("base64")}`);
    } finally {
      await bridge.close();
    }
  });

  it("answers 407 to a client without the bridge's own credential (ffmpeg then retries with it)", { skip }, async () => {
    const bridge = await openProxyBridge(`https://user:x@127.0.0.1:${upstreamPort}`, { ca: cert?.cert });
    try {
      const before = seenAuth.length;
      const got = await connectThrough(bridge.url, `127.0.0.1:${echoPort}`, "x", false);
      assert.match(got.status, / 407 /);
      assert.equal(seenAuth.length, before, "nothing reached the upstream");
    } finally {
      await bridge.close();
    }
  });

  it("reports an unreachable upstream in words the classifier reads as a proxy fault", { skip }, async () => {
    const dead = net.createServer();
    const port = await listen(dead);
    dead.close();
    const bridge = await openProxyBridge(`https://u:p@127.0.0.1:${port}`);
    try {
      const got = await connectThrough(bridge.url, `127.0.0.1:${echoPort}`, "x");
      assert.match(got.status, / 502 /);
    } finally {
      await bridge.close();
    }
  });
});

describe("media.ytdlp picks the proxy for ffmpeg whenever the arguments ask for sections", {
  skip: process.platform === "win32" ? "needs a POSIX shell" : false,
}, () => {
  // a stand-in yt-dlp that records the arguments it was given
  function fakeYtdlp(): { bin: string; argsFile: string; out: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reelsaw-sections-"));
    const bin = path.join(dir, "fake-ytdlp.sh");
    const argsFile = path.join(dir, "args.txt");
    const out = path.join(dir, "out");
    fs.mkdirSync(out);
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n`, { mode: 0o755 });
    return { bin, argsFile, out };
  }
  const pool = "sock=socks5h://s.example:1080;priority=30,pi=https://u:p@proxy.example:443;priority=20";

  it("a section download skips SOCKS and hands yt-dlp a localhost bridge for the https proxy", async () => {
    const f = fakeYtdlp();
    const media = createMediaTools({ YTDLP_PATH: f.bin, YTDLP_PROXY: pool } as Config, log);
    const r = await media.ytdlp(["--download-sections", "*10-20", "--", "https://example.com/v"], { download: { dir: f.out, maxFileBytes: 1 << 20 } });
    assert.equal(r.proxyId, "pi");
    const args = fs.readFileSync(f.argsFile, "utf8").split("\n");
    assert.match(args[args.indexOf("--proxy") + 1] ?? "", /^http:\/\/reelsaw:[0-9a-f]+@127\.0\.0\.1:\d+$/);
  });

  it("a whole-video download still uses the top candidate as it is", async () => {
    const f = fakeYtdlp();
    const media = createMediaTools({ YTDLP_PATH: f.bin, YTDLP_PROXY: pool } as Config, log);
    const r = await media.ytdlp(["--", "https://example.com/v"], { download: { dir: f.out, maxFileBytes: 1 << 20 } });
    assert.equal(r.proxyId, "sock");
    const args = fs.readFileSync(f.argsFile, "utf8").split("\n");
    assert.equal(args[args.indexOf("--proxy") + 1], "socks5h://s.example:1080");
  });
});
