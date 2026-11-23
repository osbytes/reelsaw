/**
 * Every yt-dlp download is bounded by the files it writes, not by the size the server announces: a link that streams
 * with no length (chunked, no Content-Length) gives yt-dlp no total, so --max-filesize and the progress-line check
 * never fire and the file grows until the disk is full.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DownloadTooLargeError, createMediaTools, largestFileBytes } from "../src/media.js";
import { createLogger } from "../src/log.js";
import type { Config } from "../src/config.js";

const log = createLogger({ LOG_LEVEL: "error", LOG_FORMAT: "json" });

describe("yt-dlp download bound", () => {
  it("measures the largest file in a folder, and a missing folder as empty", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reelsaw-bound-"));
    fs.writeFileSync(path.join(dir, "a.part"), Buffer.alloc(300));
    fs.writeFileSync(path.join(dir, "b.mp4"), Buffer.alloc(100));
    assert.equal(await largestFileBytes(dir), 300);
    assert.equal(await largestFileBytes(path.join(dir, "missing")), 0);
  });

  it("refuses a lookup marked as no download that would download", async () => {
    const media = createMediaTools({ YTDLP_PATH: "yt-dlp" } as Config, log);
    await assert.rejects(media.ytdlp(["--", "https://example.com/v"], { download: "none" }), /--no-download/);
  });

  // a stand-in yt-dlp that writes without end, the way a chunked endless response does (a shell script: POSIX only)
  it("stops a download whose file grows past the limit", { skip: process.platform === "win32" ? "needs a POSIX shell" : false }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reelsaw-bound-"));
    const fake = path.join(dir, "fake-ytdlp.sh");
    const out = path.join(dir, "out");
    fs.mkdirSync(out);
    const writer = `const fs=require("fs");const f=fs.openSync(process.argv[1]+"/source.mp4.part","w");const b=Buffer.alloc(1<<20);setInterval(()=>fs.writeSync(f,b),5)`;
    fs.writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" -e '${writer}' "${out}"\n`, { mode: 0o755 });
    const media = createMediaTools({ YTDLP_PATH: fake } as Config, log);
    const started = Date.now();
    await assert.rejects(media.ytdlp(["--", "https://example.com/endless"], { download: { dir: out, maxFileBytes: 4 * 1024 * 1024 } }), DownloadTooLargeError);
    assert.ok(Date.now() - started < 15_000, "the download should stop within a few polls");
  });
});
