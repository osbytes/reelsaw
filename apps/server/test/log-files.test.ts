import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logFileFor, logFiles, readLogLines } from "../src/log-read.js";

test("logFileFor puts a sanitised worker id before the extension", () => {
  assert.equal(logFileFor("/data/logs/reelsaw.log", "abc123:42"), "/data/logs/reelsaw.abc123_42.log");
  assert.equal(logFileFor("/data/logs/reelsaw.log", "worker-1.a"), "/data/logs/reelsaw.worker-1.a.log");
  assert.equal(logFileFor("/data/logs/reelsaw", "w1"), "/data/logs/reelsaw.w1");
});

test("readLogLines merges every process's files by timestamp", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reelsaw-logs-"));
  try {
    const line = (time: string, msg: string) => JSON.stringify({ level: 30, time, msg, projectId: "p1" });
    fs.writeFileSync(path.join(dir, "reelsaw.app_1.2026-10-26.1.log"), [line("2026-10-26T10:00:00.000Z", "a1"), line("2026-10-26T10:00:04.000Z", "a2")].join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "reelsaw.worker_9.2026-10-26.1.log"), [line("2026-10-26T10:00:02.000Z", "w1"), line("2026-10-26T10:00:06.000Z", "w2")].join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "other.log"), line("2026-10-26T09:00:00.000Z", "unrelated") + "\n");
    const file = path.join(dir, "reelsaw.log");
    assert.equal((await logFiles(file)).length, 2);
    const { lines } = await readLogLines(file, { ids: ["p1"] });
    assert.deepEqual(lines.map((l) => (JSON.parse(l) as { msg: string }).msg), ["a1", "w1", "a2", "w2"]);
    const last = await readLogLines(file, { ids: ["p1"], limit: 2 });
    assert.deepEqual(last.lines.map((l) => (JSON.parse(l) as { msg: string }).msg), ["a2", "w2"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
