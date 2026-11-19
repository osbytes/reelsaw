import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeDownloadFailure, ingestScratchMB, parseDownloadTick } from "../src/pipeline/ingest.js";
import { lineSplitter } from "../src/media.js";

describe("ingestScratchMB", () => {
  it("sizes an upload from its bytes instead of reserving 2 GB", () => {
    assert.equal(ingestScratchMB(80 * 1048576), 208);
    assert.equal(ingestScratchMB(2048 * 1048576), 2176);
    assert.equal(ingestScratchMB(1), 129);
  });
  it("reserves 2 GB when the size is unknown (a link)", () => {
    assert.equal(ingestScratchMB(), 2048);
    assert.equal(ingestScratchMB(null), 2048);
    assert.equal(ingestScratchMB(0), 2048);
  });
});

describe("parseDownloadTick", () => {
  it("reads a yt-dlp --newline progress line", () => {
    assert.deepEqual(parseDownloadTick("[download]  12.3% of ~ 1.57GiB at 5.00MiB/s ETA 04:00"), {
      fraction: 0.123,
      bytes: Math.round(1.57 * 1024 ** 3 * 0.123),
      message: "Downloading 12% of 1.57GiB at 5.00MiB/s",
    });
    assert.deepEqual(parseDownloadTick("[download] 100.0% of  114.74KiB at    5.98MiB/s ETA 00:00"), {
      fraction: 1,
      bytes: Math.round(114.74 * 1024),
      message: "Downloading 100% of 114.74KiB at 5.98MiB/s",
    });
    assert.deepEqual(parseDownloadTick("[download]   0.0% of   10.00MiB at  Unknown B/s ETA Unknown"), {
      fraction: 0,
      bytes: 0,
      message: "Downloading 0% of 10.00MiB",
    });
  });
  // ingest stops a download once `bytes` passes MAX_SOURCE_FILE_MB: a stream's recording has no size up front, so
  // --max-filesize cannot refuse it, and a day-long one ran for hours
  it("counts the bytes that have arrived, so ingest can stop a download that outgrows the limit", () => {
    const tick = parseDownloadTick("[download]  10.0% of ~  91.22GiB at 12.00MiB/s ETA 02:10:00 (frag 812/8121)");
    assert.ok(tick && tick.bytes !== null && tick.bytes > 8192 * 1024 * 1024, "9 GiB of a 91 GiB recording is past an 8 GB limit");
  });
  it("gives no bytes when the line has no total", () => {
    assert.equal(parseDownloadTick("[download]  42.0% at 1.00MiB/s")?.bytes, null);
    assert.equal(parseDownloadTick("[download]  42.0% of Unknown at 1.00MiB/s")?.bytes, null);
  });
  it("ignores everything else, including the --print-json line", () => {
    assert.equal(parseDownloadTick('{"id": "x", "title": "[download] 50%"}'), null);
    assert.equal(parseDownloadTick("[download] Destination: source.f137.mp4"), null);
    assert.equal(parseDownloadTick('[Merger] Merging formats into "source.mp4"'), null);
    assert.equal(parseDownloadTick(""), null);
  });
});

describe("describeDownloadFailure", () => {
  it("explains a proxy / tunnel rejection without env keys (admins get those in the UI)", () => {
    const err = new Error("Download failed");
    const stderr =
      "ERROR: [youtube] 9hSfOfgrL1I: Unable to download API page: <urlopen error Tunnel connection failed: 407 NO_USER> (caused by ProxyError('<urlopen error Tunnel connection failed: 407 NO_USER>')); please report this issue on https://github.com/yt-dlp/yt-dlp/issues?q=";
    const msg = describeDownloadFailure(err, stderr);
    assert.match(msg, /proxy blocked/i);
    assert.doesNotMatch(msg, /YTDLP_/);
    assert.doesNotMatch(msg, /please report this issue/i);
    assert.doesNotMatch(msg, /github\.com/);
  });
  it("explains a bot check / 403 without env keys", () => {
    const msg = describeDownloadFailure(new Error("x"), "ERROR: [youtube] Sign in to confirm you’re not a bot");
    assert.match(msg, /blocked the download/i);
    assert.match(msg, /uploading the file/i);
    assert.doesNotMatch(msg, /YTDLP_/);
  });
  it("keeps a short ERROR line without the github trailer", () => {
    const msg = describeDownloadFailure(
      new Error("x"),
      "ERROR: Something obscure broke; please report this issue on https://github.com/yt-dlp/yt-dlp/issues?q=",
    );
    assert.equal(msg, "Could not download: Something obscure broke");
  });
  it("says a page 404 / 410 is a dead link", () => {
    const stderr = "ERROR: [generic] zapier-logo: Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)";
    assert.match(describeDownloadFailure(new Error("x"), stderr), /link no longer exists/i);
  });
  it("does not call a 404 on the media URL, or one in a retry notice, a dead link", () => {
    assert.doesNotMatch(describeDownloadFailure(new Error("x"), "ERROR: unable to download video data: HTTP Error 404: Not Found"), /no longer exists/i);
    assert.doesNotMatch(
      describeDownloadFailure(new Error("x"), "[download] Got error: HTTP Error 404: Not Found. Retrying (1/10)...\nERROR: Connection reset by peer"),
      /no longer exists/i,
    );
  });
});

describe("lineSplitter", () => {
  it("emits complete lines across chunks, split on \\n or \\r", () => {
    const seen: string[] = [];
    const feed = lineSplitter((l) => seen.push(l));
    feed("[download]  1.0%\n[download]  2.");
    feed("0%\r[download]  3.0%\r\n");
    feed("tail");
    assert.deepEqual(seen, ["[download]  1.0%", "[download]  2.0%", "[download]  3.0%"]);
  });
  it("is a no-op without a listener", () => {
    assert.doesNotThrow(() => lineSplitter(undefined)("x\n"));
  });
});
