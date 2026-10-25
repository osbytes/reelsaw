import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(new URL("./hook.mjs", import.meta.url));

function hookRun(args, extra = {}) {
  return spawnSync(process.execPath, [hook, ...args], { encoding: "utf8", windowsHide: true, ...extra });
}

describe("hook.mjs optional", () => {
  it("exits 0 and explains when the binary is missing", () => {
    const r = hookRun(["optional", "reelsaw-not-a-binary-9f3a"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /not installed/i);
    assert.match(r.stdout, /reelsaw-not-a-binary-9f3a/);
  });

  it("forwards the exit code of a real binary", () => {
    const r = hookRun(["optional", process.execPath, "-e", "process.exit(3)"]);
    assert.equal(r.status, 3, r.stderr);
  });

  it("refuses optional without a binary name", () => {
    const r = hookRun(["optional"]);
    assert.equal(r.status, 2);
  });
});

describe("hook.mjs signoff", () => {
  it("refuses a missing commit file", () => {
    const r = hookRun(["signoff"]);
    assert.equal(r.status, 2);
  });
});
