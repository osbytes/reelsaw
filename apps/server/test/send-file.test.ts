/** Clip media is served at a URL that never changes, so a re-render must get past the browser's cache. */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sendFile } from "../src/send-file.js";

let dir: string;
let file: string;
before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "reelsaw-send-file-"));
  file = path.join(dir, "clip.mp4");
  await fsp.writeFile(file, "0123456789");
});
after(() => fsp.rm(dir, { recursive: true, force: true }));

const req = (headers: Record<string, string> = {}) => new Request("http://x/media/clips/p/c.mp4", { headers });

describe("sendFile", () => {
  it("tags the file with an ETag and Last-Modified and keeps the hour-long cache by default", async () => {
    const res = await sendFile(req(), file);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("etag")!, /^"[0-9a-f]+-[0-9a-f]+"$/);
    assert.ok(res.headers.get("last-modified"));
    assert.equal(res.headers.get("cache-control"), "private, max-age=3600");
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(await res.text(), "0123456789");
  });

  it("a clip that can change under its URL is marked no-cache, so the browser asks before replaying it", async () => {
    const res = await sendFile(req(), file, undefined, { revalidate: true });
    assert.equal(res.headers.get("cache-control"), "private, no-cache");
  });

  it("answers 304 to a matching If-None-Match and 200 to a stale one", async () => {
    const etag = (await sendFile(req(), file)).headers.get("etag")!;
    const same = await sendFile(req({ "if-none-match": etag }), file);
    assert.equal(same.status, 304);
    assert.equal(same.headers.get("etag"), etag);
    await fsp.writeFile(file, "0123456789abcdef");
    const changed = await sendFile(req({ "if-none-match": etag }), file);
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), etag);
  });

  it("serves a byte range, but a range conditional on another version sends the whole file", async () => {
    const etag = (await sendFile(req(), file)).headers.get("etag")!;
    const part = await sendFile(req({ range: "bytes=2-4", "if-range": etag }), file);
    assert.equal(part.status, 206);
    assert.equal(await part.text(), "234");
    const whole = await sendFile(req({ range: "bytes=2-4", "if-range": '"old-1"' }), file);
    assert.equal(whole.status, 200);
    assert.equal(await whole.text(), "0123456789abcdef");
  });
});
