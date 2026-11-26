/**
 * Fields that say why something went wrong, for cases the logs could not explain before: a slow request (event-loop
 * delay), a child killed by a signal (memory and the OOM killer's count), a Postgres connect timeout (the pool's counts).
 * node --import tsx --test test/diagnostics-fields.test.ts
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type pg from "pg";
import { recentLoopDelayMs, startLoopLagMonitor, stopLoopLagMonitor } from "../src/loop-lag.js";
import { memorySnapshot, oomKillCount } from "../src/memory-snapshot.js";
import { poolCounts } from "../src/db/index.js";
import { CommandError, createMediaTools } from "../src/media.js";
import type { Logger } from "../src/log.js";

describe("event-loop delay", () => {
  after(stopLoopLagMonitor);

  it("is undefined before the monitor starts, then reports a loop held by sync work", async () => {
    stopLoopLagMonitor();
    assert.equal(recentLoopDelayMs(), undefined);
    startLoopLagMonitor();
    await new Promise((r) => setTimeout(r, 60));
    const until = Date.now() + 250;
    while (Date.now() < until) {
      /* hold the loop */
    }
    await new Promise((r) => setTimeout(r, 60));
    const d = recentLoopDelayMs() ?? 0;
    assert.ok(d >= 150, `delay ${d} ms`);
  });
});

describe("memory snapshot", () => {
  it("reads cgroup v2 usage, limit, peak and the OOM killer's count", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reelsaw-cg-"));
    try {
      fs.writeFileSync(path.join(dir, "memory.current"), `${512 * 1048576}\n`);
      fs.writeFileSync(path.join(dir, "memory.max"), `${2048 * 1048576}\n`);
      fs.writeFileSync(path.join(dir, "memory.peak"), `${2047 * 1048576}\n`);
      fs.writeFileSync(path.join(dir, "memory.events"), "low 0\nhigh 0\nmax 12\noom 3\noom_kill 2\noom_group_kill 0\n");
      const m = await memorySnapshot(dir);
      assert.deepEqual([m.cgroupCurrentMB, m.cgroupMaxMB, m.cgroupPeakMB, m.oomKills], [512, 2048, 2047, 2]);
      assert.ok(m.rssMB > 0 && m.hostTotalMB > 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no limit and no cgroup leave the fields out", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reelsaw-cg-"));
    try {
      fs.writeFileSync(path.join(dir, "memory.max"), "max\n");
      const m = await memorySnapshot(dir);
      assert.equal(m.cgroupMaxMB, undefined);
      assert.equal(await oomKillCount(path.join(dir, "missing")), undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a child stopped by a signal", () => {
  const recorder = () => {
    const lines: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
    const at = (level: string) => (o: Record<string, unknown>, msg: string) => lines.push({ level, msg, fields: o });
    const log = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), child: () => log } as unknown as Logger;
    return { lines, log };
  };
  const config = { FFMPEG_ENCODER: "libx264", FFMPEG_PATH: "ffmpeg", YTDLP_PATH: "yt-dlp" } as never;

  it("logs the memory it was killed with", { skip: process.platform === "win32" ? "no POSIX signals on Windows" : false }, async () => {
    const { lines, log } = recorder();
    const media = createMediaTools(config, log);
    const err = await media.run(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]).catch((e: unknown) => e);
    assert.ok(err instanceof CommandError && err.signal === "SIGKILL");
    const warn = lines.find((l) => l.msg === "child process was stopped by a signal");
    assert.ok(warn, "warned");
    assert.equal(warn.fields["signal"], "SIGKILL");
    assert.ok(Number(warn.fields["rssMB"]) > 0);
  });

  it("our own cancel is not reported", async () => {
    const { lines, log } = recorder();
    const media = createMediaTools(config, log);
    const ac = new AbortController();
    const p = media.run(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { signal: ac.signal }).catch(() => {});
    setTimeout(() => ac.abort(), 100);
    await p;
    assert.equal(
      lines.find((l) => l.msg === "child process was stopped by a signal"),
      undefined,
    );
  });
});

describe("pool counts", () => {
  it("say whether a connect timeout found a full pool", () => {
    const pool = { totalCount: 10, idleCount: 0, waitingCount: 7, options: { max: 10 } } as unknown as pg.Pool;
    assert.deepEqual(poolCounts(pool), { poolTotal: 10, poolIdle: 0, poolWaiting: 7, poolMax: 10 });
  });
});
