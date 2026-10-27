import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
function portOf(s: http.Server): number {
  const a = s.address();
  if (!a || typeof a === "string") throw new Error("not listening");
  return a.port;
}
import { trackHttpServer } from "../src/http-shutdown.js";

test("close() ends an open SSE stream with a final comment and resolves", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: hi\n\n");
  });
  const closer = trackHttpServer(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = portOf(server);
  const body: string[] = [];
  const ended = new Promise<void>((resolve) => {
    http.get({ port, host: "127.0.0.1", headers: { accept: "text/event-stream" } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => body.push(c));
      res.on("end", resolve);
    });
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await closer.close(3000), true);
  await ended;
  assert.match(body.join(""), /: server shutting down/);
});

test("close() gives up at the cap when a plain request is still running", async () => {
  const server = http.createServer(() => {
    /* never answers */
  });
  const closer = trackHttpServer(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = portOf(server);
  const req = http.get({ port, host: "127.0.0.1" });
  req.on("error", () => {});
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(await closer.close(200), false);
  req.destroy();
  server.closeAllConnections();
});
