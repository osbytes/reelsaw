/**
 * Pure units of the storage clean-up and S3 error handling. No stack needed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isS3NotFound } from "../src/storage/index.js";
import { orphanUploadFiles, UPLOAD_ABANDON_MS } from "../src/storage/uploads.js";
import { loadConfig } from "../src/config.js";

describe("isS3NotFound", () => {
  it("is true for a missing object and false for everything else", () => {
    assert.equal(isS3NotFound({ name: "NotFound" }), true);
    assert.equal(isS3NotFound({ name: "NoSuchKey" }), true);
    assert.equal(isS3NotFound({ name: "UnknownError", $metadata: { httpStatusCode: 404 } }), true);
    assert.equal(isS3NotFound({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } }), false);
    assert.equal(isS3NotFound(new Error("socket hang up")), false);
    assert.equal(isS3NotFound(null), false);
  });
});

describe("orphanUploadFiles", () => {
  const NOW = 1_800_000_000_000;
  const old = NOW - UPLOAD_ABANDON_MS - 1000;
  it("keeps files with a row and files younger than a day, removes the rest", () => {
    const files = [
      { name: "a.mp4", mtimeMs: old },
      { name: "b.mp4", mtimeMs: old },
      { name: "c.mp4", mtimeMs: NOW - 1000 },
      { name: "d.mp4.part", mtimeMs: old },
    ];
    assert.deepEqual(orphanUploadFiles(files, new Set(["a"]), NOW), ["b.mp4", "d.mp4.part"]);
  });
});

describe("S3 config limits", () => {
  const base = { DATABASE_URL: "postgres://x/y", BETTER_AUTH_SECRET: "x".repeat(40) };
  it("refuses a presign lifetime over the 7 day SigV4 maximum", () => {
    assert.throws(() => loadConfig({ ...base, S3_PRESIGN_EXPIRES: "604801" }), /604800/);
    assert.doesNotThrow(() => loadConfig({ ...base, S3_PRESIGN_EXPIRES: "604800" }));
  });
  it("requires S3_PUBLIC_URL to be a URL", () => {
    assert.throws(() => loadConfig({ ...base, S3_PUBLIC_URL: "cdn.example.com" }), /S3_PUBLIC_URL/);
  });
});
