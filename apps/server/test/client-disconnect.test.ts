/** A client that drops mid-upload is a warning ("upload aborted by the client"), not an error report (REELSAW-P). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isClientDisconnect } from "../src/lib/disconnect.js";

describe("isClientDisconnect", () => {
  it("is true for the error Node raises when an upload's socket closes mid-body", async () => {
    // a real server reading a body the client abandons halfway, the way /api/upload reads one
    let caught: unknown;
    const server = http.createServer(async (req, res) => {
      try {
        await pipeline(Readable.from(req), new Writable({ write: (_c, _e, cb) => cb() }));
      } catch (err) {
        caught = err;
      }
      res.end();
    });
    server.listen(0);
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    const req = http.request({ port, method: "POST", headers: { "content-length": "1000000" } });
    req.on("error", () => {});
    req.write(Buffer.alloc(1000));
    await new Promise((r) => setTimeout(r, 100));
    req.destroy();
    for (let i = 0; i < 50 && !caught; i++) await new Promise((r) => setTimeout(r, 20));
    server.close();
    assert.ok(caught instanceof Error, "the read failed");
    assert.equal(isClientDisconnect(caught), true, `${(caught as Error).message} / ${(caught as NodeJS.ErrnoException).code}`);
  });

  it("is true once the request's signal is aborted, whatever the error", () => {
    const ac = new AbortController();
    ac.abort();
    assert.equal(isClientDisconnect(new Error("anything"), ac.signal), true);
  });

  it("is false for our own failures", () => {
    assert.equal(isClientDisconnect(new Error("ENOSPC: no space left on device")), false);
    assert.equal(isClientDisconnect(Object.assign(new Error("write failed"), { code: "ENOSPC" })), false);
    assert.equal(isClientDisconnect("aborted"), false);
  });
});
