/**
 * A failed child process is a `CommandError` (media.ts), never a hand-built `new Error("ffmpeg exited …")`. The
 * hand-built ones printed "exited null" for a process killed from outside (the server out of memory, a stopped
 * job): a clip failed with "ffmpeg exited with null" and nothing to act on. CommandError names the signal
 * and leads with ffmpeg's own error lines. Scans the server for the hand-built spellings.
 * node --import tsx --test test/command-error-guard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CommandError } from "../src/media.js";

const src = path.join(import.meta.dirname, "..", "src");
const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.ts$/.test(e.name) ? [path.join(dir, e.name)] : []));
/** `new Error(` whose message reports a child's exit code itself */
const HAND_BUILT = /new Error\(`[^`]*(?:exited|\(\$\{code\}\)|failed \(\$\{code\}\))/;

describe("child process failures", () => {
  it("are CommandError everywhere", () => {
    const hits = files(src).flatMap((f) =>
      fs
        .readFileSync(f, "utf8")
        .split("\n")
        .flatMap((l, i) => (HAND_BUILT.test(l) ? [`${path.relative(src, f)}:${i + 1}: ${l.trim()}`] : [])),
    );
    assert.deepEqual(hits, [], "use new CommandError(bin, code, stderr, signal) from media.ts");
  });

  it("say which signal stopped a process instead of 'exited with null'", () => {
    const e = new CommandError("ffmpeg", null, "Error while decoding stream #0:1", "SIGKILL");
    assert.match(e.message, /^ffmpeg was stopped by SIGKILL \(usually the server running out of memory\)/);
    assert.doesNotMatch(e.message, /null/);
    assert.match(new CommandError("ffmpeg", 1, "").message, /^ffmpeg exited with 1/);
  });
});
