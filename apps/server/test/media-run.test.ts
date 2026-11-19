/** runRaw: a child's output can never grow a string without bound (that crashed the whole process, HTTP included). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OutputTooLargeError, lineSplitter, runRaw } from "../src/media.js";

const node = process.execPath;
// writes `n` progress lines, then the info JSON, the way yt-dlp --progress --newline --print-json does
const ytdlpLike = (n: number) =>
  `for (let i = 0; i < ${n}; i++) process.stdout.write("[download]  " + (i / ${n} * 100).toFixed(1) + "% of 10.00MiB\\n"); process.stdout.write(JSON.stringify({ title: "t" }) + "\\n");`;

describe("runRaw", () => {
  it("a caller reading lines gets every line and no buffered stdout, however much is written", async () => {
    let lines = 0;
    let json: string | undefined;
    const res = await runRaw(node, ["-e", ytdlpLike(20_000)], {
      maxStdoutBytes: 64 * 1024, // far below what the child writes: line readers are not subject to it
      onStdout: (l) => {
        lines++;
        if (l.startsWith("{")) json = l;
      },
    });
    assert.equal(res.stdout, "");
    assert.equal(lines, 20_001);
    assert.deepEqual(JSON.parse(json!), { title: "t" });
  });

  it("past the cap, buffered stdout rejects the run and stops the child instead of throwing", async () => {
    await assert.rejects(
      runRaw(node, ["-e", "setInterval(() => process.stdout.write('x'.repeat(65536)), 1)"], { maxStdoutBytes: 1024 * 1024 }),
      OutputTooLargeError,
    );
  });

  it("an onStdout that throws rejects the run rather than escaping as an uncaught exception", async () => {
    await assert.rejects(
      runRaw(node, ["-e", "process.stdout.write('a\\nb\\n')"], {
        onStdout: () => {
          throw new Error("boom");
        },
      }),
      /boom/,
    );
  });

  it("small stdout is returned whole", async () => {
    const res = await runRaw(node, ["-e", "process.stdout.write('{\"a\":1}')"]);
    assert.equal(res.stdout, '{"a":1}');
  });

  it("decodes a multibyte character split across chunks", async () => {
    // the 2-byte "é" straddles the two writes
    const res = await runRaw(node, [
      "-e",
      "const b = Buffer.from('xé'); process.stdout.write(b.subarray(0, 2)); setTimeout(() => process.stdout.write(b.subarray(2)), 50);",
    ]);
    assert.equal(res.stdout, "xé");
  });
});

describe("lineSplitter", () => {
  it("a \r\n split across chunks is one break, not an empty line", () => {
    const seen: string[] = [];
    const feed = lineSplitter((l) => seen.push(l));
    feed("a\r");
    feed("\nb\n");
    assert.deepEqual(seen, ["a", "b"]);
  });

  it("drops a line that outgrows the limit, tail included, then carries on", () => {
    const seen: string[] = [];
    const feed = lineSplitter((l) => seen.push(l), 8);
    feed("ok\n{1234567");
    feed("890abcdef");
    feed("ghij\nnext\n");
    assert.deepEqual(seen, ["ok", "next"]);
  });
});
