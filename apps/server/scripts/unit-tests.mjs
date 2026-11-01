// Runs every test that needs no running stack or database: the files that import neither ./helpers.js
// (db() / signUp() / BASE need Postgres and the app) nor ./lifecycle-harness.js, pg or createServices
// (Postgres). With --stack it runs the other files instead (CI's `stack` workflow; `check` already
// runs the stack-free ones). `pnpm test` runs all of them against a local stack.
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const stack = process.argv.includes("--stack");
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "test");
const needsStack = (f) =>
  /from\s+["'](\.\/helpers|\.\/lifecycle-harness)(\.js)?["']|from\s+["']pg["']|createServices/.test(readFileSync(path.join(dir, f), "utf8"));
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => needsStack(f) === stack)
  .map((f) => path.join("test", f));
console.log(`${files.length} ${stack ? "stack" : "stack-free"} test files`);
// the stack files share one app and one Postgres: same concurrency as `pnpm test`
const args = ["--import", "tsx", "--test", ...(stack ? ["--test-concurrency=2"] : []), ...files];
const r = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
