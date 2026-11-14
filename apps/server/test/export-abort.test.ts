import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createExportZip, type ExportInput } from "../src/export.js";
import type { Storage } from "../src/storage/index.js";
import type { Paths } from "../src/config.js";
import type { Clip } from "../src/db/schema.js";

const clip = (i: number) =>
  ({
    id: `c${i}`,
    index: i,
    status: "done",
    outputKey: `clips/c${i}.mp4`,
    thumbnailKey: null,
    title: `Clip ${i}`,
    hook: "",
    caption: "",
    hashtags: [],
    startSec: i * 10,
    endSec: i * 10 + 5,
    score: 1,
  }) as unknown as Clip;

/** A remote store (resolve gives a URL, so every clip is pulled into the export's temp folder), slow enough to abort mid-pull. */
function remoteStore(pulls: string[]): Storage {
  return {
    driver: "s3",
    resolve: async () => ({ url: "https://store.invalid/x" }),
    ensureLocal: async (key: string, localPath: string) => {
      pulls.push(key);
      await sleep(40);
      await fsp.mkdir(path.dirname(localPath), { recursive: true });
      await fsp.writeFile(localPath, Buffer.alloc(1024));
      return localPath;
    },
  } as unknown as Storage;
}

/** Cleanup is fire-and-forget after the stream settles: wait for the folder to empty (bounded), then return what is left. */
async function settledTmp(dir: string): Promise<string[]> {
  for (let i = 0; i < 50; i++) {
    const left = await fsp.readdir(dir);
    if (left.length === 0) return left;
    await sleep(40);
  }
  return fsp.readdir(dir);
}

const logs = () => {
  const lines: Array<{ level: string; msg: string }> = [];
  const log = {
    child: () => log,
    info: (_: unknown, msg: string) => lines.push({ level: "info", msg }),
    warn: (_: unknown, msg: string) => lines.push({ level: "warn", msg }),
    debug: (_: unknown, msg: string) => lines.push({ level: "debug", msg }),
  };
  return { lines, log: log as never };
};

test("createExportZip: a reader that goes away stops the pulls and leaves no temp files", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "reelsaw-export-abort-"));
  try {
    const pulls: string[] = [];
    const { lines, log } = logs();
    const input: ExportInput = {
      project: { id: "p1", title: "Talk", sourceType: "upload", sourceUrl: null, sourceMeta: null, durationSec: 100, settings: {} } as never,
      clips: [0, 1, 2, 3, 4, 5].map(clip),
      language: null,
    };
    const { stream } = await createExportZip({ storage: remoteStore(pulls), paths: { tmp } as Paths, log }, input);
    // what Readable.toWeb does when the browser drops the download: destroy the node stream with an AbortError
    await new Promise<void>((resolve) => stream.once("data", () => resolve()));
    stream.destroy(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
    const left = await settledTmp(tmp);
    await sleep(200); // long enough for further pulls to start if the loop kept going
    assert.ok(pulls.length <= 2, `pulled ${pulls.length} of 6 clips after the reader left`);
    assert.deepEqual(left, [], "the export's temp folder is gone");
    assert.deepEqual(await fsp.readdir(tmp), [], "and no later pull recreated it");
    assert.ok(!lines.some((l) => l.level === "warn"), `no warning for a cancelled download: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => l.msg === "export cancelled"));
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("createExportZip: a complete read still sends every clip and cleans up", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "reelsaw-export-full-"));
  try {
    const pulls: string[] = [];
    const { lines, log } = logs();
    const input: ExportInput = {
      project: { id: "p1", title: "Talk", sourceType: "upload", sourceUrl: null, sourceMeta: null, durationSec: 100, settings: {} } as never,
      clips: [0, 1, 2].map(clip),
      language: null,
    };
    const { stream } = await createExportZip({ storage: remoteStore(pulls), paths: { tmp } as Paths, log }, input);
    let bytes = 0;
    for await (const chunk of stream) bytes += (chunk as Buffer).length;
    assert.equal(pulls.length, 3);
    assert.ok(bytes > 3 * 1024);
    assert.deepEqual(await settledTmp(tmp), []);
    assert.ok(lines.some((l) => l.msg === "export sent"));
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});
